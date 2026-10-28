import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentObserver, compileProbe } from '../src/agent-observer.js';
import { createDashboardServer } from '../src/server.js';
import { EVIDENCE_GAP_GRACE_MS, OBSERVATION_MAX_AGE_MS, SCAN_TIMEOUT_MS, PROBE_SLEEP_MS, EXECUTING_HOLD_MS, runningWorkIds } from '../src/agent-running.js';
import { NATIVE_FIXTURE } from './agent-running-fixture.mjs';

/** 显式IPC夹具只检验管理器生命周期，不伪装为Windows客户端实测。 */
function fakeProcess() {
  const p = new EventEmitter();p.pid = 71001;p.exitCode = null;p.signalCode = null;
  p.stdin = new PassThrough();p.stdout = new PassThrough();p.stderr = new PassThrough();
  p.kill = () => { if (p.exitCode === null) {p.exitCode = 0;p.emit('exit', 0);} };
  p.stdin.once('finish', p.kill);return p;
}
/** 等待受控观察条件并有界失败，不依赖整机进程列表。 */
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('observation timeout');
}

test('失败后的缺证只在宽限内保留上一份成功观察，旧代迟到肯定不能覆盖', async () => {
  let now = 1_700_000_000_000; const children = [];
  const o = createAgentObserver({ factory: async () => { const p = fakeProcess();children.push(p);return p; }, restartMs: 20, clock: () => now });
  try {
    o.start();assert.equal(o.latest(), null);await until(() => children.length === 1);
    await new Promise(r => setTimeout(r, 0));
    const sample = { type: 'sample', ok: true, sampledAt: now, processes: [] };
    children[0].stdout.write(`${JSON.stringify(sample)}\n`);assert.equal(o.latest().sampledAt, now);
    children[0].stdout.write(`${JSON.stringify({ ...sample, ok: false })}\n`);assert.equal(o.latest().sampledAt, now);
    children[0].stdout.write('invalid\n');assert.equal(o.latest().sampledAt, now);
    await until(() => children.length === 2);
    children[0].stdout.write(`${JSON.stringify({ ...sample, sampledAt: now + 1 })}\n`);assert.equal(o.latest().sampledAt, now);
    now += EVIDENCE_GAP_GRACE_MS;assert.equal(o.latest().sampledAt, now - EVIDENCE_GAP_GRACE_MS);
    now += 1;assert.equal(o.latest(), null);
  } finally {await o.stop();}
  assert.ok(children.every(p => p.exitCode === 0));
});
test('扫描超时和崩溃自动重拉，服务stop不再重启', async () => {
  const children = [];let stopped = false;
  const o = createAgentObserver({ factory: async () => {const p = fakeProcess();children.push(p);return p;}, scanTimeoutMs: 30, restartMs: 10 });
  try {
    o.start();await until(() => children.length === 1);await new Promise(r => setTimeout(r, 0));
    children[0].stdout.write('{"type":"scan-start"}\n');await until(() => children.length === 2);
    children[1].kill();await until(() => children.length === 3);
    await o.stop();stopped = true;const count = children.length;
    await new Promise(r => setTimeout(r, 70));assert.equal(children.length, count);assert.equal(o.latest(), null);
  } finally {if (!stopped) await o.stop();}
});
test('时间经过使最近结果失效，不等待下一个请求或探针事件', async () => {
  let now = 1_700_000_000_000;const started = now;const p = fakeProcess();const o = createAgentObserver({ factory: async () => p, clock: () => now });
  try {
    o.start();await new Promise(r => setTimeout(r, 0));
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: true, sampledAt: now, processes: [] })}\n`);
    assert.ok(o.latest());
    now = started + SCAN_TIMEOUT_MS + PROBE_SLEEP_MS;assert.ok(o.latest());
    now = started + OBSERVATION_MAX_AGE_MS;assert.equal(o.latest(), null);
  } finally {await o.stop();}
});
test('扫描超时造成的缺证在宽限内不拆掉上一份成功观察', async () => {
  let now = 1_700_000_000_000;const children = [];const scanTimeoutMs = 30;
  const o = createAgentObserver({ factory: async () => {const p = fakeProcess();children.push(p);return p;}, scanTimeoutMs, restartMs: 10, clock: () => now });
  try {
    o.start();await until(() => children.length === 1);await new Promise(r => setTimeout(r, 0));
    children[0].stdout.write(`${JSON.stringify({ type: 'sample', ok: true, sampledAt: now, processes: [] })}\n`);
    assert.equal(o.latest().sampledAt, now);
    children[0].stdout.write('{"type":"scan-start"}\n');await until(() => children.length === 2);
    assert.equal(o.latest().sampledAt, now);
    now += scanTimeoutMs + 500;assert.equal(o.latest().sampledAt, now - (scanTimeoutMs + 500));
    now += 1;assert.equal(o.latest(), null);
  } finally {await o.stop();}
});
test('停止期间尚未完成的启动也必须收回，不能留下迟到探针', async () => {
  const p = fakeProcess();let release;const launched = new Promise(r => {release = r;});
  const o = createAgentObserver({factory: () => launched});o.start();await new Promise(r => setTimeout(r, 0));
  const stopping = o.stop();release(p);await stopping;assert.equal(p.exitCode, 0);
});

test('HTTP服务监听才启动观察，服务关闭清空并等待所属观察器退出', async () => {
  let started = 0;let stopped = 0;
  const observer = {start(){started += 1;},latest(){return null;},async stop(){await new Promise(r=>setTimeout(r,15));stopped += 1;}};
  const server = createDashboardServer({projectRoot:path.resolve('fixture'),agentObserver:observer,snapshotReader:async()=>({version:1})});
  assert.equal(started,0);await new Promise(r=>server.listen(0,'127.0.0.1',r));assert.equal(started,1);
  await new Promise(r=>server.close(r));await server.agentObserverStopped;assert.equal(stopped,1);assert.equal(server.listening,false);
});

test('Windows真实常驻探针复用散列缓存、只查询空白名单并在stop后退出', {skip: process.platform !== 'win32', timeout: 30000}, async () => {
  const cacheBase = await mkdtemp(path.join(os.tmpdir(), 'awr-probe-cache-test-'));let observer;
  try {
    const first = await compileProbe({cacheBase});assert.equal(first.cached, false);
    const bytes = await readFile(first.executable);const again = await compileProbe({cacheBase});assert.equal(again.cached, true);
    assert.deepEqual(await readFile(again.executable), bytes);
    let sample;let pid;
    observer = createAgentObserver({ options: {processIds: [], cacheBase}, onSample: value => {sample = value;}, onProcess: value => {pid = value;} });
    observer.start();await until(() => sample, 15000);
    assert.equal(sample.ok, true);assert.deepEqual(sample.processes, []);assert.ok(pid > 0);
    await observer.stop();observer = null;
    assert.throws(() => process.kill(pid, 0));
  } finally {await observer?.stop();await rm(cacheBase, {recursive:true, force:true});}
});

/** 注入时钟下的执行样本。pid 不对应真实进程，存活由测试替身回答。 */
function executingSample(now, patch = {}) {
  return { type: 'sample', ok: true, sampledAt: now, processes: [{ pid: 4242, client: 'codex', createdAt: now - 5000, alive: true,
    sessions: [{ id: NATIVE_FIXTURE, state: 'executing', startedAt: now - 1000 }], ...patch }] };
}
function works(observation, now, client = 'codex') {
  if (!observation) return new Set();
  return runningWorkIds({ now, observation, resumptions: [],
    sessions: [{ id: 's0', workId: 'a', status: 'active', endedAt: null }],
    bindings: [{ client, externalSession: client === 'codex' ? NATIVE_FIXTURE : NATIVE_FIXTURE, sessionId: 's0' }] });
}
test('执行中连续 30 次采样失败且跨过 60 秒不灭，超过持有上限才灭', async () => {
  let now = 1_700_000_000_000; const started = now; const p = fakeProcess();
  const o = createAgentObserver({ factory: async () => p, clock: () => now, restartMs: 60000, pidAlive: () => true, readClaudeStatus: async () => null });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    p.stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    assert.equal(works(o.latest(), now).size, 1);
    for (let i = 0; i < 30; i += 1) {
      now += 2000;
      p.stdout.write(`${JSON.stringify({ type: 'sample', ok: false, sampledAt: now, processes: [] })}\n`);
      const latest = o.latest();
      assert.ok(latest, `第 ${i + 1} 次缺口不应灭灯`);
      assert.equal(works(latest, now).size, 1);
    }
    assert.ok(now - started >= 60000);
    now = started + EXECUTING_HOLD_MS + 1;
    assert.equal(o.latest(), null);
  } finally { await o.stop(); }
});
test('turn_ended 和 alive:false 在持有窗口内熄灭', async () => {
  let now = 1_700_000_000_000; const p = fakeProcess();
  const o = createAgentObserver({ factory: async () => p, clock: () => now, pidAlive: () => true, readClaudeStatus: async () => null });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    p.stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    now += 5000;
    assert.equal(works(o.latest(), now).size, 1);
    const ended = executingSample(now); ended.processes[0].sessions[0].state = 'ended';
    p.stdout.write(`${JSON.stringify(ended)}\n`);
    assert.equal(works(o.latest(), now).size, 0);
    p.stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    now += 5000;
    const dead = executingSample(now); dead.processes[0].alive = false;
    p.stdout.write(`${JSON.stringify(dead)}\n`);
    assert.equal(works(o.latest(), now).size, 0);
  } finally { await o.stop(); }
});
test('进程退出后下一次读取立即熄灭，不等持有到期', async () => {
  let now = 1_700_000_000_000; let alive = true; const p = fakeProcess();
  const o = createAgentObserver({ factory: async () => p, clock: () => now, pidAlive: () => alive, readClaudeStatus: async () => null });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    p.stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    assert.equal(works(o.latest(), now).size, 1);
    alive = false;
    assert.equal(works(o.latest(), now).size, 0);
  } finally { await o.stop(); }
});
test('Claude 文件仍为 busy 时持有超过 90 秒不灭，变为非 busy 后立即灭', async () => {
  let now = 1_700_000_000_000; const started = now; let status = 'busy'; let reads = 0; const p = fakeProcess();
  const sample = executingSample(now); sample.processes[0].client = 'claude';
  const o = createAgentObserver({ factory: async () => p, clock: () => now, restartMs: 60000, pidAlive: () => true,
    readClaudeStatus: async () => { reads += 1; return status; } });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    p.stdout.write(`${JSON.stringify(sample)}\n`);
    now += 80000;
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: false, sampledAt: now, processes: [] })}\n`);
    await until(() => reads >= 1);
    now = started + 160000;
    assert.equal(works(o.latest(), now, 'generic').size, 1);
    status = 'idle'; now += 1000;
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: false, sampledAt: now, processes: [] })}\n`);
    await until(() => reads >= 2);
    const latest = o.latest();
    assert.equal(latest ? works(latest, now, 'generic').size : 0, 0);
  } finally { await o.stop(); }
});
test('快照空样本保留未提及的执行进程，且不把持有起点重置成现在', async () => {
  let now = 1_700_000_000_000; const started = now; const p = fakeProcess();
  const o = createAgentObserver({ factory: async () => p, clock: () => now, scanTimeoutMs: 30000, pidAlive: () => true, readClaudeStatus: async () => null });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    const sample = executingSample(now); sample.phase = 'full';
    p.stdout.write(`${JSON.stringify(sample)}\n`);
    now += 1000;
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: true, phase: 'fast', covered: false, sampledAt: now, processes: [] })}\n`);
    assert.equal(o.latest().processes.some(process => process.pid === 4242), true);
    now = started + EXECUTING_HOLD_MS + 1;
    assert.equal(o.latest(), null);
  } finally { await o.stop(); }
});
test('Claude busy 快照会刷新持有，墓碑和完整空样本会熄灭', async () => {
  let now = 1_700_000_000_000; const started = now; const p = fakeProcess();
  const o = createAgentObserver({ factory: async () => p, clock: () => now, scanTimeoutMs: 30000, pidAlive: () => true, readClaudeStatus: async () => null });
  try {
    o.start(); await new Promise(r => setTimeout(r, 0));
    const sample = executingSample(now); sample.phase = 'full';
    p.stdout.write(`${JSON.stringify(sample)}\n`);
    now = started + 80000;
    const child = '99999999-1111-2222-3333-444444444444';
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: true, phase: 'fast', covered: false, sampledAt: now, processes: [
      { pid: 99, client: 'claude', createdAt: now - 1000, alive: true, sessions: [{ id: child, state: 'executing', startedAt: now - 500 }] },
    ] })}\n`);
    now = started + 160000;
    assert.equal(works(o.latest(), now).size, 1);
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: true, phase: 'fast', covered: false, sampledAt: now, processes: [
      { pid: 4242, alive: false, client: 'codex', createdAt: 1, sessions: [] },
    ] })}\n`);
    assert.equal(works(o.latest(), now).size, 0);
    p.stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    p.stdout.write(`${JSON.stringify({ type: 'sample', ok: true, phase: 'full', sampledAt: now, processes: [] })}\n`);
    assert.equal(works(o.latest(), now).size, 0);
  } finally { await o.stop(); }
});
test('已有执行样本时，短扫描时限内的 scan-start 不拆探针，光环仍在', async () => {
  const children = []; let now = 1_700_000_000_000;
  const o = createAgentObserver({ factory: async () => { const child = fakeProcess(); children.push(child); return child; },
    scanTimeoutMs: 30, restartMs: 10, clock: () => now, pidAlive: () => true, readClaudeStatus: async () => null });
  try {
    o.start(); await until(() => children.length === 1); await new Promise(r => setTimeout(r, 0));
    children[0].stdout.write(`${JSON.stringify(executingSample(now))}\n`);
    children[0].stdout.write('{"type":"scan-start"}\n');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(children.length, 1);
    now += 5000;
    assert.equal(works(o.latest(), now).size, 1);
  } finally { await o.stop(); }
});
