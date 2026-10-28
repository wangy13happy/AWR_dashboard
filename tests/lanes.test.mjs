import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assignLanes, codeFamily, validLaneOverrides, workCode } from '../src/lanes.js';
import { readSnapshot } from '../src/reader.js';
import { readProjectRegistry } from '../src/registry.js';
import { createReaderFixture, fixtureId } from './reader-fixture.mjs';

/** 生成最小快照节点；只含编号分组实际读取的字段。 */
function node(key, status = 'pending', extra = {}) {
  return { key, title: `Fixture ${key}`, status, missing: false, activity: null, ...extra };
}

/** 给夹具补建事件表并写入关联工作项的事件，模拟 AWR 记录的真实活动时刻。 */
function addEvents(fixture, rows) {
  fixture.db.exec('CREATE TABLE events(id TEXT PRIMARY KEY,project_id TEXT,work_item_id TEXT,event_type TEXT,payload_json TEXT,project_revision INTEGER,created_at INTEGER);');
  for (const [index, row] of rows.entries()) {
    fixture.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(fixtureId(900 + index), fixture.projectId,
      row.key === null ? null : fixture.workIds.get(row.key), row.type ?? 'work.progressed', '{}', index + 1, row.at);
  }
}

test('字面编号：普通键直接使用，WORK-哈希键取标题开头编号，无编号返回 null', () => {
  assert.equal(workCode({ key: 'STREAM-REUSE-001', title: '任意' }), 'STREAM-REUSE-001');
  assert.equal(workCode({ key: 'WORK-23a4041beb28ec3af9eb6ec4c25f886c', title: 'BUTTON-TRAPPED-001 按钮报警' }), 'BUTTON-TRAPPED-001');
  assert.equal(workCode({ key: 'WORK-0579677a044fd85b41331a91de30cc3d', title: '主模型Grok思考过程缺失' }), null);
  assert.equal(workCode({ key: 'WORK-0579677a044fd85b41331a91de30cc3d', title: 'Grok 续期提前量' }), null);
  assert.equal(codeFamily('STREAM-REUSE-001'), 'STREAM');
  assert.equal(codeFamily('dash-001'), 'DASH');
  assert.equal(codeFamily('T12'), 'T');
  assert.equal(codeFamily('2026-10'), null);
});

test('按族名分组：互为前缀合并、单例与无编号归零散、按最早活动排序', () => {
  const nodes = [
    node('DASHBOARD-001', 'completed', { activity: { firstAt: 50, lastAt: 60, events: 2 } }),
    node('DASH-READ-FAIL-RCA-20261021', 'in_progress', { activity: { firstAt: 70, lastAt: 90, events: 3 } }),
    node('STREAM-REUSE-001', 'in_progress', { activity: { firstAt: 10, lastAt: 40, events: 5 } }),
    node('STREAM-ONLINE-001', 'cancelled', { activity: { firstAt: 20, lastAt: 30, events: 1 } }),
    node('INTERCOM-001', 'in_progress', { activity: { firstAt: 5, lastAt: 99, events: 9 } }),
    node('WORK-0579677a044fd85b41331a91de30cc3d', 'completed', { title: '主模型Grok排查' }),
    node('GONE', 'unknown', { missing: true }),
  ];
  const lanes = assignLanes(nodes);
  assert.deepEqual(lanes.map((lane) => lane.key), ['STREAM', 'DASH', '~scattered']);
  assert.deepEqual(nodes.find((item) => item.key === 'DASHBOARD-001').group, { key: 'DASH', label: 'DASH', origin: 'prefix' });
  assert.equal(nodes.find((item) => item.key === 'INTERCOM-001').group.origin, 'scattered');
  assert.equal(nodes.find((item) => item.key === 'GONE').group, null);
  const stream = lanes[0];
  assert.deepEqual([stream.firstAt, stream.lastAt], [10, 40]);
  // 取消不进入完成分母，与全项目计数口径一致。
  assert.deepEqual(stream.counts.progress, { done: 0, total: 1, ratio: 0 });
  assert.deepEqual(lanes[2].workKeys, ['INTERCOM-001', 'WORK-0579677a044fd85b41331a91de30cc3d']);
  assert.equal(lanes.some((lane) => lane.workKeys.includes('GONE')), false);
});

test('短族名不吞并更长的无关族名', () => {
  const nodes = [node('DB-MOVE-1'), node('DB-MOVE-2'), node('DBX-1'), node('DBX-2')];
  assert.deepEqual(assignLanes(nodes).map((lane) => lane.key).sort(), ['DB', 'DBX']);
});

test('看板侧覆盖：改名使单例独立成组，合并与指派改写分组且标为 override', () => {
  const nodes = [node('INTERCOM-001'), node('VIDEO-001'), node('VIDEO-LOGIC-1'), node('PERSON-LEFT-1'), node('PERSON-LEFT-2'),
    node('WORK-0cfeba003fc5bc7dbb5c6087f3ab16e1', 'pending', { title: '设计框架图看板' })];
  const lanes = assignLanes(nodes, { labels: { INTERCOM: '业务二期·对讲复核', TRAPPED: '困人判定' },
    merge: { PERSON: 'TRAPPED' }, assign: { 'WORK-0cfeba003fc5bc7dbb5c6087f3ab16e1': 'VIDEO' } });
  const byKey = Object.fromEntries(lanes.map((lane) => [lane.key, lane]));
  assert.deepEqual(byKey.INTERCOM.workKeys, ['INTERCOM-001']);
  assert.equal(byKey.INTERCOM.label, '业务二期·对讲复核');
  assert.equal(byKey.INTERCOM.labelled, true);
  assert.deepEqual(byKey.TRAPPED.workKeys, ['PERSON-LEFT-1', 'PERSON-LEFT-2']);
  assert.equal(byKey.TRAPPED.label, '困人判定');
  assert.equal(nodes[3].group.origin, 'override');
  assert.equal(nodes[5].group.key, 'VIDEO');
  assert.equal(byKey['~scattered'], undefined);
});

test('覆盖结构校验：未知字段、非法键、过长或含控制符名称一律拒绝', () => {
  assert.deepEqual(validLaneOverrides(undefined), {});
  assert.deepEqual(validLaneOverrides({ labels: { A: '甲' } }), { labels: { A: '甲' }, merge: {}, assign: {} });
  assert.equal(validLaneOverrides({ colors: {} }), null);
  assert.equal(validLaneOverrides([]), null);
  assert.equal(validLaneOverrides({ labels: { '../x': '甲' } }), null);
  assert.equal(validLaneOverrides({ labels: { A: '' } }), null);
  assert.equal(validLaneOverrides({ labels: { A: 'x'.repeat(61) } }), null);
  assert.equal(validLaneOverrides({ labels: { A: '<b>' } }), null);
  assert.equal(validLaneOverrides({ merge: { A: 'B C' } }), null);
  assert.equal(validLaneOverrides({ assign: { 'WORK-1': 7 } }), null);
});

test('读取器：事件聚合为每项首次与最近活动时间，快照附带编号分组', async (t) => {
  const fixture = await createReaderFixture({ works: [{ key: 'STREAM-1', status: 'completed' }, { key: 'STREAM-2', status: 'in_progress' }, { key: 'KB-1' }] });
  t.after(() => fixture.dispose());
  addEvents(fixture, [{ key: 'STREAM-1', at: 1000 }, { key: 'STREAM-1', at: 3000 }, { key: 'STREAM-2', at: 2000 },
    { key: null, at: 9999, type: 'source.projected' }]);
  const snapshot = await readSnapshot(fixture.root, { now: 5000 });
  const byKey = Object.fromEntries(snapshot.nodes.map((item) => [item.key, item]));
  assert.deepEqual(byKey['STREAM-1'].activity, { firstAt: 1000, lastAt: 3000, events: 2 });
  assert.deepEqual(byKey['STREAM-2'].activity, { firstAt: 2000, lastAt: 2000, events: 1 });
  assert.equal(byKey['KB-1'].activity, null);
  assert.deepEqual(snapshot.lanes.map((lane) => [lane.key, lane.firstAt, lane.lastAt]), [['STREAM', 1000, 3000], ['~scattered', null, null]]);
});

test('读取器：没有事件表时时间线为空但快照照常可读', async (t) => {
  const fixture = await createReaderFixture({ works: [{ key: 'A-1' }, { key: 'A-2' }] });
  t.after(() => fixture.dispose());
  const snapshot = await readSnapshot(fixture.root, { now: 5000 });
  assert.ok(snapshot.nodes.every((item) => item.activity === null));
  assert.deepEqual(snapshot.lanes.map((lane) => lane.key), ['A']);
});

test('读取器：数据库未变命中缓存时仍按本次传入的覆盖重算分组', async (t) => {
  const fixture = await createReaderFixture({ works: [{ key: 'A-1' }, { key: 'A-2' }] });
  t.after(() => fixture.dispose());
  const first = await readSnapshot(fixture.root, { now: 5000 });
  const renamed = await readSnapshot(fixture.root, { now: 5000, laneOverrides: { labels: { A: '甲组' }, merge: {}, assign: {} } });
  assert.equal(renamed.updatedAt, first.updatedAt);
  assert.equal(renamed.lanes[0].label, '甲组');
  assert.equal(first.lanes[0].label, 'A');
});

test('登记清单：可选 lanes 经校验后保留，结构错误使整份清单无效', async (t) => {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'awr-dashboard-lanes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'projects.json');
  const root = path.join(directory, 'project');
  await writeFile(filename, JSON.stringify({ version: 1, defaultProjectId: null,
    projects: [{ id: 'a', name: 'A', root, lanes: { labels: { INTERCOM: '业务二期' } } }, { id: 'b', name: 'B', root }] }));
  const value = await readProjectRegistry(filename);
  assert.deepEqual(value.projects[0].lanes, { labels: { INTERCOM: '业务二期' }, merge: {}, assign: {} });
  assert.equal(Object.hasOwn(value.projects[1], 'lanes'), false);
  await writeFile(filename, JSON.stringify({ version: 1, defaultProjectId: null, projects: [{ id: 'a', name: 'A', root, lanes: { bad: {} } }] }));
  await assert.rejects(readProjectRegistry(filename), { code: 'REGISTRY_INVALID' });
});
