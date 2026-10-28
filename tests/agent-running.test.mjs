import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readSnapshot } from '../src/reader.js';
import { runningWorkIds, evaluateAgentRunning, observationIsFresh, OBSERVATION_MAX_AGE_MS, SCAN_TIMEOUT_MS, PROBE_SLEEP_MS, EVIDENCE_GAP_GRACE_MS, EXECUTING_HOLD_MS } from '../src/agent-running.js';
import { createRunningFixture, NATIVE_FIXTURE } from './agent-running-fixture.mjs';
import { fixtureFileBaseline, fixtureId, updateFixtureWork } from './reader-fixture.mjs';

/** 每个关联测试独占投影，所有写连接只在临时夹具内。 */
async function fixtureFor(t, options) { const f = await createRunningFixture(options); t.after(() => f.dispose()); return f; }
/** 读取完整产品快照，显式观察替代任何本机进程扫描。 */
function snapshot(f, observation = f.observation()) { return readSnapshot(f.root, { now: f.now, agentObservation: observation }); }
/** 同一夹具上换观察或只改台账时，拨动数据库 mtime，避免命中快照缓存。 */
async function bumpDatabaseStamp(root) {
  const filename = path.join(root, '.awr', 'state.db');
  const info = await lstat(filename);
  const next = new Date(Number(info.mtimeMs) + 1000);
  await utimes(filename, next, next);
}

test('无runner目录、无领取仍可通过原生绑定和回合活动显示，原文件全等', async t => {
  const f = await fixtureFor(t); const before = await fixtureFileBaseline(f.root);
  const value = await snapshot(f);
  assert.equal(value.nodes[0].agentRunningUntil, f.now + 15000);
  assert.equal(value.nodes[0].runnerPaths, undefined);
  assert.equal(value.counts.inProgress, 1);
  assert.deepEqual(await fixtureFileBaseline(f.root), before);
});
test('领取过期、释放或缺失均不阻断真实回合关联', async t => {
  const f = await fixtureFor(t, { claims: true, expiresAt: Date.now() - 60000 });
  assert.notEqual((await snapshot(f)).nodes[0].agentRunningUntil, null);
  f.db.exec("UPDATE claims SET status='released',released_at=100;");
  assert.notEqual((await snapshot(f)).nodes[0].agentRunningUntil, null);
});
for (const state of ['ended', 'idle', 'unknown']) test(`进程仍活但原生状态${state}不亮`, async t => {
  const f = await fixtureFor(t); assert.equal((await snapshot(f, f.observation(state))).nodes[0].agentRunningUntil, null);
});
for (const status of ['planned', 'completed', 'blocked', 'cancelled']) test(`来源工作${status}不亮`, async t => {
  const f = await fixtureFor(t); updateFixtureWork(f, 'A', { status, raw_status: status });
  assert.equal((await snapshot(f)).nodes[0].agentRunningUntil, null);
});
test('来源过期、观察缺失、失败、过旧以及未来时间均不亮', async t => {
  const f = await fixtureFor(t);
  for (const o of [null, { ...f.observation(), ok: false }, f.observation('executing', f.now - OBSERVATION_MAX_AGE_MS), f.observation('executing', f.now + 1)]) {
    await bumpDatabaseStamp(f.root);
    assert.equal((await snapshot(f, o)).nodes[0].agentRunningUntil, null);
  }
  await writeFile(path.join(f.root, 'ledger.yaml'), 'work_items: []\n# changed\n');
  await bumpDatabaseStamp(f.root);
  assert.equal((await snapshot(f)).nodes[0].agentRunningUntil, null);
});
test('无绑定及同目录其他任务均不凭活进程补猜', async t => {
  const f = await fixtureFor(t); f.db.exec('DELETE FROM events');
  assert.equal((await snapshot(f)).nodes[0].agentRunningUntil, null);
});
test('ended祖先绑定沿同工作官方恢复链达到active后继可亮，不需要后继重新bind', async t => {
  const f = await fixtureFor(t); const successor = fixtureId(501);
  f.db.exec("UPDATE sessions SET status='ended',ended_at=100;");
  assert.equal((await snapshot(f)).nodes[0].agentRunningUntil, null);
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(successor, f.projectId, 'active', f.workIds.get('A'), f.now - 500, null);
  f.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(f.projectId, 'session.resumed_from', JSON.stringify({ from_session_id: f.session, to_session_id: successor }), 2);
  assert.notEqual((await snapshot(f)).nodes[0].agentRunningUntil, null);
  f.db.exec("UPDATE sessions SET status='ended',ended_at=200;");
  assert.equal((await snapshot(f)).nodes[0].agentRunningUntil, null);
});
test('可选活动元数据损坏只关闭光环，不破坏原图', async t => {
  const f = await fixtureFor(t); f.db.exec("UPDATE events SET payload_json='{broken';");
  const result = await snapshot(f); assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0].agentRunningUntil, null);
});

/** 直接构造身份图以覆盖SQL无关的冲突、别名与共享宿主边界。 */
function identityGraph() {
  const now = Date.now(); return { now,
    sessions: [{ id: 's0', workId: 'a', status: 'active', endedAt: null }],
    bindings: [{ client: 'codex', externalSession: NATIVE_FIXTURE, sessionId: 's0' }],
    resumptions: [], observation: { ok: true, sampledAt: now, processes: [{ pid: 11, client: 'codex', createdAt: now - 5000, alive: true,
      sessions: [{ id: NATIVE_FIXTURE, state: 'executing', startedAt: now - 1000 }] }] } };
}
test('一个共享宿主的多个rollout逐会话判断，结束项不继承活动', () => {
  const g = identityGraph(); const second = '99999999-1111-2222-3333-444444444444';
  g.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
  g.bindings.push({ client: 'codex', externalSession: second, sessionId: 's1' });
  g.observation.processes[0].sessions.push({ id: second, state: 'ended', startedAt: g.now - 1000 });
  assert.deepEqual([...runningWorkIds(g)], ['a']);
});
test('同一原生完整键对应不同工作时双方都不亮', () => {
  const g = identityGraph(); g.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
  g.bindings.push({ ...g.bindings[0], sessionId: 's1' }); assert.equal(runningWorkIds(g).size, 0);
});
test('跨工作恢复边、循环和未知端点均不产生肯定', () => {
  for (const resumptions of [[{ from: 's0', to: 's1' }], [{ from: 's0', to: 's0' }], [{ from: 's0', to: 'missing' }]]) {
    const g = identityGraph(); g.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null }); g.resumptions = resumptions;
    assert.equal(runningWorkIds(g).size, 0);
  }
});
test('Claude注册表原生号与真实local_宿主别名不同，仍可匹配已有generic绑定', () => {
  const g = identityGraph(); const host = 'local_99999999-1111-2222-3333-444444444444';
  g.bindings[0] = { client: 'generic', externalSession: `claude-code:${host}`, sessionId: 's0' };
  g.observation.processes[0].client = 'claude';g.observation.processes[0].sessions[0].hostSessionId = host;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  delete g.observation.processes[0].sessions[0].hostSessionId;
  assert.equal(runningWorkIds(g).size, 0);
});
test('Grok完整generic键和原生身份相等时可匹配，未知前缀拒绝', () => {
  const g = identityGraph(); g.observation.processes[0].client = 'grok';
  g.bindings[0].client = 'generic';g.bindings[0].externalSession = `grok:${NATIVE_FIXTURE}`;
  assert.deepEqual([...runningWorkIds(g)], ['a']);g.bindings[0].externalSession = `other:${NATIVE_FIXTURE}`;
  assert.equal(runningWorkIds(g).size, 0);
});
test('裸UUID通用绑定可匹配正在执行的Claude原生会话，覆盖TRAPPED-DOOR-5FRAME-20261023', () => {
  const g = identityGraph(); const session = 'e3b2775b-2b37-44c6-81f3-73c6ccb55160';
  g.bindings[0] = { client: 'generic', externalSession: session, sessionId: 's0' };
  g.observation.processes[0] = { pid: 48636, client: 'claude', createdAt: g.now - 5000, alive: true,
    sessions: [{ id: session, state: 'executing', startedAt: g.now - 1000 }] };
  assert.deepEqual([...runningWorkIds(g)], ['a']);
});
test('裸UUID通用绑定可匹配正在执行的Grok原生会话', () => {
  const g = identityGraph();
  g.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  g.observation.processes[0].client = 'grok';
  assert.deepEqual([...runningWorkIds(g)], ['a']);
});
test('裸UUID的两个候选命中不同存活进程时不亮', () => {
  const g = identityGraph();
  g.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  const session = { id: NATIVE_FIXTURE, state: 'executing', startedAt: g.now - 1000 };
  g.observation.processes = [
    { pid: 48636, client: 'claude', createdAt: g.now - 5000, alive: true, sessions: [{ ...session }] },
    { pid: 48637, client: 'grok', createdAt: g.now - 4000, alive: true, sessions: [{ ...session }] },
  ];
  assert.equal(runningWorkIds(g).size, 0);
});
test('已带前缀的通用绑定不因裸UUID规则扩展到另一个客户端', () => {
  const g = identityGraph(); const host = 'local_99999999-1111-2222-3333-444444444444';
  g.bindings[0] = { client: 'generic', externalSession: `claude-code:${host}`, sessionId: 's0' };
  g.observation.processes[0].client = 'grok';
  assert.equal(runningWorkIds(g).size, 0);
  g.observation.processes[0].client = 'claude'; g.observation.processes[0].sessions[0].hostSessionId = host;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  g.bindings[0].externalSession = `grok:${NATIVE_FIXTURE}`; delete g.observation.processes[0].sessions[0].hostSessionId;
  assert.equal(runningWorkIds(g).size, 0);
  g.observation.processes[0].client = 'grok';
  assert.deepEqual([...runningWorkIds(g)], ['a']);
});
test('非UUID裸字符串不扩展为客户端候选', () => {
  const g = identityGraph();
  g.bindings[0] = { client: 'generic', externalSession: 'session-not-a-uuid', sessionId: 's0' };
  g.observation.processes[0].client = 'claude';
  assert.equal(runningWorkIds(g).size, 0);
  g.observation.processes[0].client = 'grok';
  assert.equal(runningWorkIds(g).size, 0);
});
test('裸UUID命中的进程回合未执行时不亮', () => {
  const g = identityGraph();
  g.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  g.observation.processes[0].client = 'claude';
  g.observation.processes[0].sessions[0].state = 'idle';
  assert.equal(runningWorkIds(g).size, 0);
});
test('进程退出、创建时间不符的旧开始事件、无效id和未来活动均关闭', () => {
  for (const change of [g => {g.observation.processes[0].alive = false;},
    g => {g.observation.processes[0].sessions[0].startedAt = g.now - 10000;},
    g => {g.observation.processes[0].sessions[0].id = 'unproved';},
    g => {g.observation.processes[0].sessions[0].startedAt = g.now + 1;}]) {
    const g = identityGraph(); change(g); assert.equal(runningWorkIds(g).size, 0);
  }
});
test('肯定结果的有效期来自原生采样，不受claim期限裁剪', () => {
  const g = identityGraph(); const running = runningWorkIds(g);
  assert.equal(evaluateAgentRunning({ work: { id: 'a', status: 'in_progress', current: true, claims: [] }, running, observation: g.observation, now: g.now }), g.now + 15000);
  assert.equal(observationIsFresh(g.observation, g.now + OBSERVATION_MAX_AGE_MS), false);
});
test('新鲜期严格长于扫描超时加探针休眠，慢成功扫描仍算新鲜', () => {
  assert.ok(OBSERVATION_MAX_AGE_MS > SCAN_TIMEOUT_MS + PROBE_SLEEP_MS);
  assert.equal(EVIDENCE_GAP_GRACE_MS, SCAN_TIMEOUT_MS + 500);
  assert.equal(PROBE_SLEEP_MS, 25 * 20);
  const probe = readFileSync(new URL('../src/agent-process-windows.cs', import.meta.url), 'utf8');
  assert.match(probe, /const int ProbeSleepSliceMs=20;/);
  assert.match(probe, /const int ProbeSleepSlices=25;/);
  assert.match(probe, /evidenceGraceMs/);
  assert.match(probe, /executingHoldMs/);
  assert.match(probe, /forked_from_id/);
  assert.match(probe, /parentId/);
  assert.match(probe, /static string ForkParent/);
  assert.match(probe, /--resume-session-at/);
  assert.match(probe, /--fork-session/);
  assert.match(probe, /scan-hold/);
  assert.match(probe, /"phase","fast"/);
  const g = identityGraph();
  const slow = g.now - (SCAN_TIMEOUT_MS + PROBE_SLEEP_MS);
  g.observation.sampledAt = slow;
  g.observation.processes[0].createdAt = slow - 5000;
  g.observation.processes[0].sessions[0].startedAt = slow - 1000;
  assert.equal(observationIsFresh(g.observation, g.now), true);
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  assert.equal(evaluateAgentRunning({ work: { id: 'a', status: 'in_progress', current: true }, running: runningWorkIds(g), observation: g.observation, now: g.now }), slow + 15000);
});
test('回合未结束的缺证在宽限内保持，超过宽限、turn_ended、进程退出或歧义则熄灭', () => {
  const g = identityGraph();
  g.observation.processes[0].client = 'grok';
  g.bindings[0] = { client: 'generic', externalSession: `grok:${NATIVE_FIXTURE}`, sessionId: 's0' };
  const session = g.observation.processes[0].sessions[0];
  session.evidence = 'held';
  session.evidenceAt = g.now - EVIDENCE_GAP_GRACE_MS;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  session.evidenceAt = g.now - EVIDENCE_GAP_GRACE_MS - 1;
  assert.equal(runningWorkIds(g).size, 0);
  session.evidenceAt = g.now - 1000;
  session.state = 'ended';
  assert.equal(runningWorkIds(g).size, 0);
  session.state = 'executing';
  g.observation.processes[0].alive = false;
  assert.equal(runningWorkIds(g).size, 0);
  g.observation.processes[0].alive = true;
  const other = { ...session, evidence: 'held', evidenceAt: g.now - 1000 };
  g.observation.processes = [
    { pid: 48636, client: 'claude', createdAt: g.now - 5000, alive: true, sessions: [{ ...other }] },
    { pid: 48637, client: 'grok', createdAt: g.now - 4000, alive: true, sessions: [{ ...other }] },
  ];
  g.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  assert.equal(runningWorkIds(g).size, 0);
});
test('扫描缺口的 scan-hold 覆盖 60 秒，超过持有、回合结束或进程退出则熄灭', () => {
  const g = identityGraph();
  const session = g.observation.processes[0].sessions[0];
  session.evidence = 'scan-hold';
  session.evidenceAt = g.now - 60000;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  session.evidenceAt = g.now - EXECUTING_HOLD_MS;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  session.evidenceAt = g.now - EXECUTING_HOLD_MS - 1;
  assert.equal(runningWorkIds(g).size, 0);
  session.evidenceAt = g.now - 1000;
  session.state = 'ended';
  assert.equal(runningWorkIds(g).size, 0);
  session.state = 'executing';
  g.observation.processes[0].alive = false;
  assert.equal(runningWorkIds(g).size, 0);
});

/** 后继 thread 没有自己的绑定，只带父 UUID。 */
function successorGraph(mutate) {
  const g = identityGraph();
  const child = '99999999-1111-2222-3333-444444444444';
  g.observation.processes[0].sessions = [{ id: child, state: 'executing', startedAt: g.now - 1000, parentId: NATIVE_FIXTURE }];
  mutate?.(g, child);
  return g;
}
test('Codex 后继 thread 继承同一工作里已绑定的前驱', () => {
  assert.deepEqual([...runningWorkIds(successorGraph())], ['a']);
});
test('后继结束、进程退出、没有父绑定或父绑定已换成其他 UUID 时不亮', () => {
  const ended = successorGraph(g => { g.observation.processes[0].sessions[0].state = 'ended'; });
  assert.equal(runningWorkIds(ended).size, 0);
  const dead = successorGraph(g => { g.observation.processes[0].alive = false; });
  assert.equal(runningWorkIds(dead).size, 0);
  const unbound = successorGraph(g => { g.bindings = []; });
  assert.equal(runningWorkIds(unbound).size, 0);
  const rebound = successorGraph(g => { g.bindings[0].externalSession = '77777777-1111-2222-3333-444444444444'; });
  assert.equal(runningWorkIds(rebound).size, 0);
  const selfParent = successorGraph(g => { g.observation.processes[0].sessions[0].parentId = g.observation.processes[0].sessions[0].id; });
  assert.equal(runningWorkIds(selfParent).size, 0);
});
test('后继已经直接绑到别的工作时只亮那个工作，不继承前驱', () => {
  const g = successorGraph((graph, child) => {
    graph.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
    graph.bindings.push({ client: 'codex', externalSession: child, sessionId: 's1' });
  });
  assert.deepEqual([...runningWorkIds(g)], ['b']);
});
test('前驱绑定同时属于两个工作时后继不亮', () => {
  const g = successorGraph(graph => {
    graph.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
    graph.bindings.push({ client: 'codex', externalSession: NATIVE_FIXTURE, sessionId: 's1' });
  });
  assert.equal(runningWorkIds(g).size, 0);
});
test('两跳父链可以继承，第八跳仍可继承，第九跳和跨客户端不继承', () => {
  const mid = '88888888-1111-2222-3333-444444444444';
  const two = successorGraph(graph => {
    graph.observation.processes[0].sessions[0].parentId = mid;
    graph.observation.processes[0].sessions.push({ id: mid, state: 'ended', startedAt: graph.now - 2000, parentId: NATIVE_FIXTURE });
  });
  assert.deepEqual([...runningWorkIds(two)], ['a']);
  function chain(hops) {
    const deep = identityGraph();
    let current = NATIVE_FIXTURE;
    const sessions = [];
    for (let i = 0; i < hops; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      sessions.push({ id, state: i === hops - 1 ? 'executing' : 'ended', startedAt: deep.now - 1000, parentId: current });
      current = id;
    }
    deep.observation.processes[0].sessions = sessions;
    return runningWorkIds(deep).size;
  }
  assert.equal(chain(8), 1);
  assert.equal(chain(9), 0);
  const cross = successorGraph(graph => { graph.observation.processes[0].client = 'claude'; });
  assert.equal(runningWorkIds(cross).size, 0);
  const grokCross = successorGraph(graph => { graph.observation.processes[0].client = 'grok'; });
  assert.equal(runningWorkIds(grokCross).size, 0);
});

/** 同客户端父链。Claude 用 claude-code: 前缀，Grok 用 grok: 前缀，避免裸 UUID 同时摊到两个客户端。 */
function clientSuccessor(client) {
  const g = successorGraph();
  g.observation.processes[0].client = client;
  if (client === 'claude') g.bindings[0] = { client: 'generic', externalSession: `claude-code:${NATIVE_FIXTURE}`, sessionId: 's0' };
  if (client === 'grok') g.bindings[0] = { client: 'generic', externalSession: `grok:${NATIVE_FIXTURE}`, sessionId: 's0' };
  return g;
}
function clientChain(client, hops) {
  const deep = clientSuccessor(client);
  let current = NATIVE_FIXTURE;
  const sessions = [];
  for (let i = 0; i < hops; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    sessions.push({ id, state: i === hops - 1 ? 'executing' : 'ended', startedAt: deep.now - 1000, parentId: current });
    current = id;
  }
  deep.observation.processes[0].sessions = sessions;
  return deep;
}
for (const client of ['claude', 'grok']) {
  test(`${client} fork 子 executing 且只绑父时亮，第九跳不亮`, () => {
    assert.deepEqual([...runningWorkIds(clientSuccessor(client))], ['a']);
    assert.equal(runningWorkIds(clientChain(client, 8)).size, 1);
    assert.equal(runningWorkIds(clientChain(client, 9)).size, 0);
  });
  test(`${client} 子已直绑其他工作只亮子工作，父歧义、自指、结束、退出或无绑定不亮`, () => {
    const child = '99999999-1111-2222-3333-444444444444';
    const direct = clientSuccessor(client);
    direct.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
    const prefix = client === 'claude' ? 'claude-code:' : 'grok:';
    direct.bindings.push({ client: 'generic', externalSession: `${prefix}${child}`, sessionId: 's1' });
    assert.deepEqual([...runningWorkIds(direct)], ['b']);
    const ambiguous = clientSuccessor(client);
    ambiguous.sessions.push({ id: 's1', workId: 'b', status: 'active', endedAt: null });
    ambiguous.bindings.push({ client: 'generic', externalSession: `${prefix}${NATIVE_FIXTURE}`, sessionId: 's1' });
    assert.equal(runningWorkIds(ambiguous).size, 0);
    const selfParent = clientSuccessor(client);
    selfParent.observation.processes[0].sessions[0].parentId = selfParent.observation.processes[0].sessions[0].id;
    assert.equal(runningWorkIds(selfParent).size, 0);
    const ended = clientSuccessor(client);
    ended.observation.processes[0].sessions[0].state = 'ended';
    assert.equal(runningWorkIds(ended).size, 0);
    const dead = clientSuccessor(client);
    dead.observation.processes[0].alive = false;
    assert.equal(runningWorkIds(dead).size, 0);
    const unbound = clientSuccessor(client);
    unbound.bindings = [];
    assert.equal(runningWorkIds(unbound).size, 0);
  });
}
test('Claude fork 子继承裸 UUID 父绑定，不能继承 Grok 前缀绑定', () => {
  const bare = successorGraph();
  bare.observation.processes[0].client = 'claude';
  bare.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  assert.deepEqual([...runningWorkIds(bare)], ['a']);
  const otherClient = successorGraph();
  otherClient.observation.processes[0].client = 'claude';
  otherClient.bindings[0] = { client: 'generic', externalSession: `grok:${NATIVE_FIXTURE}`, sessionId: 's0' };
  assert.equal(runningWorkIds(otherClient).size, 0);
});
test('Grok 带 parentId 时继承裸 UUID 父绑定，回合结束不亮', () => {
  const bare = successorGraph();
  bare.observation.processes[0].client = 'grok';
  bare.bindings[0] = { client: 'generic', externalSession: NATIVE_FIXTURE, sessionId: 's0' };
  assert.deepEqual([...runningWorkIds(bare)], ['a']);
  bare.observation.processes[0].sessions[0].state = 'ended';
  assert.equal(runningWorkIds(bare).size, 0);
});
test('Claude fork 子的 scan-hold 在持有期内亮，超过持有不亮', () => {
  const g = clientSuccessor('claude');
  const session = g.observation.processes[0].sessions[0];
  session.evidence = 'scan-hold';
  session.evidenceAt = g.now - 60000;
  assert.deepEqual([...runningWorkIds(g)], ['a']);
  session.evidenceAt = g.now - EXECUTING_HOLD_MS - 1;
  assert.equal(runningWorkIds(g).size, 0);
});
