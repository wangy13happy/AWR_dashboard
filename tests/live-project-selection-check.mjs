import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { chromium, expect } from '@playwright/test';
import { readProjectRegistry, normalizedProjectRoot } from '../src/registry.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(workspace, process.env.AWR_DASHBOARD_VERIFICATION_DIR
  ?? path.join('verification/project-selection', `live-${new Date().toISOString().replace(/[:.]/g, '-')}`));
// 真实只读窗口可在新一轮的独立证据目录复验；仍不接受项目外或运行目录作为输出位置。
const relativeOutput = path.relative(path.join(workspace, 'verification'), output);
assert.ok(!path.isAbsolute(relativeOutput) && /^(project-selection|background-startup)[\\/]/.test(relativeOutput)
  && !relativeOutput.split(/[\\/]/).includes('..'), '真实验收证据须位于本项目独立验收目录');
const registry = await readProjectRegistry(path.join(workspace, 'config/projects.json'));
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:4317/');
assert.equal(base.protocol, 'http:'); assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.pathname, '/'); assert.equal(base.search, ''); assert.equal(base.hash, '');
const startedAt = Date.now();
const pageErrors = [];
const snapshots = [];
let browser;
let failure = null;
await mkdir(output, { recursive: true });

/** 只校验根内普通文件路径，链接、越界路径或凭据名称不会用于验收读取。 */
async function ordinaryPath(root, filename) {
  const relative = path.relative(root, filename);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), '监测目标不得越界');
  assert.ok(!/(?:^|[\\/])(?:\.env(?:\.|$)|credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|id_(?:rsa|ed25519)(?:\.|$))/i.test(relative), '不监测凭据文件');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { assert.ok(!(await lstat(current)).isSymbolicLink(), '监测路径不跟随链接'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

/** 哈希数据库侧文件及登记普通来源的字节；绝不用SQLite打开真实数据库。 */
async function fingerprint(root, relative) {
  const filename = path.resolve(root, relative);
  if (!(await ordinaryPath(root, filename))) return { path: relative, missing: true };
  const info = await lstat(filename, { bigint: true });
  assert.ok(info.isFile(), '监测目标须为普通文件');
  assert.ok(info.size <= 64n * 1024n * 1024n, '单监测文件不得超64二进制兆字节');
  const bytes = await readFile(filename);
  return { path: relative, size: info.size.toString(), mtime: info.mtimeNs.toString(), ctime: info.ctimeNs.toString(),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 枚举本项目治理目录的元数据，不读附件正文、不递归到项目外或扫描磁盘。 */
async function inventory(root, relative = '.awr') {
  const records = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const info = await lstat(path.join(root, name), { bigint: true });
    assert.ok(!entry.isSymbolicLink(), '治理清单不跟随链接');
    records.push({ path: name, type: entry.isDirectory() ? 'directory' : 'file',
      size: info.size.toString(), mtime: info.mtimeNs.toString(), ctime: info.ctimeNs.toString() });
    if (entry.isDirectory()) records.push(...await inventory(root, name));
    assert.ok(records.length < 10000, '治理清单超出本次有界验收');
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

/** 建立明确文件字节和治理目录元数据基线；登记外来源仅记录未监测，不读取。 */
async function baseline(project) {
  const names = new Set(['.awr/project.toml', '.awr/state.db', '.awr/state.db-wal', '.awr/state.db-shm', '.awr/state.db-journal']);
  const skippedSources = [];
  const manifest = parseToml(await readFile(path.join(project.root, '.awr/project.toml'), 'utf8'));
  for (const source of manifest.sources ?? []) {
    if (typeof source.path !== 'string') { skippedSources.push('非普通路径来源'); continue; }
    const filename = path.resolve(project.root, source.path);
    const relative = path.relative(project.root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { skippedSources.push('根外来源'); continue; }
    try {
      if (!(await ordinaryPath(project.root, filename)) || !(await lstat(filename)).isFile()) {
        skippedSources.push('不可监测普通来源'); continue;
      }
    } catch { skippedSources.push('拒绝链接或凭据名称'); continue; }
    names.add(relative);
  }
  return { id: project.id, capturedAt: Date.now(), files: await Promise.all([...names].sort().map(name => fingerprint(project.root, name))),
    inventory: await inventory(project.root), skippedSources };
}

// 此正式窗口内不运行AWR治理写入；本看板自身也是被查看项目，需同样保持基线稳定。
const before = await Promise.all(registry.projects.map(baseline));
await writeFile(path.join(output, 'before.json'), `${JSON.stringify(before, null, 2)}\n`);
try {
  const listResponse = await fetch(new URL('/api/projects', base));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.mode, 'registry');
  assert.deepEqual(list.projects.map(project => project.id), registry.projects.map(project => project.id));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(new URL('/#view=graph', base).href);
  const select = page.getByTestId('project-select');
  await expect(select).toBeEnabled();
  for (const project of registry.projects) {
    const query = new URLSearchParams({ project: project.id, registry: list.registryRevision });
    const response = await fetch(new URL(`/api/snapshot?${query}`, base), { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, `项目${project.id}读取应成功`);
    const snapshot = await response.json();
    assert.equal(snapshot.selectedProjectId, project.id);
    assert.equal(snapshot.registryRevision, list.registryRevision);
    assert.equal(snapshot.readOnly, true); assert.equal(snapshot.mode, 'live');
    assert.equal(normalizedProjectRoot(snapshot.project.root), normalizedProjectRoot(project.root));
    await select.selectOption(project.id);
    await expect(page.getByTestId('project-name')).toHaveText(snapshot.project.name, { timeout: 10000 });
    await expect(page.locator('[data-node-key]')).toHaveCount(snapshot.nodes.length);
    await expect(page.getByTestId('demo-badge')).toBeHidden();
    await expect(page.getByTestId('failure-banner')).toHaveCount(0);
    snapshots.push({ id: project.id, revision: snapshot.revision, nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length,
      sourceFingerprint: snapshot.sourceFingerprint, sources: snapshot.sources.map(source => ({ id: source.id, freshness: source.freshness })) });
  }
  // 只观察，不制造任何真实项目状态变化；覆盖至少两个5秒刷新周期。
  await page.waitForTimeout(10500);
  await page.screenshot({ path: path.join(output, 'live-project-selection.png') });
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failure = { name: error.name, message: error instanceof assert.AssertionError ? String(error.message).slice(0, 300) : '真实只读查看未完成' };
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
const after = await Promise.all(registry.projects.map(baseline));
await writeFile(path.join(output, 'after.json'), `${JSON.stringify(after, null, 2)}\n`);
const comparisons = before.map((value, index) => ({ id: value.id, monitoredFiles: value.files.length,
  inventoryEntries: value.inventory.length, skippedSources: value.skippedSources,
  unchanged: JSON.stringify({ files: value.files, inventory: value.inventory }) === JSON.stringify({ files: after[index].files, inventory: after[index].inventory }) }));
const report = { passed: failure === null && comparisons.every(value => value.unchanged), startedAt, verifiedAt: Date.now(),
  observationMs: Date.now() - startedAt, projectCount: registry.projects.length, comparisons, snapshots, pageErrors, failure,
  boundary: '只用文件字节哈希与纳秒元数据监测登记普通来源、数据库侧文件及治理清单；不打开原SQLite连接、不读附件或凭据、不写被查看项目。外部并发变动会使比对失败，不能据此归因看板。5秒不是后台硬时限。' };
await writeFile(path.join(output, 'live-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, evidenceDirectory: path.relative(workspace, output) }));
if (!report.passed) process.exitCode = 1;
