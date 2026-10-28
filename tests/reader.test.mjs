import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, open, readdir, symlink, mkdir, mkdtemp, realpath, lstat, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readSnapshot } from '../src/reader.js';
import { DashboardError, hasSensitiveContent, sanitizeText } from '../src/safety.js';
import { createReaderFixture, fixtureId, fixtureFileBaseline, updateFixtureWork } from './reader-fixture.mjs';

/** 建立本测试独占的临时夹具，结束后只关闭/删除它自己的目录。 */
async function fixtureFor(t, options) {
  const fixture = await createReaderFixture(options);
  t.after(() => fixture.dispose());
  return fixture;
}

/** 源文件或注入时刻不变数据库 size。要强制重新捕获时，只把 state.db 的 mtime 向前拨 1 秒。 */
async function bumpDatabaseStamp(root) {
  const filename = path.join(root, '.awr', 'state.db');
  const info = await lstat(filename);
  const next = new Date(Number(info.mtimeMs) + 1000);
  await utimes(filename, next, next);
}

/** 以安全工作键查节点，测试不用数组顺序猜节点身份。 */
function node(snapshot, key) {
  const value = snapshot.nodes.find((item) => item.key === key);
  assert.ok(value, `Expected fixture node ${key}`);
  return value;
}

/** 定向检查固定诊断码，不依赖说明文案或私有载荷。 */
function codes(work) {
  return work.diagnostics.map((diagnostic) => diagnostic.code);
}

/** 捕获指定安全错误且不将来源正文/原始异常作为通过条件。 */
function errorCode(code, retryable) {
  return (error) => error instanceof DashboardError && error.code === code
    && (retryable === undefined || error.retryable === retryable);
}

test('完整共享契约、载荷优先及所有字段可序列化', async (t) => {
  const fixture = await fixtureFor(t, { works: [{ key: 'A', status: 'ready', columnStatus: 'blocked', columnTitle: 'Wrong convenience column' }] });
  const snapshot = await readSnapshot(fixture.root, { now: 1000 });
  assert.deepEqual(Object.keys(snapshot).sort(), ['version', 'project', 'revision', 'sourceFingerprint', 'updatedAt', 'evaluatedAt', 'readOnly', 'mode', 'sources', 'nodes', 'edges', 'counts', 'diagnostics', 'lanes'].sort());
  assert.equal(snapshot.evaluatedAt, 1000);
  assert.equal(snapshot.mode, 'live');
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.project.schemaVersion, 7);
  assert.equal(node(snapshot, 'A').title, 'Fixture A');
  assert.equal(node(snapshot, 'A').status, 'pending');
  assert.equal(node(snapshot, 'A').ready, true);
  assert.equal(node(snapshot, 'A').archived, false);
  assert.equal(node(snapshot, 'A').owner, null);
  assert.equal(JSON.stringify(snapshot).includes('undefined'), false);
  assert.equal(JSON.stringify(snapshot).includes('adapter_options'), false);
});

test('WAL 最新提交可读且原 DB/WAL/SHM/全目录字节与元数据不变', async (t) => {
  const fixture = await fixtureFor(t, { wal: true });
  updateFixtureWork(fixture, 'A', { status: 'completed', raw_status: 'completed', title: 'Committed only in WAL' });
  const before = await fixtureFileBaseline(fixture.root);
  assert.ok(before.some((file) => file.path.endsWith('state.db-wal') && Number(file.size) > 0));
  assert.ok(before.some((file) => file.path.endsWith('state.db-shm')));
  const snapshot = await readSnapshot(fixture.root, { now: 1234 });
  assert.equal(node(snapshot, 'A').title, 'Committed only in WAL');
  assert.equal(node(snapshot, 'A').status, 'completed');
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
});

test('副本成功和 schema 失败后都清理本轮临时目录，不动其他目录', async (t) => {
  const fixture = await fixtureFor(t);
  // 夹具先建立；副本基目录是项目外独占目录，不枚举其他并行测试的全局临时目录。
  const tempBase = await realpath(os.tmpdir());
  const copyBase = await mkdtemp(path.join(tempBase, 'awr-dashboard-cleanup-test-'));
  t.after(async () => {
    if (path.dirname(copyBase) !== tempBase || !path.basename(copyBase).startsWith('awr-dashboard-cleanup-test-')) throw new Error('Invalid test cleanup target');
    await rm(copyBase, { recursive: true, force: true });
  });
  assert.equal(path.dirname(fixture.root), tempBase);
  const sentinelDirectory = path.join(copyBase, 'unrelated');
  await mkdir(sentinelDirectory);
  await writeFile(path.join(sentinelDirectory, 'keep.txt'), 'Unrelated dedicated test sentinel\n');
  const before = await fixtureFileBaseline(copyBase);
  for (const schemaFailure of [false, true]) {
    if (schemaFailure) fixture.db.exec('PRAGMA user_version=8;');
    const mock = t.mock.method(os, 'tmpdir', () => copyBase);
    try {
      if (schemaFailure) await assert.rejects(readSnapshot(fixture.root), errorCode('UNSUPPORTED_SCHEMA', false));
      else await readSnapshot(fixture.root);
    } finally {
      // 仅查询期间替换临时目录提供者；不改变全局环境或后续夹具的创建位置。
      mock.mock.restore();
    }
    // 自有副本应清空；无关哨兵目录、正文和纳秒元数据必须保留。
    assert.deepEqual(await fixtureFileBaseline(copyBase), before);
  }
});

test('副本临时基目录等于项目根或位于其内部时拒绝且项目不变', async (t) => {
  // 夹具先在正常的项目外临时基目录中创建，仅查询阶段模拟不安全的基目录。
  const tempBase = await realpath(os.tmpdir());
  const fixture = await fixtureFor(t);
  assert.equal(path.dirname(fixture.root), tempBase);
  const nestedBase = path.join(fixture.root, 'copy-target');
  await mkdir(nestedBase);
  const before = await fixtureFileBaseline(fixture.root);
  const rootBefore = await lstat(fixture.root, { bigint: true });
  for (const unsafeBase of [fixture.root, nestedBase]) {
    const mock = t.mock.method(os, 'tmpdir', () => unsafeBase);
    try {
      await assert.rejects(readSnapshot(fixture.root), errorCode('UNSAFE_PATH', false));
      assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
      const rootAfter = await lstat(fixture.root, { bigint: true });
      // 根目录的元数据也必须不变，不能只验证创建后又删除的副本已消失。
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(rootAfter[key], rootBefore[key]);
    } finally {
      mock.mock.restore();
    }
  }
});

test('项目外临时路径经符号链接指向项目内时按真实路径拒绝', async (t) => {
  const tempBase = await realpath(os.tmpdir());
  const fixture = await fixtureFor(t);
  assert.equal(path.dirname(fixture.root), tempBase);
  const externalBase = await mkdtemp(path.join(tempBase, 'awr-dashboard-copy-path-test-'));
  t.after(async () => {
    if (path.dirname(externalBase) !== tempBase || !path.basename(externalBase).startsWith('awr-dashboard-copy-path-test-')) throw new Error('Invalid test cleanup target');
    await rm(externalBase, { recursive: true, force: true });
  });
  const target = path.join(fixture.root, 'copy-target');
  await mkdir(target);
  const linkedBase = path.join(externalBase, 'linked-base');
  try {
    await symlink(target, linkedBase, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统不允许测试创建重解析链接'); return; }
    throw error;
  }
  const before = await fixtureFileBaseline(fixture.root);
  const mock = t.mock.method(os, 'tmpdir', () => linkedBase);
  try {
    await assert.rejects(readSnapshot(fixture.root), errorCode('UNSAFE_PATH', false));
    assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  } finally {
    mock.mock.restore();
  }
});

test('同名前缀的项目外兄弟临时目录不会误拒绝且副本会清理', async (t) => {
  const tempBase = await realpath(os.tmpdir());
  const fixture = await fixtureFor(t);
  assert.equal(path.dirname(fixture.root), tempBase);
  const externalBase = await mkdtemp(`${fixture.root}-copy-base-`);
  t.after(async () => {
    if (path.dirname(externalBase) !== tempBase || !path.basename(externalBase).startsWith(`${path.basename(fixture.root)}-copy-base-`)) throw new Error('Invalid test cleanup target');
    await rm(externalBase, { recursive: true, force: true });
  });
  const before = await fixtureFileBaseline(fixture.root);
  const mock = t.mock.method(os, 'tmpdir', () => externalBase);
  try {
    assert.equal((await readSnapshot(fixture.root)).counts.ready, 1);
    assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
    assert.deepEqual(await readdir(externalBase), []);
  } finally {
    mock.mock.restore();
  }
});

test('未知版本、迁移清单和必要列不兼容均固定拒绝', async (t) => {
  const fixture = await fixtureFor(t);
  fixture.db.exec("UPDATE schema_migrations SET name='unknown' WHERE version=7;");
  await assert.rejects(readSnapshot(fixture.root), errorCode('UNSUPPORTED_SCHEMA'));
  fixture.db.exec("UPDATE schema_migrations SET name='content_reviews' WHERE version=7; ALTER TABLE work_items DROP COLUMN tags_json;");
  await assert.rejects(readSnapshot(fixture.root), errorCode('UNSUPPORTED_SCHEMA'));
});

test('非 AWR 归属和错误项目根拒绝；Windows 扩展前缀可规范化', async (t) => {
  const fixture = await fixtureFor(t);
  if (process.platform === 'win32') {
    fixture.db.prepare('UPDATE projects SET root=?').run(`\\\\?\\${fixture.root}`);
    assert.equal((await readSnapshot(fixture.root)).counts.total, 1);
  }
  fixture.db.prepare('UPDATE projects SET root=?').run(path.join(fixture.root, 'other'));
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
  fixture.db.prepare('UPDATE projects SET root=?').run(fixture.root);
  fixture.db.exec('PRAGMA application_id=0;');
  await assert.rejects(readSnapshot(fixture.root), errorCode('UNSUPPORTED_SCHEMA'));
});

test('回滚日志存在时拒绝读取、不删除日志或恢复原库', async (t) => {
  const fixture = await fixtureFor(t);
  await writeFile(path.join(fixture.root, '.awr', 'state.db-journal'), 'fixture pending write');
  const before = await fixtureFileBaseline(fixture.root);
  await assert.rejects(readSnapshot(fixture.root), errorCode('ROLLBACK_JOURNAL', true));
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
});

test('数据库64 MiB上限在分配与复制前拒绝', async (t) => {
  const fixture = await fixtureFor(t);
  const handle = await open(path.join(fixture.root, '.awr', 'state.db-wal'), 'w');
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(readSnapshot(fixture.root), errorCode('DATABASE_TOO_LARGE', false));
});

test('超过1000个真实工作项明确拒绝，不默默截断完整图', async (t) => {
  const fixture = await fixtureFor(t, { works: Array.from({ length: 1001 }, (_, index) => ({ key: `W-${index}`, status: 'ready' })) });
  await assert.rejects(readSnapshot(fixture.root), errorCode('NODE_LIMIT', false));
});

test('双读中的字节变化重试一次，持续变化返回可重试错误', async (t) => {
  const fixture = await fixtureFor(t);
  let calls = 0;
  await assert.rejects(readSnapshot(fixture.root, { onCaptureStep: async () => {
    calls += 1;
    fixture.db.prepare('UPDATE projects SET project_revision=project_revision+1').run();
  } }), errorCode('CAPTURE_CONFLICT', true));
  assert.equal(calls, 2);
  calls = 0;
  const snapshot = await readSnapshot(fixture.root, { onCaptureStep: async ({ attempt }) => {
    calls += 1;
    if (attempt === 0) fixture.db.prepare('UPDATE projects SET project_revision=project_revision+1').run();
  } });
  assert.equal(calls, 2);
  assert.equal(snapshot.counts.total, 1);
});

test('读取中日志创建/消失以及 journal 创建均不接受混合捕获', async (t) => {
  const fixture = await fixtureFor(t);
  const wal = path.join(fixture.root, '.awr', 'state.db-wal');
  let calls = 0;
  await assert.rejects(readSnapshot(fixture.root, { onCaptureStep: async ({ attempt }) => {
    calls += 1;
    if (attempt === 0) await writeFile(wal, Buffer.alloc(0));
    else await unlink(wal);
  } }), errorCode('CAPTURE_CONFLICT', true));
  assert.equal(calls, 2);
  await assert.rejects(readSnapshot(fixture.root, { onCaptureStep: async () => {
    await writeFile(path.join(fixture.root, '.awr', 'state.db-journal'), 'fixture');
  } }), errorCode('ROLLBACK_JOURNAL', true));
});

test('仅台账字节变化/缺失使旧投影过期，没有源重索引', async (t) => {
  const fixture = await fixtureFor(t);
  const first = await readSnapshot(fixture.root);
  await writeFile(path.join(fixture.root, 'ledger.yaml'), 'work_items: []\n# unindexed change\n');
  await bumpDatabaseStamp(fixture.root);
  const before = await fixtureFileBaseline(fixture.root);
  const stale = await readSnapshot(fixture.root);
  assert.notEqual(stale.sourceFingerprint, first.sourceFingerprint);
  assert.equal(stale.sources.find((source) => source.id === fixture.sourceRows.get('ledger').id).freshness, 'stale');
  assert.ok(codes(node(stale, 'A')).includes('source_not_fresh'));
  assert.equal(node(stale, 'A').waiting, true);
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  await unlink(path.join(fixture.root, 'ledger.yaml'));
  await bumpDatabaseStamp(fixture.root);
  const missing = await readSnapshot(fixture.root);
  assert.equal(missing.sources.find((source) => source.id === fixture.sourceRows.get('ledger').id).freshness, 'missing');
  assert.equal(node(missing, 'A').ready, false);
});

test('已知工作流普通文件适配器按原字节与完整版本2配置核验且不误阻塞无依赖工作', async (t) => {
  const streamBytes = Buffer.from('workstreams: []\n');
  const fixture = await fixtureFor(t, { profile: 'standard', sources: [
    { key: 'ledger', domain: 'ledger', filename: 'ledger.yaml', adapter: 'yaml-ledger-v1', text: 'work_items: []\n' },
    { key: 'streams', domain: 'workstream', filename: 'workstreams.yaml', adapter: 'yaml-workstream-ledger-v1', text: streamBytes.toString() },
  ] });
  const stream = fixture.sourceRows.get('streams');
  // 普通工作项仍来自正常台账；额外工作流来源仅参与注册配置与原字节当前性核验。
  assert.deepEqual(stream.config, { mapping_key: 'workstream|workstreams.yaml', adapter_options: {}, adapter_version: 2 });
  const before = await fixtureFileBaseline(fixture.root);
  const snapshot = await readSnapshot(fixture.root, { now: 1000 });
  assert.ok(snapshot.sources.every((source) => source.freshness === 'fresh'));
  const streamResult = snapshot.sources.find((source) => source.id === stream.id);
  assert.equal(streamResult.indexedFingerprint, stream.fingerprint);
  assert.equal(streamResult.currentFingerprint, stream.fingerprint);
  assert.equal(snapshot.diagnostics.some((item) => item.code === 'source_registry_unverified'), false);
  assert.deepEqual(snapshot.edges, []);
  assert.deepEqual(node(snapshot, 'A').upstream, []);
  assert.equal(node(snapshot, 'A').ready, true);
  assert.equal(snapshot.counts.ready, 1);
  assert.deepEqual(await readFile(path.join(fixture.root, 'workstreams.yaml')), streamBytes);
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  assert.equal(JSON.stringify(snapshot).includes('adapter_options'), false);
});

test('注册 options、adapter_version、context_profile 漂移均阻止就绪', async (t) => {
  const fixture = await fixtureFor(t);
  const manifestPath = path.join(fixture.root, '.awr', 'project.toml');
  await writeFile(manifestPath, fixture.manifest.replace('context_profile = "minimal"', 'context_profile = "standard"'));
  assert.ok(codes(node(await readSnapshot(fixture.root), 'A')).includes('source_registry_unverified'));
  await writeFile(manifestPath, fixture.manifest);
  const source = fixture.sourceRows.get('ledger');
  fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify({ ...source.config, adapter_version: 3 }), source.id);
  assert.ok(codes(node(await readSnapshot(fixture.root), 'A')).includes('source_registry_unverified'));
  fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify({ ...source.config, adapter_options: { key_prefix: 'changed' } }), source.id);
  assert.ok(codes(node(await readSnapshot(fixture.root), 'A')).includes('source_registry_unverified'));
  fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify({ ...source.config, mapping_key: 'ledger|other.yaml' }), source.id);
  assert.ok(codes(node(await readSnapshot(fixture.root), 'A')).includes('source_registry_unverified'));
});

test('Windows已索引大小写别名定位符可核验但原始mapping_key漂移仍拒绝', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await fixtureFor(t);
  const manifestPath = path.join(fixture.root, '.awr', 'project.toml');
  const source = fixture.sourceRows.get('ledger');
  // Windows 同一普通文件可由大小写别名访问；已索引定位符和工作引用仍保留物理文件名。
  await writeFile(manifestPath, fixture.manifest.replace('path = "ledger.yaml"', 'path = "LEDGER.yaml"'));
  const indexedConfig = { ...source.config, mapping_key: 'ledger|LEDGER.yaml' };
  fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify(indexedConfig), source.id);
  const before = await fixtureFileBaseline(fixture.root);
  const current = await readSnapshot(fixture.root, { now: 1000 });
  assert.ok(current.sources.every((item) => item.freshness === 'fresh'));
  assert.equal(current.diagnostics.some((item) => item.code === 'source_registry_unverified'), false);
  assert.equal(node(current, 'A').ready, true);
  assert.equal(current.counts.ready, 1);
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  // 物理路径等价不得掩盖真正的原声明来源键漂移：恢复旧索引配置后必须保守拒绝。
  fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify(source.config), source.id);
  const staleBefore = await fixtureFileBaseline(fixture.root);
  const stale = await readSnapshot(fixture.root, { now: 1000 });
  assert.equal(stale.counts.ready, 0);
  assert.ok(stale.diagnostics.some((item) => item.code === 'source_registry_unverified'));
  assert.ok(codes(node(stale, 'A')).includes('source_registry_unverified'));
  assert.deepEqual(await fixtureFileBaseline(fixture.root), staleBefore);
});

test('相同来源字节的不同过期索引配置具有不同内部指纹且不回传配置', async (t) => {
  const fixture = await fixtureFor(t);
  const source = fixture.sourceRows.get('ledger');
  const sourcePath = path.join(fixture.root, 'ledger.yaml');
  const sourceBytes = await readFile(sourcePath);
  const snapshots = [];
  // 只改变测试数据库中的已索引配置，当前注册和来源字节在各轮保持一致。
  const outdatedConfigs = [
    { ...source.config, adapter_version: 3 },
    { ...source.config, adapter_version: 2 },
    { ...source.config, adapter_options: { key_prefix: 'outdated-a' } },
    { ...source.config, adapter_options: { key_prefix: 'outdated-b' } },
  ];
  for (const config of outdatedConfigs) {
    fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify(config), source.id);
    const snapshot = await readSnapshot(fixture.root, { now: 1000 });
    assert.equal(snapshot.counts.ready, 0);
    assert.ok(snapshot.diagnostics.some((item) => item.code === 'source_registry_unverified'));
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    // 配置身份只参与内部散列，公共快照不得泄漏配置键或配置正文。
    const serialized = JSON.stringify(snapshot);
    for (const key of ['indexedConfig', 'adapter_version', 'adapter_options', 'context_profile', 'mapping_key']) {
      assert.equal(serialized.includes(key), false);
    }
    assert.equal(serialized.includes(JSON.stringify(config)), false);
    snapshots.push(snapshot);
  }
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.sourceFingerprint)).size, outdatedConfigs.length);
});

test('新增未索引注册、未核验 Git、越界来源均 fail closed 且不读取目标', async (t) => {
  const fixture = await fixtureFor(t);
  const manifestPath = path.join(fixture.root, '.awr', 'project.toml');
  const newSource = '\n[[sources]]\ndomain="other"\nrole="supporting"\npath="never-indexed.md"\nadapter="markdown-heading-v1"\n';
  await writeFile(manifestPath, fixture.manifest + newSource);
  const added = await readSnapshot(fixture.root);
  assert.equal(added.counts.ready, 0);
  assert.ok(added.diagnostics.some((item) => item.code === 'source_registry_unverified'));
  await writeFile(manifestPath, fixture.manifest.replace('path = "ledger.yaml"', 'locator = "git://HEAD:ledger.yaml"'));
  await bumpDatabaseStamp(fixture.root);
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
  await writeFile(manifestPath, fixture.manifest.replace('path = "ledger.yaml"', 'path = "../outside.yaml"'));
  await bumpDatabaseStamp(fixture.root);
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
});

test('来源配置顺序及注册声明顺序不改变核验结果指纹', async (t) => {
  const fixture = await fixtureFor(t);
  const initial = await readSnapshot(fixture.root);
  for (const source of fixture.sourceRows.values()) {
    fixture.db.prepare('UPDATE sources SET config_json=? WHERE id=?').run(JSON.stringify(Object.fromEntries(Object.entries(source.config).reverse())), source.id);
  }
  const parts = fixture.manifest.split('\n[[sources]]');
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), `${parts[0]}\n[[sources]]${parts[2]}\n[[sources]]${parts[1]}\n`);
  const reordered = await readSnapshot(fixture.root);
  assert.equal(reordered.counts.ready, 1);
  assert.equal(reordered.sourceFingerprint, initial.sourceFingerprint);
});

test('默认 standard 配置可核验、声明 fresh 但指纹错仍不可领取', async (t) => {
  const fixture = await fixtureFor(t, { profile: 'standard' });
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), fixture.manifest.replace('context_profile = "standard"\n', ''));
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 1);
  fixture.db.prepare('UPDATE sources SET fingerprint=? WHERE id=?').run(`sha256:${'0'.repeat(64)}`, fixture.sourceRows.get('ledger').id);
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
});

test('载荷/边来源修订漂移降低来源当前性，标识不一致整体拒绝', async (t) => {
  const fixture = await fixtureFor(t, { works: [{ key: 'A', status: 'completed' }, { key: 'B', status: 'ready' }],
    edges: [{ from: 'B', to: 'A', sourceRevision: 0 }] });
  const snapshot = await readSnapshot(fixture.root);
  assert.equal(snapshot.sources.find((source) => source.id === fixture.sourceRows.get('ledger').id).freshness, 'stale');
  assert.equal(node(snapshot, 'B').ready, false);
  fixture.db.prepare('UPDATE edges SET source_revision=2').run();
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
});

test('载荷 ID/类型不一致和重复有效工作键整体拒绝，不返回半图', async (t) => {
  const fixture = await fixtureFor(t);
  updateFixtureWork(fixture, 'A', { id: fixtureId(999) });
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
  updateFixtureWork(fixture, 'A', { id: fixture.workIds.get('A'), acceptance: [1] });
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
  updateFixtureWork(fixture, 'A', { acceptance: [] });
  const fields = fixture.db.prepare('SELECT * FROM work_items LIMIT 1').get();
  const duplicate = { ...fields, id: fixtureId(999), payload_json: JSON.stringify({ ...JSON.parse(fields.payload_json), id: fixtureId(999) }) };
  fixture.db.prepare(`INSERT INTO work_items VALUES(${Object.keys(duplicate).map(() => '?').join(',')})`).run(...Object.values(duplicate));
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
});

test('必要菱形递归检查全部传递前置项、邻接只包含直接必要项', async (t) => {
  const fixture = await fixtureFor(t, { works: [
    { key: 'A', status: 'completed' }, { key: 'B', status: 'completed' }, { key: 'C', status: 'completed' }, { key: 'D', status: 'ready' },
  ], edges: [{ from: 'B', to: 'A' }, { from: 'C', to: 'A' }, { from: 'D', to: 'B' }, { from: 'D', to: 'C' }] });
  const ready = await readSnapshot(fixture.root);
  assert.equal(node(ready, 'D').ready, true);
  assert.deepEqual(node(ready, 'D').upstream, ['B', 'C']);
  assert.deepEqual(node(ready, 'A').downstream, ['B', 'C']);
  assert.ok(ready.edges.every((edge) => edge.satisfied));
  assert.ok(ready.edges.some((edge) => edge.from === 'A' && edge.to === 'B'));
  updateFixtureWork(fixture, 'A', { status: 'blocked', raw_status: 'blocked' });
  const blocked = node(await readSnapshot(fixture.root), 'D');
  assert.equal(blocked.ready, false);
  assert.equal(blocked.diagnostics.filter((item) => item.code === 'dependency_not_completed' && item.workKey === 'A').length, 1);
});

test('缺失/停用必要前置项显示占位，可选缺失项不阻塞且不进真实计数', async (t) => {
  const fixture = await fixtureFor(t, { works: [{ key: 'A', status: 'ready' }, { key: 'B', status: 'ready' }, { key: 'OFF', status: 'completed', active: 0 }],
    edges: [{ from: 'A', to: 'ABSENT' }, { from: 'A', to: 'OFF' }, { from: 'B', to: 'OPTIONAL', required: false }] });
  const snapshot = await readSnapshot(fixture.root);
  assert.equal(snapshot.counts.total, 2);
  assert.equal(node(snapshot, 'ABSENT').missing, true);
  assert.equal(node(snapshot, 'OFF').missing, true);
  assert.equal(node(snapshot, 'OPTIONAL').missing, true);
  assert.ok(codes(node(snapshot, 'A')).includes('missing_dependency'));
  assert.equal(node(snapshot, 'B').ready, true);
  assert.deepEqual(node(snapshot, 'B').upstream, []);
});

test('必要环诊断只点名真实环成员，后续节点不是环成员，自环也可终止', async (t) => {
  const fixture = await fixtureFor(t, { works: ['A', 'B', 'C', 'SELF'].map((key) => ({ key, status: 'ready' })),
    edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'C', to: 'A' }, { from: 'SELF', to: 'SELF' }] });
  const snapshot = await readSnapshot(fixture.root);
  assert.deepEqual(node(snapshot, 'C').diagnostics.filter((item) => item.code === 'dependency_cycle').map((item) => item.workKey).sort(), ['A', 'B']);
  assert.equal(node(snapshot, 'C').ready, false);
  assert.ok(codes(node(snapshot, 'SELF')).includes('dependency_cycle'));
});

test('取消/归档完成不满足必要依赖，明确阻塞不改变进行中色类', async (t) => {
  const fixture = await fixtureFor(t, { works: [
    { key: 'CANCELLED', status: 'cancelled' }, { key: 'ARCHIVE', status: 'completed', archived: true },
    { key: 'B', status: 'ready' }, { key: 'C', status: 'ready' }, { key: 'RUNNING', status: 'in_progress', blocker: 'Fixture blocker' },
  ], edges: [{ from: 'B', to: 'CANCELLED' }, { from: 'C', to: 'ARCHIVE' }] });
  const snapshot = await readSnapshot(fixture.root);
  assert.ok(codes(node(snapshot, 'B')).includes('dependency_not_completed'));
  assert.ok(codes(node(snapshot, 'C')).includes('dependency_not_completed'));
  assert.equal(node(snapshot, 'RUNNING').status, 'in_progress');
  assert.ok(codes(node(snapshot, 'RUNNING')).includes('active_blocker'));
  assert.equal(snapshot.counts.progress.total, 3);
  assert.equal(snapshot.counts.progress.done, 0);
});

test('独立边来源字节漂移阻止领取，节点来源没有漂移也不能绕过', async (t) => {
  const fixture = await fixtureFor(t, { sources: [
    { key: 'ledger', domain: 'ledger', filename: 'ledger.yaml', adapter: 'yaml-ledger-v1' },
    { key: 'edges', domain: 'ledger', filename: 'edges.yaml', adapter: 'yaml-ledger-v1' },
  ], works: [{ key: 'A', status: 'completed' }, { key: 'B', status: 'ready' }], edges: [{ from: 'B', to: 'A', source: 'edges' }] });
  assert.equal(node(await readSnapshot(fixture.root), 'B').ready, true);
  await writeFile(path.join(fixture.root, 'edges.yaml'), '# unindexed edge change');
  await bumpDatabaseStamp(fixture.root);
  const changed = await readSnapshot(fixture.root);
  assert.equal(changed.edges[0].satisfied, false);
  assert.equal(node(changed, 'B').ready, false);
  assert.ok(changed.edges[0].diagnostics.some((item) => item.code === 'source_not_fresh'));
});

test('跨分支且会话已结束的 active claim 仍占用，严格等于到期时释放派生状态', async (t) => {
  const fixture = await fixtureFor(t, { claims: [{ key: 'A', branch: true, sessionStatus: 'ended', expiresAt: 100 }] });
  const before = await readSnapshot(fixture.root, { now: () => 99 });
  assert.equal(node(before, 'A').claims.length, 1);
  assert.equal(node(before, 'A').ready, false);
  assert.equal(node(before, 'A').continuable, true);
  assert.equal(node(before, 'A').waiting, false);
  await bumpDatabaseStamp(fixture.root);
  const atExpiry = await readSnapshot(fixture.root, { now: 100 });
  assert.equal(before.revision, atExpiry.revision);
  assert.equal(node(atExpiry, 'A').claims.length, 0);
  assert.equal(node(atExpiry, 'A').ready, true);
});

test('无到期认领有效；已释放/非active认领不占用', async (t) => {
  const fixture = await fixtureFor(t, { works: ['A', 'B', 'C'].map((key) => ({ key, status: 'ready' })),
    claims: [{ key: 'A' }, { key: 'B', releasedAt: 10 }, { key: 'C', status: 'released' }] });
  const snapshot = await readSnapshot(fixture.root, { now: 999999 });
  assert.equal(node(snapshot, 'A').ready, false);
  assert.equal(node(snapshot, 'A').claims[0].expiresAt, null);
  assert.equal(node(snapshot, 'B').ready, true);
  assert.equal(node(snapshot, 'C').ready, true);
});

test('互斥状态计数和本地分类、归档优先及空进度分母准确', async (t) => {
  const fixture = await fixtureFor(t, { works: [
    { key: 'A', status: 'completed' }, { key: 'B', status: 'ready' }, { key: 'C', status: 'planned' },
    { key: 'D', status: 'in_progress' }, { key: 'E', status: 'claimed' }, { key: 'F', status: 'draft' },
    { key: 'G', status: 'blocked' }, { key: 'H', status: 'cancelled' }, { key: 'I', status: 'completed', archived: true },
    { key: 'J', status: 'unknown' }, { key: 'K', status: 'ready' }, { key: 'L', status: 'ready', blocker: 'Fixture blocker' },
  ], claims: [{ key: 'K' }] });
  const counts = (await readSnapshot(fixture.root)).counts;
  assert.deepEqual(counts, { total: 12, completed: 1, inProgress: 2, pending: 5, blocked: 1, cancelled: 1, archived: 1, unknown: 1,
    ready: 2, continuable: 3, waiting: 1, progress: { done: 1, total: 10, ratio: 0.1 } });
  const empty = await fixtureFor(t, { works: [{ key: 'C', status: 'cancelled' }] });
  assert.deepEqual((await readSnapshot(empty.root)).counts.progress, { done: 0, total: 0, ratio: null });
});

test('敏感载荷全部可选文字被隐藏；项目名、认领、证据与诊断不回传危险值', async (t) => {
  const secret = 'sk-fixturecredential012345678901';
  const fixture = await fixtureFor(t, { name: `password: ${secret}`, works: [{ key: 'A', status: 'ready',
    payload: { title: 'Public title', acceptance: ['Public acceptance'], extra: { token: secret } } }, { key: 'B', status: 'ready' }],
    claims: [{ key: 'B', agent: `Bearer ${secret}` }], evidence: [{ key: 'A', locator: `https://user:${secret}@invalid.example/test`, summary: secret }] });
  const snapshot = await readSnapshot(fixture.root);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('Public acceptance'), false);
  assert.equal(serialized.includes('Public title'), false);
  assert.equal(snapshot.project.name, '敏感内容已隐藏');
  for (const key of ['A', 'B']) {
    assert.equal(node(snapshot, key).title, '敏感内容已隐藏');
    assert.equal(node(snapshot, key).owner, null);
    assert.equal(node(snapshot, key).ready, false);
    assert.ok(codes(node(snapshot, key)).includes('sensitive_content_withheld'));
  }
  assert.equal(node(snapshot, 'B').claims[0].agentId, null);
});

test('危险结构键整体拒绝，固定错误不泄露内容；HTML作为公开文字保留', async (t) => {
  const fixture = await fixtureFor(t, { works: [{ key: 'A', status: 'ready', title: '<img src=x onerror=fixture()>' }] });
  assert.equal(node(await readSnapshot(fixture.root), 'A').title, '<img src=x onerror=fixture()>');
  const unsafe = 'sk-fixturecredential012345678901';
  const row = fixture.db.prepare('SELECT payload_json FROM work_items WHERE external_key=?').get('A');
  const payload = { ...JSON.parse(row.payload_json), external_key: unsafe };
  fixture.db.prepare('UPDATE work_items SET external_key=?,payload_json=?').run(unsafe, JSON.stringify(payload));
  await assert.rejects(readSnapshot(fixture.root), (error) => errorCode('UNSAFE_IDENTIFIER')(error) && !error.message.includes(unsafe));
});

test('危险前置载荷也阻止后续肯定就绪，但不无故隐藏后续公开文字', async (t) => {
  const fixture = await fixtureFor(t, { works: [
    { key: 'A', status: 'completed', payload: { extra: { password: 'fixture-secret-value' } } },
    { key: 'B', status: 'ready', title: 'Public dependent' },
  ], edges: [{ from: 'B', to: 'A' }] });
  const snapshot = await readSnapshot(fixture.root);
  assert.equal(node(snapshot, 'B').ready, false);
  assert.equal(node(snapshot, 'B').title, 'Public dependent');
  assert.ok(node(snapshot, 'B').diagnostics.some((item) => item.code === 'sensitive_content_withheld' && item.workKey === 'A'));
});

test('同源某项危险文字不传播遮蔽到安全项，原源只核验字节不输出', async (t) => {
  const secret = 'fixture-labelled-value-only';
  const fixture = await fixtureFor(t, {
    sources: [{ key: 'ledger', domain: 'ledger', filename: 'ledger.yaml', adapter: 'yaml-ledger-v1',
      text: `work_items:\n- id: A\n  title: 'password: ${secret}'\n- id: B\n  title: Public safe fixture\n` }],
    works: [{ key: 'A', status: 'ready', payload: { private_details: { password: secret } } },
      { key: 'B', status: 'ready', title: 'Public safe fixture' }],
  });
  const snapshot = await readSnapshot(fixture.root);
  assert.equal(snapshot.sources[0].freshness, 'fresh');
  assert.equal(node(snapshot, 'A').title, '敏感内容已隐藏');
  assert.equal(node(snapshot, 'A').ready, false);
  assert.equal(node(snapshot, 'B').title, 'Public safe fixture');
  assert.equal(node(snapshot, 'B').ready, true);
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test('工作来源修订漂移与停用来源，孤立投影损坏不被悄悄省略', async (t) => {
  const fixture = await fixtureFor(t, { works: [{ key: 'A', status: 'ready', sourceRevision: 0 }] });
  const stale = await readSnapshot(fixture.root);
  assert.equal(stale.counts.ready, 0);
  assert.ok(stale.sources.some((source) => source.freshness === 'stale'));
  fixture.db.prepare('UPDATE sources SET active=0 WHERE id=?').run(fixture.sourceRows.get('ledger').id);
  assert.equal((await readSnapshot(fixture.root)).counts.total, 0);
  fixture.db.prepare('DELETE FROM sources WHERE id=?').run(fixture.sourceRows.get('ledger').id);
  await assert.rejects(readSnapshot(fixture.root), errorCode('INCOMPATIBLE_PROJECTION'));
});

test('损坏数据库与无效评估时刻均固定失败，不透露原始异常', async (t) => {
  const fixture = await fixtureFor(t);
  await assert.rejects(readSnapshot(fixture.root, { now: Number.NaN }), errorCode('INCOMPATIBLE_PROJECTION'));
  await writeFile(path.join(fixture.root, '.awr', 'state.db'), 'This is not a database');
  await assert.rejects(readSnapshot(fixture.root), errorCode('INVALID_DATABASE'));
});

test('不读证据目标，不读注册的.env/密钥文件；大源/坏TOML均未核验', async (t) => {
  const fixture = await fixtureFor(t, { evidence: [{ key: 'A', locator: 'nonexistent-secret-file.pem' }] });
  assert.equal(node(await readSnapshot(fixture.root), 'A').evidence[0].locator, 'nonexistent-secret-file.pem');
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), fixture.manifest.replace('path = "ledger.yaml"', 'path = ".env"'));
  await bumpDatabaseStamp(fixture.root);
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), fixture.manifest);
  const handle = await open(path.join(fixture.root, 'ledger.yaml'), 'w');
  await handle.truncate(8 * 1024 * 1024 + 1);
  await handle.close();
  await bumpDatabaseStamp(fixture.root);
  assert.equal((await readSnapshot(fixture.root)).sources.find((source) => source.id === fixture.sourceRows.get('ledger').id).freshness, 'unverified');
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), 'broken = [');
  await bumpDatabaseStamp(fixture.root);
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
});

test('数据库符号链接/重解析跳转拒绝；来源跳转未核验', async (t) => {
  const fixture = await fixtureFor(t);
  const outside = path.join(fixture.root, 'linked');
  await mkdir(outside);
  try {
    await symlink(outside, path.join(fixture.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前系统不允许测试创建重解析链接'); return; }
    throw error;
  }
  await writeFile(path.join(fixture.root, '.awr', 'project.toml'), fixture.manifest.replace('path = "ledger.yaml"', 'path = "link/source.yaml"'));
  assert.equal((await readSnapshot(fixture.root)).counts.ready, 0);
  await assert.rejects(readSnapshot(path.join(fixture.root, 'link')), errorCode('PROJECT_UNAVAILABLE'));
  await rm(path.join(fixture.root, 'link'));
});

test('保守敏感检测涵盖秘密标签、凭据块、授权、口令URL、环境和编码；占位不误泄露', () => {
  const dangerous = [
    'password: fixture-value-only', 'Bearer fixture-auth-value', 'Basic ZmFrZTpmYWtl',
    '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
    'https://user:fixture-password@invalid.example/', 'AA=value\nBB=second',
    'sk-abc\\u0064efghijklmnopqrstuvwxyz', 'pass\u200bword: fixture-value',
    { refresh_token: 'fixture-value-only' }, { env: { AA: 'fixture-value-only' } },
  ];
  assert.ok(dangerous.every(hasSensitiveContent));
  assert.equal(hasSensitiveContent({ password: '${PASSWORD}', api_key: '[redacted]', token: null }), false);
  assert.equal(hasSensitiveContent('password: [redacted]'), false);
  assert.equal(hasSensitiveContent('<img src=x onerror=fixture()>'), false);
  assert.equal(sanitizeText('password: fixture-value-only'), '敏感内容已隐藏');
  const error = new DashboardError('INCOMPATIBLE_PROJECTION', 'password: fixture-value-only');
  assert.equal(error.message.includes('fixture-value-only'), false);
});
