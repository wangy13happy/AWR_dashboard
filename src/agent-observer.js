import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { observationIsFresh, EVIDENCE_GAP_GRACE_MS, EVIDENCE_GRACE_PAD_MS, SCAN_TIMEOUT_MS, EXECUTING_HOLD_MS } from './agent-running.js';

const sourceFile = fileURLToPath(new URL('./agent-process-windows.cs', import.meta.url));
const run = promisify(execFile);
const powershell = path.join('C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
/** 计算本服务探针源/二进制内容散列，不读取目标客户端配置。 */
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** PowerShell单引号文字转义，路径仅来自本服务自有源和散列缓存，不拼接客户端命令。 */
function quote(value) { return `'${value.replaceAll("'", "''")}'`; }

/** 缓存按源内容分代；每次复用核对清单及二进制散列，拒绝链接和损坏缓存。 */
export async function compileProbe({ cacheBase = path.join(os.tmpdir(), 'awr-dashboard-native-probe') } = {}) {
  const source = await readFile(sourceFile);
  const sourceHash = digest(source);
  const directory = path.join(cacheBase, sourceHash);
  await mkdir(directory, { recursive: true });
  if ((await lstat(cacheBase)).isSymbolicLink() || (await lstat(directory)).isSymbolicLink()) throw new Error('probe_cache_link');
  const executable = path.join(directory, 'probe.exe');
  const manifestFile = path.join(directory, 'manifest.json');
  try {
    const meta = await lstat(executable); const manifestMeta = await lstat(manifestFile);
    if (!meta.isFile() || meta.isSymbolicLink() || !manifestMeta.isFile() || manifestMeta.isSymbolicLink()
      || manifestMeta.size > 4096 || meta.size > 2 * 1024 * 1024) throw new Error('cache');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.sourceHash === sourceHash && manifest.binaryHash === digest(await readFile(executable))) return { executable, sourceHash, cached: true };
  } catch { /* 缺失或损坏只触发本缓存重新编译，绝不运行未核验的二进制。 */ }
  const temporary = path.join(directory, `${process.pid}-${randomUUID()}.exe`);
  const sourceCopy = path.join(cacheBase, `${process.pid}-${randomUUID()}.cs`);
  // 编译已散列的原字节副本，避免代码在hash之后被替换却生成挂在旧hash下的缓存。
  await writeFile(sourceCopy, source, { flag: 'wx' });
  const script = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(sourceCopy)},[Text.Encoding]::UTF8)) -OutputAssembly ${quote(temporary)} -OutputType ConsoleApplication -ReferencedAssemblies System.dll,System.Management.dll,System.Web.Extensions.dll`;
  try {
    await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 });
  } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
  finally { await rm(sourceCopy, { force: true }); }
  const binaryHash = digest(await readFile(temporary));
  await rename(temporary, executable);
  const manifestTemp = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  await writeFile(manifestTemp, JSON.stringify({ sourceHash, binaryHash }), { flag: 'wx' });
  await rename(manifestTemp, manifestFile);
  return { executable, sourceHash, cached: false };
}

/** 已确认执行中的进程，允许慢扫描跑完再报 turn_ended；短超时测试不带执行样本，仍走原预算。 */
const SLOW_SCAN_BUDGET_MS = 30000;
/** Claude 旁路确认的最短间隔，避免每次快照都读会话文件。 */
const CLAUDE_CONFIRM_GAP_MS = 500;

/**
 * 只读 Claude 会话注册表。短超时、拒绝链接、限制体积。
 * 读失败返回 null，调用方不得据此把仍存活的 busy 进程判成回合结束。
 */
export async function readClaudeSessionStatus(pid, processInfo = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
  let info;
  try { info = await lstat(file); } catch { return null; }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > 32768) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  timer.unref?.();
  try {
    const parsed = JSON.parse(await readFile(file, { encoding: 'utf8', signal: controller.signal }));
    if (Number(parsed?.pid) !== pid) return null;
    if (processInfo.procStart != null && parsed?.procStart != null && String(parsed.procStart) !== String(processInfo.procStart)) return null;
    return typeof parsed?.status === 'string' ? parsed.status : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * 进程是否仍存在。EPERM 表示存在但无权发信号，仍算存活。
 * 只用于扫描缺口期间的持有判断，不作为首次发现进程的证据。
 */
function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/** 自有进程白名单仅供隔离验证，读取本服务显式测试配置，不读目标进程环境。 */
function testPids() {
  if (!Object.hasOwn(process.env, 'AWR_DASHBOARD_PROBE_PIDS')) return null;
  const ids = JSON.parse(process.env.AWR_DASHBOARD_PROBE_PIDS);
  if (!Array.isArray(ids) || ids.length > 256 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('probe_test_ids');
  return ids;
}

/** 启动经校验的常驻本地探针；stdin是父进程生命线，关闭/父进程退出即结束探针。 */
export async function launchProbe({ processIds = testPids(), home = os.homedir(), cacheBase } = {}) {
  const prepareStarted = performance.now();
  const compiled = await compileProbe({ cacheBase });
  const child = spawn(compiled.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => {}); // 在异步工厂返回前也不能出现未处理的spawn错误。
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ pids: processIds, codexSessions: path.join(home, '.codex/sessions'),
    grokSessions: path.join(home, '.grok/sessions'), claudeRegistry: path.join(home, '.claude/sessions'),
    evidenceGraceMs: EVIDENCE_GAP_GRACE_MS, executingHoldMs: EXECUTING_HOLD_MS })}\n`);
  child.probeCompilation = { ...compiled, prepareMs: performance.now() - prepareStarted };
  return child;
}

/**
 * 服务管理的后台观察缓存。请求不等待扫描。
 * 扫描超时、失败样本和协议错误是缺证：没有执行中进程时，上一份成功观察只在「本次扫描上限 + 500 毫秒」内继续可读。
 * 进程仍活且上次为 executing/busy 时，缺证改为 scan-hold，持有到 EXECUTING_HOLD_MS；Claude 旁路确认 busy 会重新起算。
 * 超过对应上限、服务停止，或旧进程在换代之后补来的肯定，都不再保留。
 */
export function createAgentObserver({ factory = launchProbe, options = {}, clock = Date.now,
  scanTimeoutMs = SCAN_TIMEOUT_MS, evidenceGraceMs = scanTimeoutMs + EVIDENCE_GRACE_PAD_MS,
  restartMs = 250, onSample = () => {}, onProcess = () => {},
  readClaudeStatus = readClaudeSessionStatus, pidAlive = defaultPidAlive } = {}) {
  let child = null; let running = false; let generation = 0; let recent = null; let degraded = false;
  let deadline = null; let restart = null; let launching = null;
  let holdSince = null; let confirmEpoch = 0; let confirmFlight = null; let lastConfirmAt = Number.NEGATIVE_INFINITY;
  const slowBudget = Math.max(scanTimeoutMs, SLOW_SCAN_BUDGET_MS);
  /** 连续缺证从上一份成功样本的采样时刻起算，未超过短宽限时不拆圈。 */
  function withinGrace(observation, now) {
    return observation?.ok === true && Number.isSafeInteger(observation.sampledAt)
      && observation.sampledAt <= now && now - observation.sampledAt <= evidenceGraceMs;
  }
  /** 查询失败不当作进程已退出，避免误把仍在执行的光环关掉。 */
  function processAlive(pid) {
    try { return pidAlive(pid) !== false; }
    catch { return true; }
  }
  function executingSessions(process) {
    return Array.isArray(process?.sessions) && process.sessions.some(session => session?.state === 'executing');
  }
  function executingAlive(observation) {
    return (observation?.processes ?? []).some(process => process?.alive === true && executingSessions(process));
  }
  /**
   * 扫描没返回不等于回合结束。上次确认仍是执行中、进程还在、且未超过持有上限时继续亮。
   * 空进程样本没有执行中会话，不进入这条长持有。
   */
  function executingHoldable(observation, now) {
    if (observation?.ok !== true || !Number.isSafeInteger(holdSince) || holdSince > now || now - holdSince > EXECUTING_HOLD_MS) return false;
    return (observation.processes ?? []).some(process => process?.alive === true && Number.isSafeInteger(process.pid)
      && process.pid > 0 && executingSessions(process) && processAlive(process.pid));
  }
  /**
   * 把持有投影成一份新鲜样本。sampledAt 用当前时刻，这样前端 15 秒期限不会落在过去；
   * evidenceAt 仍是上次真正确认的时刻，持有上限不因反复投影被刷新。
   */
  function projectHold(observation, now) {
    const processes = [];
    for (const process of observation.processes ?? []) {
      if (process?.alive === true && executingSessions(process) && !processAlive(process.pid)) continue;
      processes.push({
        ...process,
        sessions: (process.sessions ?? []).map(session => session?.state === 'executing'
          ? { ...session, evidence: 'scan-hold', evidenceAt: holdSince }
          : session),
      });
    }
    return { ok: true, type: 'sample', sampledAt: now, processes };
  }
  /**
   * 快照阶段只覆盖它点名的 pid。未提及的进程保持上一份，空快照不能把整份观察抹掉。
   * alive:false 是探针给出的退出墓碑，必须从持有里拿掉。
   */
  function mergeFast(previous, fast) {
    const incoming = new Map();
    for (const process of fast.processes ?? []) if (Number.isSafeInteger(process?.pid)) incoming.set(process.pid, process);
    const processes = [];
    for (const process of previous?.processes ?? []) {
      if (!Number.isSafeInteger(process?.pid) || incoming.has(process.pid)) continue;
      processes.push(process);
    }
    for (const process of incoming.values()) if (process?.alive !== false) processes.push(process);
    return { ok: true, type: 'sample', phase: 'fast', covered: false, sampledAt: fast.sampledAt, scanMs: fast.scanMs, processes };
  }
  /** 完整样本替换持有；快照样本只合并。只有新的执行确认或 Claude busy 才重置持有起点。 */
  function acceptSample(message, now) {
    confirmEpoch += 1;
    if (message.phase === 'fast') {
      const merged = mergeFast(recent, message);
      if (!observationIsFresh(merged, now)) return false;
      const claudeBusy = (message.processes ?? []).some(process => process?.client === 'claude' && process.alive === true && executingSessions(process));
      recent = merged; degraded = false;
      if (claudeBusy) holdSince = message.sampledAt;
      else if (!executingAlive(merged)) holdSince = null;
      return true;
    }
    recent = message; degraded = false;
    holdSince = executingAlive(message) ? message.sampledAt : null;
    return true;
  }
  /**
   * Claude 注册表是 busy 的权威旁路。busy 重新确认并重置持有；其他明确状态立即结束。
   * 文件读失败且进程仍在时不改状态。确认代际过期后不得覆盖更新的样本。
   */
  function applyClaude(pid, status, epoch) {
    if (epoch !== confirmEpoch || !recent) return;
    const now = clock();
    const processes = (recent.processes ?? []).map(process => {
      if (process?.pid !== pid || process.client !== 'claude') return process;
      if (status === 'busy') {
        holdSince = now;
        return {
          ...process, alive: true,
          sessions: (process.sessions ?? []).map(session => ({ ...session, state: 'executing', evidence: 'scan-hold', evidenceAt: now })),
        };
      }
      if (typeof status === 'string') {
        return { ...process, sessions: (process.sessions ?? []).map(session => ({ ...session, state: 'ended' })) };
      }
      if (!processAlive(pid)) return { ...process, alive: false, sessions: [] };
      return process;
    });
    recent = { ...recent, processes };
    if (!executingAlive(recent)) holdSince = null;
  }
  /** 只对仍标记为执行中的 Claude 进程做旁路；Codex/Grok 不读 Claude 目录。 */
  function maybeConfirm() {
    const now = clock();
    if (confirmFlight || now - lastConfirmAt < CLAUDE_CONFIRM_GAP_MS) return;
    const targets = (recent?.processes ?? []).filter(process => process?.client === 'claude' && process.alive === true && executingSessions(process));
    if (targets.length === 0) return;
    lastConfirmAt = now;
    const epoch = confirmEpoch;
    confirmFlight = Promise.resolve().then(async () => {
      for (const target of targets) {
        if (epoch !== confirmEpoch) return;
        let status = null;
        try { status = await readClaudeStatus(target.pid, target); } catch { status = null; }
        applyClaude(target.pid, status, epoch);
      }
    }).finally(() => { confirmFlight = null; });
  }
  const owned = new Set();
  /** 只关闭本实例创建的子进程，退出回执后取消保底终止计时器。 */
  function end(process) {
    if (!process) return;
    process.stdin?.end();
    const timer = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill(); }, 500);
    timer.unref(); process.once('exit', () => clearTimeout(timer));
  }
  /** 探针说活着、但进程已经不在时立刻拿掉，避免持有把退出进程继续点亮。查询失败不拿掉。 */
  function dropDead() {
    if (!recent) return;
    const processes = [];
    let changed = false;
    for (const process of recent.processes ?? []) {
      if (process?.alive === true && executingSessions(process) && Number.isSafeInteger(process.pid) && process.pid > 0 && !processAlive(process.pid)) {
        changed = true; continue;
      }
      processes.push(process);
    }
    if (!changed) return;
    recent = { ...recent, processes };
    if (!executingAlive(recent)) holdSince = null;
  }
  /** 每次失效先换代。短宽限或执行持有内留着上一份成功观察；旧代迟到输出不能把它改回肯定。 */
  function failed(instance, version) {
    if (version !== generation) return;
    generation += 1; degraded = true;
    const now = clock();
    if (!withinGrace(recent, now) && !executingHoldable(recent, now)) recent = null;
    else maybeConfirm();
    clearTimeout(deadline); deadline = null;
    if (child === instance) child = null;
    end(instance);
    if (running) { restart = setTimeout(begin, restartMs); restart.unref(); }
  }
  /** 仅后台启动/重启，首次编译不占快照请求时间，启动期间没有肯定结果。 */
  async function begin() {
    if (!running || child || launching) return;
    const version = ++generation;
    launching = Promise.resolve().then(() => factory(options));
    try {
      const instance = await launching;
      owned.add(instance);
      instance.once('exit', () => owned.delete(instance));
      if (!running || version !== generation) { end(instance); return; }
      child = instance; onProcess(instance.pid, instance.probeCompilation);
      let pending = '';
      instance.stderr?.resume(); // 不保存目标日志或原始命令，诊断只保留失败状态。
      instance.stdout.setEncoding('utf8');
      instance.stdout.on('data', chunk => {
        if (version !== generation) return;
        pending += chunk;
        if (pending.length > 1024 * 1024) { failed(instance, version); return; }
        for (;;) {
          const newline = pending.indexOf('\n'); if (newline < 0) break;
          const line = pending.slice(0, newline).replace(/^\uFEFF/, ''); pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'scan-start') {
              // 手头已有执行中样本时放宽杀探针预算，让慢扫描还能带回 turn_ended。没有执行样本时保持短超时。
              const budget = executingAlive(recent) ? slowBudget : scanTimeoutMs;
              clearTimeout(deadline); deadline = setTimeout(() => failed(instance, version), budget); deadline.unref();
            } else if (message.type === 'sample') {
              clearTimeout(deadline);
              const now = clock();
              const acceptable = message.ok === true && (message.phase === 'fast' || observationIsFresh(message, now));
              if (acceptable && acceptSample(message, now)) { /* 完整样本替换，快照样本合并。 */ }
              else {
                degraded = true;
                if (!withinGrace(recent, now) && !executingHoldable(recent, now)) recent = null;
                else maybeConfirm();
              }
              onSample(message);
              // 快照之后要等完整扫描；未分阶段的样本保持原短期限，避免改动既有超时测试。
              const follow = message.phase === 'fast' || (message.phase === 'full' && executingAlive(message)) ? slowBudget : scanTimeoutMs + 600;
              deadline = setTimeout(() => failed(instance, version), follow); deadline.unref();
            } else throw new Error('probe_protocol');
          } catch { failed(instance, version); return; }
        }
      });
      instance.once('error', () => failed(instance, version));
      instance.once('exit', () => failed(instance, version));
      deadline = setTimeout(() => failed(instance, version), scanTimeoutMs + 1000); deadline.unref();
    } catch { failed(null, version); }
    finally { launching = null; }
  }
  return {
    /** 只在服务已监听时启动后台工作，重复启动不创建第二个实例。 */
    start() { if (running || process.platform !== 'win32' && factory === launchProbe) return; running = true; void begin(); },
    /** 请求仅取内存结果，不等待编译、进程发现或原生文件读取。 */
    latest() {
      dropDead();
      const now = clock();
      const fresh = observationIsFresh(recent, now);
      // 新鲜且未降级，或仍在短宽限内：原样返回，不把持有起点刷新成现在。
      if (fresh && (!degraded || withinGrace(recent, now))) return recent;
      if (executingHoldable(recent, now)) { maybeConfirm(); return projectHold(recent, now); }
      if (!fresh) return null;
      if (degraded && !withinGrace(recent, now)) return null;
      return recent;
    },
    /** 服务关闭时等待本实例全部探针退出，不把残留留给全局计划任务处理。 */
    async stop() {
      running = false; generation += 1; confirmEpoch += 1; recent = null; holdSince = null; degraded = false; clearTimeout(deadline); clearTimeout(restart);
      if (launching) await launching.catch(() => {});
      await Promise.all([...owned].map(instance => new Promise(resolve => {
        if (instance.exitCode !== null || instance.signalCode !== null) { resolve(); return; }
        instance.once('exit', resolve); end(instance);
      })));
      child = null;
    },
  };
}
