import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSnapshot } from '../src/reader.js';
import { DashboardError } from '../src/safety.js';
import { createReaderFixture, updateFixtureWork } from './reader-fixture.mjs';
import { createRunningFixture } from './agent-running-fixture.mjs';

async function touchDatabase(root) {
  const filename = path.join(root, '.awr', 'state.db');
  const info = await lstat(filename);
  const next = new Date(Number(info.mtimeMs) + 1000);
  await utimes(filename, next, next);
}

test('数据库 size 和 mtime 未变时返回上次快照，光环期限按本次观察和本次时间重算', async (t) => {
  const fixture = await createRunningFixture();
  t.after(() => fixture.dispose());
  const first = await readSnapshot(fixture.root, { now: fixture.now, agentObservation: fixture.observation() });
  assert.equal(first.nodes[0].agentRunningUntil, fixture.now + 15000);
  // 库签名未变：updatedAt/evaluatedAt 证明仍是缓存命中，但回合结束要在本次读取熄灭。
  const ended = await readSnapshot(fixture.root, { now: fixture.now + 1000, agentObservation: fixture.observation('ended', fixture.now + 1000) });
  assert.equal(ended.updatedAt, first.updatedAt);
  assert.equal(ended.evaluatedAt, first.evaluatedAt);
  assert.equal(ended.nodes[0].agentRunningUntil, null);
  // 下一回合不写库也能重新点亮，期限取本次采样，经服务同款的观察提供者读取。
  const resumed = await readSnapshot(fixture.root, { now: fixture.now + 2000,
    agentObservationProvider: () => fixture.observation('executing', fixture.now + 2000) });
  assert.equal(resumed.updatedAt, first.updatedAt);
  assert.equal(resumed.nodes[0].agentRunningUntil, fixture.now + 2000 + 15000);
  // 观察缺失或过旧都撤销旧肯定，不沿用缓存里的期限。
  const missing = await readSnapshot(fixture.root, { now: fixture.now + 60_000, agentObservation: null });
  assert.equal(missing.updatedAt, first.updatedAt);
  assert.equal(missing.nodes[0].agentRunningUntil, null);
  const stale = await readSnapshot(fixture.root, { now: fixture.now + 60_000, agentObservation: fixture.observation() });
  assert.equal(stale.nodes[0].agentRunningUntil, null);
  // 缓存里的快照不被某次命中的重算改写。
  const again = await readSnapshot(fixture.root, { now: fixture.now, agentObservation: fixture.observation() });
  assert.equal(again.nodes[0].agentRunningUntil, fixture.now + 15000);
  await touchDatabase(fixture.root);
  const missed = await readSnapshot(fixture.root, { now: fixture.now + 60_000, agentObservation: null });
  assert.notEqual(missed.updatedAt, first.updatedAt);
  assert.equal(missed.evaluatedAt, fixture.now + 60_000);
  assert.equal(missed.nodes[0].agentRunningUntil, null);
});

test('只改台账字节且数据库签名未变时仍返回上次快照，签名变化后能看到过期', async (t) => {
  const fixture = await createReaderFixture();
  t.after(() => fixture.dispose());
  const first = await readSnapshot(fixture.root, { now: 1000 });
  await writeFile(path.join(fixture.root, 'ledger.yaml'), 'work_items: []\n# unindexed change\n');
  const hit = await readSnapshot(fixture.root, { now: 2000 });
  assert.equal(hit.updatedAt, first.updatedAt);
  assert.equal(hit.sourceFingerprint, first.sourceFingerprint);
  await touchDatabase(fixture.root);
  const missed = await readSnapshot(fixture.root, { now: 3000 });
  assert.notEqual(missed.updatedAt, first.updatedAt);
  assert.notEqual(missed.sourceFingerprint, first.sourceFingerprint);
  assert.equal(missed.sources.find((source) => source.id === fixture.sourceRows.get('ledger').id).freshness, 'stale');
});

test('库内写入改变 WAL 或数据库签名后不复用旧标题', async (t) => {
  const fixture = await createReaderFixture();
  t.after(() => fixture.dispose());
  const first = await readSnapshot(fixture.root, { now: 1000 });
  updateFixtureWork(fixture, 'A', { title: 'Changed after cache' });
  const missed = await readSnapshot(fixture.root, { now: 1000 });
  assert.equal(missed.nodes.find((node) => node.key === 'A').title, 'Changed after cache');
  assert.notEqual(missed.updatedAt, first.updatedAt);
});

test('已缓存后出现回滚日志仍拒绝，不把上次快照当成成功', async (t) => {
  const fixture = await createReaderFixture();
  t.after(() => fixture.dispose());
  await readSnapshot(fixture.root, { now: 1000 });
  await writeFile(path.join(fixture.root, '.awr', 'state.db-journal'), 'fixture pending write');
  await assert.rejects(readSnapshot(fixture.root, { now: 1000 }), (error) => error instanceof DashboardError && error.code === 'ROLLBACK_JOURNAL');
});

test('两个项目根的快照缓存互不复用', async (t) => {
  const first = await createReaderFixture();
  const second = await createReaderFixture();
  t.after(() => first.dispose());
  t.after(() => second.dispose());
  const left = await readSnapshot(first.root, { now: 1000 });
  const right = await readSnapshot(second.root, { now: 1000 });
  updateFixtureWork(first, 'A', { title: 'Only left changed' });
  const leftAgain = await readSnapshot(first.root, { now: 1000 });
  const rightAgain = await readSnapshot(second.root, { now: 1000 });
  assert.equal(leftAgain.nodes.find((node) => node.key === 'A').title, 'Only left changed');
  assert.equal(rightAgain.updatedAt, right.updatedAt);
  assert.notEqual(leftAgain.updatedAt, left.updatedAt);
});
