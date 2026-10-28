import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, fixtureFileBaseline } from './reader-fixture.mjs';

/** 在自有夹具补入官方 0.6.0 迁移名称；只模拟读取契约，不修改真实项目。 */
async function schema14Fixture(t, options = {}) {
  const fixture = await createReaderFixture(options);
  t.after(() => fixture.dispose());
  const additions = ['responsibility', 'operation_readset_receipts', 'agent_authorization',
    'team_handoff', 'delivery_deps', 'usage_time', 'eta_checkpoints'];
  fixture.db.exec('BEGIN;');
  for (const [index, name] of additions.entries()) {
    fixture.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(index + 8, name, 100);
  }
  fixture.db.exec('PRAGMA user_version=14; COMMIT;');
  return fixture;
}

for (const wal of [false, true]) {
  test(`结构14保持依赖与状态语义、报告真实版本且原文件不变（日志=${wal}）`, async (t) => {
    const fixture = await schema14Fixture(t, { wal,
      works: [{ key: 'A', status: 'completed' }, { key: 'B', status: 'ready' }],
      edges: [{ from: 'B', to: 'A' }] });
    const before = await fixtureFileBaseline(fixture.root);
    const snapshot = await readSnapshot(fixture.root);
    assert.equal(snapshot.project.schemaVersion, 14);
    assert.equal(snapshot.project.awrVersion, '0.6.0');
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.counts.total, 2);
    assert.equal(snapshot.counts.ready, 1);
    assert.equal(snapshot.edges.length, 1);
    assert.deepEqual(snapshot.nodes.map((item) => item.key), ['A', 'B']);
    assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  });
}

for (const [label, sql] of [
  ['未来版本', 'PRAGMA user_version=15;'],
  ['未完成的中间迁移', 'PRAGMA user_version=13;'],
  ['缺失迁移记录', 'DELETE FROM schema_migrations WHERE version=10;'],
  ['迁移名不匹配', "UPDATE schema_migrations SET name='unrecognized' WHERE version=14;"],
  ['旧版本伪装新版清单', 'PRAGMA user_version=7;'],
  ['缺失必要列', 'ALTER TABLE work_items DROP COLUMN tags_json;'],
]) {
  test(`结构14仍拒绝${label}并保持只读`, async (t) => {
    const fixture = await schema14Fixture(t);
    fixture.db.exec(sql);
    const before = await fixtureFileBaseline(fixture.root);
    await assert.rejects(readSnapshot(fixture.root), (error) => error.code === 'UNSUPPORTED_SCHEMA');
    assert.deepEqual(await fixtureFileBaseline(fixture.root), before);
  });
}
