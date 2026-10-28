#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, lstatSync, appendFileSync, realpathSync, openSync, closeSync, fstatSync } from 'node:fs';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const RUNNER = fileURLToPath(import.meta.url);
const OWNER = 'awr-dashboard-background-v1';
const LOG_LIMIT = 1024 * 1024;
const RECORD_LIMIT = 16 * 1024;
const DIAGNOSTIC_LIMIT = 1024;
const RECORD_REPLACE_BUDGET_MS = 1000;
const RECORD_REPLACE_INTERVAL_MS = 50;
const STARTUP_STAGES = new Set(['platform', 'identity', 'binding', 'identity_binding', 'registry', 'state_paths',
  'record_read', 'server_create', 'listen', 'record_write', 'service_log', 'runtime', 'stopped_log']);
const STARTUP_CODES = new Set(['BACKGROUND_WINDOWS_REQUIRED', 'BACKGROUND_IDENTITY_FAILED', 'BACKGROUND_BINDING_INVALID',
  'BACKGROUND_BINDING_VERSION_MISMATCH', 'BACKGROUND_USER_MISMATCH', 'BACKGROUND_ELEVATED_TOKEN', 'BACKGROUND_NODE_PATH_MISMATCH',
  'BACKGROUND_STATE_LINK', 'BACKGROUND_RECORD_INVALID', 'BACKGROUND_STATE_IN_USE', 'BACKGROUND_PROCESS_QUERY_FAILED',
  'BACKGROUND_PROCESS_QUERY_DENIED', 'BACKGROUND_TOKEN_QUERY_FAILED', 'REGISTRY_INVALID', 'REGISTRY_UNAVAILABLE', 'REGISTRY_TOO_LARGE']);

/** 失败分类只使用精确常量允许名单；未知错误归为unknown，绝不保存异常原文、路径、输出或堆栈。 */
export function startupFailureCategory(error) {
  try {
    for (const value of [error?.code, error?.message]) if (STARTUP_CODES.has(value)) return value;
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'access_denied';
    if (error?.code === 'ENOENT') return 'not_found';
    if (error?.code === 'EADDRINUSE') return 'port_in_use';
    if (error?.code === 'ETIMEDOUT') return 'timed_out';
    if (error instanceof SyntaxError) return 'invalid_json';
    if (Number.isInteger(error?.status) && error.status !== 0) return 'child_process_failed';
  } catch { /* 异常对象自身不可信时仍只返回常量，不尝试字符串转换。 */ }
  return 'unknown';
}

/**
 * 独立保存最近一次启动失败的有界安全快照，不写service.log或instance.json。
 * 固定排他临时文件兼作写入锁：已有残留不抢占、不清理，只有本次创建且身份仍匹配的文件才可删除。
 */
export function writeStartupDiagnostic(directory, stage, error) {
  let descriptor;
  let temporary;
  let createdIdentity;
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
    const resolved = path.resolve(directory);
    const relative = path.relative(os.tmpdir(), resolved);
    if (resolved !== path.join(ROOT, 'run', 'background')
      && (path.isAbsolute(relative) || relative.startsWith('..') || !relative.split(path.sep)[0].startsWith('awr-dashboard-background-'))) return false;
    assertRuntimePaths(resolved);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    assertRuntimePaths(resolved);
    const target = path.join(resolved, 'startup-failure.json');
    temporary = path.join(resolved, 'startup-failure.tmp');
    for (const filename of [target, temporary]) {
      try {
        const item = lstatSync(filename);
        if (item.isSymbolicLink() || !item.isFile() || item.nlink !== 1 || item.size > DIAGNOSTIC_LIMIT) return false;
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
    const bytes = Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), event: 'startup_failed',
      stage: STARTUP_STAGES.has(stage) ? stage : 'unknown', category: startupFailureCategory(error), pid: process.pid })}\n`);
    if (bytes.length > DIAGNOSTIC_LIMIT) return false;
    descriptor = openSync(temporary, 'wx', 0o600);
    createdIdentity = fstatSync(descriptor, { bigint: true });
    if (!createdIdentity.isFile() || createdIdentity.nlink !== 1n) return false;
    writeFileSync(descriptor, bytes);
    assertRuntimePaths(resolved);
    try {
      const destination = lstatSync(target, { bigint: true });
      if (!destination.isFile() || destination.isSymbolicLink() || destination.nlink !== 1n
        || destination.size > BigInt(DIAGNOSTIC_LIMIT)) return false;
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    const beforeRename = lstatSync(temporary, { bigint: true });
    if (!beforeRename.isFile() || beforeRename.isSymbolicLink() || beforeRename.nlink !== 1n
      || beforeRename.dev !== createdIdentity.dev || beforeRename.ino !== createdIdentity.ino
      || beforeRename.size !== BigInt(bytes.length) || beforeRename.size > BigInt(DIAGNOSTIC_LIMIT)) return false;
    closeSync(descriptor);
    descriptor = undefined;
    // 原子替换使并发读取只能看到完整旧/新快照；与正常实例的服务日志写入互不影响。
    renameSync(temporary, target);
    createdIdentity = undefined;
    return true;
  } catch { return false; }
  finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* 不掩盖原始启动失败。 */ } }
    if (createdIdentity) {
      try {
        // 检查失败也可能源于父目录已被替换；清理前必须重新拒绝重定向，不能顺着链接删除文件。
        assertRuntimePaths(path.dirname(temporary));
        const remaining = lstatSync(temporary, { bigint: true });
        if (remaining.isFile() && !remaining.isSymbolicLink() && remaining.nlink === 1n
          && remaining.dev === createdIdentity.dev && remaining.ino === createdIdentity.ino) unlinkSync(temporary);
      } catch { /* 无法核对的残留保留，不按文件名删除未知内容。 */ }
    }
  }
}

/** 只枚举目录链属性，拒绝链接重定向，不顺着身份配置或运行目录读取/写入项目外文件。 */
function assertDirectoryChain(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try {
      const item = lstatSync(current);
      if (item.isSymbolicLink() || !item.isDirectory() || realpathSync(current).toLowerCase() !== current.toLowerCase()) throw new Error('BACKGROUND_STATE_LINK');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
}

/** 拒绝本机身份绑定文件的链接与多重硬链接，并在读取前执行字节上限检查。 */
export function assertBindingFile(filename) {
  assertDirectoryChain(path.dirname(filename));
  const item = lstatSync(filename);
  if (item.isSymbolicLink() || !item.isFile() || item.nlink > 1 || item.size > 4096) throw new Error('BACKGROUND_BINDING_INVALID');
}

/** 拒绝运行目录各级父路径和固定运行文件的链接/多重硬链接，避免写入其他项目或用户文件。 */
export function assertRuntimePaths(directory) {
  assertDirectoryChain(directory);
  for (const name of ['service.log', 'service.log.1', 'instance.json']) {
    try {
      const item = lstatSync(path.join(directory, name));
      if (item.isSymbolicLink() || !item.isFile() || item.nlink > 1) throw new Error('BACKGROUND_STATE_LINK');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** 所有身份数据来自原生查询和固定本机配置；管理员或其他账户不得成为服务运行主体。 */
export function assertRunIdentity(settings, identity, nodePath) {
  // 各门禁仍逐项拒绝；仅把原先合并的失败拆成固定类别，不把实际身份或路径写入诊断。
  if (settings.version !== 1) throw new Error('BACKGROUND_BINDING_VERSION_MISMATCH');
  if (settings.userSid !== identity.userSid) throw new Error('BACKGROUND_USER_MISMATCH');
  if (identity.elevated !== false) throw new Error('BACKGROUND_ELEVATED_TOKEN');
  if (String(nodePath).toLowerCase() !== String(settings.nodePath).toLowerCase()) throw new Error('BACKGROUND_NODE_PATH_MISMATCH');
}

/** 解析本看板后台参数；不支持外网地址、任意入口或可执行文件参数。 */
export function parseBackgroundArguments(args) {
  const options = { port: 4317, registryPath: path.join(ROOT, 'config', 'projects.json'), stateDirectory: path.join(ROOT, 'run', 'background') };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--port', '--projects', '--state-directory'].includes(flag) || seen.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('BACKGROUND_ARGUMENTS');
    }
    seen.add(flag);
    const value = args[++index];
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('BACKGROUND_ARGUMENTS');
      options.port = Number(value);
    } else {
      if (!path.isAbsolute(value)) throw new Error('BACKGROUND_ARGUMENTS');
      options[flag === '--projects' ? 'registryPath' : 'stateDirectory'] = path.resolve(value);
    }
  }
  // 生产运行数据只写本项目run；测试只准写明确的专用临时目录，不能借参数覆盖任意目录。
  const ownRun = path.join(ROOT, 'run', 'background');
  const relativeTemporary = path.relative(os.tmpdir(), options.stateDirectory);
  const temporaryName = relativeTemporary.split(path.sep)[0];
  if (options.stateDirectory !== ownRun
    && (path.isAbsolute(relativeTemporary) || relativeTemporary.startsWith('..') || !temporaryName.startsWith('awr-dashboard-background-'))) {
    throw new Error('BACKGROUND_STATE_DIRECTORY');
  }
  return options;
}

/** 写固定两份轮转日志，每份最多1MiB；仅接受安全事件代码及白名单数字，不输出源内容或堆栈。 */
export function appendBoundedLog(directory, event, details = {}, maximum = LOG_LIMIT) {
  assertRuntimePaths(directory);
  if (!Number.isInteger(maximum) || maximum < 128 || maximum > LOG_LIMIT) throw new Error('BACKGROUND_LOG_LIMIT');
  const safe = { at: new Date().toISOString(), event: String(event).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80) };
  for (const key of ['port', 'pid', 'exitCode']) if (Number.isSafeInteger(details[key])) safe[key] = details[key];
  const bytes = Buffer.from(`${JSON.stringify(safe)}\n`);
  if (bytes.length > maximum) throw new Error('BACKGROUND_LOG_LIMIT');
  const current = path.join(directory, 'service.log');
  const previous = path.join(directory, 'service.log.1');
  let size = 0;
  try { size = statSync(current).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size + bytes.length > maximum) {
    // 删除目标只可能是本运行目录的固定旧日志，不枚举或递归删除目录，也不触碰项目来源。
    try { unlinkSync(previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(current, previous);
  }
  appendFileSync(current, bytes, { mode: 0o600 });
}

/** 有界读取自有运行记录；损坏、外来身份或不完整记录明确失败，不静默覆盖未知文件。 */
export function readInstanceRecord(directory) {
  assertRuntimePaths(directory);
  const target = path.join(directory, 'instance.json');
  let bytes;
  try {
    if (statSync(target).size > RECORD_LIMIT) throw new Error('BACKGROUND_RECORD_INVALID');
    bytes = readFileSync(target);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('BACKGROUND_RECORD_INVALID'); }
  if (!value || value.version !== 1 || value.owner !== OWNER || value.projectRoot !== ROOT || value.runnerPath !== RUNNER
    || typeof value.nodePath !== 'string' || typeof value.registryPath !== 'string' || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.instanceId !== 'string'
    || typeof value.processCreatedAt !== 'string' || typeof value.userSid !== 'string' || value.elevated !== false
    || !Number.isSafeInteger(value.sessionId)) throw new Error('BACKGROUND_RECORD_INVALID');
  return value;
}

/** 比较文件系统对象身份；出生时刻补充编号复用检查，不把路径相同当成同一对象。 */
function sameFileIdentity(actual, expected) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.birthtimeNs === expected.birthtimeNs;
}

/** 在监听前保存已校验旧记录及目录的身份基线，监听的异步间隙也不能接管后来出现的记录。 */
function captureReplacementBaseline(directory, previous) {
  assertRuntimePaths(directory);
  const directoryIdentity = lstatSync(directory, { bigint: true });
  const target = path.join(directory, 'instance.json');
  let oldIdentity;
  let oldBytes;
  if (previous) {
    oldIdentity = lstatSync(target, { bigint: true });
    if (oldIdentity.size > BigInt(RECORD_LIMIT)) throw new Error('BACKGROUND_RECORD_INVALID');
    oldBytes = readFileSync(target);
    // 监听前已经核对的记录必须仍然相同；等待期间更严格地比较原字节和文件身份。
    if (JSON.stringify(readInstanceRecord(directory)) !== JSON.stringify(previous)
      || JSON.stringify(JSON.parse(oldBytes.toString('utf8'))) !== JSON.stringify(previous)
      || !sameFileIdentity(lstatSync(target, { bigint: true }), oldIdentity)
      || !readFileSync(target).equals(oldBytes)) throw new Error('BACKGROUND_RECORD_INVALID');
  }
  if (!sameFileIdentity(lstatSync(directory, { bigint: true }), directoryIdentity)) throw new Error('BACKGROUND_STATE_LINK');
  return { directoryIdentity, oldIdentity, oldBytes };
}

/**
 * 原子发布新实例记录。Windows只读观察者可能短暂阻止替换已核对的旧记录，
 * 因而只对该路径的访问拒绝重试；总预算固定为1秒，不延长外层启动或测试期限。
 * 每次让出执行权后重新核对目录、旧记录和临时文件，未知替代内容不能被覆盖或删除。
 */
export async function replaceInstanceRecord(directory, record, previous, baseline = captureReplacementBaseline(directory, previous)) {
  const { directoryIdentity, oldIdentity, oldBytes } = baseline;
  const target = path.join(directory, 'instance.json');
  const temporary = path.join(directory, `instance-${record.instanceId}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  let createdIdentity;
  let descriptor;
  let recordWritten = false;
  /** 路径门禁和目录身份同时成立才可继续发布或清理自有临时文件。 */
  function assertDirectoryIdentity() {
    assertRuntimePaths(directory);
    if (!sameFileIdentity(lstatSync(directory, { bigint: true }), directoryIdentity)) throw new Error('BACKGROUND_STATE_LINK');
  }
  /** 临时文件必须仍是本次排他创建的单链接普通文件，且完整字节没有被改写。 */
  function assertTemporaryIdentity() {
    const item = lstatSync(temporary, { bigint: true });
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || !sameFileIdentity(item, createdIdentity)
      || item.size !== BigInt(bytes.length) || !readFileSync(temporary).equals(bytes)) throw new Error('BACKGROUND_RECORD_INVALID');
  }
  /** 旧记录的存在性、身份及完整字节都必须保持；不接管等待期间出现的新记录。 */
  function assertPreviousIdentity() {
    let item;
    try { item = lstatSync(target, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!oldIdentity && !item) return;
    if (!oldIdentity || !item || !sameFileIdentity(item, oldIdentity) || item.size !== BigInt(oldBytes.length)
      || !readFileSync(target).equals(oldBytes)) throw new Error('BACKGROUND_RECORD_INVALID');
  }
  try {
    assertDirectoryIdentity();
    assertPreviousIdentity();
    descriptor = openSync(temporary, 'wx', 0o600);
    createdIdentity = fstatSync(descriptor, { bigint: true });
    writeFileSync(descriptor, bytes);
    recordWritten = true;
    closeSync(descriptor);
    descriptor = undefined;
    const started = performance.now();
    let firstFailure;
    for (;;) {
      assertDirectoryIdentity();
      assertTemporaryIdentity();
      assertPreviousIdentity();
      // 调度延迟或检查本身耗时也消耗同一预算；超期后不能再尝试一次成功来掩盖持续拒绝。
      if (firstFailure && performance.now() - started >= RECORD_REPLACE_BUDGET_MS) throw firstFailure;
      try {
        renameSync(temporary, target);
        createdIdentity = undefined;
        return;
      } catch (error) {
        if (process.platform !== 'win32' || !oldIdentity || !['EPERM', 'EACCES'].includes(error.code)) throw error;
        firstFailure ??= error;
        const remaining = RECORD_REPLACE_BUDGET_MS - (performance.now() - started);
        if (remaining <= 0) throw firstFailure;
        await delay(Math.min(RECORD_REPLACE_INTERVAL_MS, remaining));
      }
    }
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* 清理不得覆盖最初失败。 */ } }
    if (createdIdentity) {
      try {
        assertDirectoryIdentity();
        if (recordWritten) assertTemporaryIdentity();
        else {
          // 排他创建后的写入也可能只完成一部分；此时按创建句柄身份回收，不能要求完整正文才清理。
          const item = lstatSync(temporary, { bigint: true });
          if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n
            || !sameFileIdentity(item, createdIdentity)) throw new Error('BACKGROUND_RECORD_INVALID');
        }
        unlinkSync(temporary);
      } catch { /* 只清理仍可证明属于自己的完整临时文件；未知替代物保留。 */ }
    }
  }
}

/** 获取Windows原生创建时刻和当前用户SID；隐藏的一次性查询不读凭据、不提升权限。 */
function nativeProcessIdentity() {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 失败只输出精确常量，便于区分原生进程查询与令牌查询；不把PowerShell原始错误写入诊断。
  const command = "$ErrorActionPreference='Stop'; try { "
    + `$probe = Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}' -ErrorAction Stop; `
    + "if (-not $probe) { throw 'missing-process' }; $created = $probe.CreationDate.ToUniversalTime().ToString('o'); $session = $probe.SessionId; "
    + "} catch { if ($_.Exception.HResult -in @(-2147024891,-2147217405)) { [Console]::WriteLine('BACKGROUND_PROCESS_QUERY_DENIED') } "
    + "else { [Console]::WriteLine('BACKGROUND_PROCESS_QUERY_FAILED') }; exit 1 }; "
    + "try { $token = [Security.Principal.WindowsIdentity]::GetCurrent(); $sid = $token.User.Value; "
    + "$elevated = [Security.Principal.WindowsPrincipal]::new($token).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator) "
    + "} catch { [Console]::WriteLine('BACKGROUND_TOKEN_QUERY_FAILED'); exit 1 }; "
    + "[pscustomobject]@{ processCreatedAt=$created; sessionId=$session; userSid=$sid; elevated=$elevated } | ConvertTo-Json -Compress";
  let result;
  try {
    result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: RECORD_LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const code = typeof error.stdout === 'string' ? error.stdout.trim() : '';
    if (['BACKGROUND_PROCESS_QUERY_FAILED', 'BACKGROUND_PROCESS_QUERY_DENIED', 'BACKGROUND_TOKEN_QUERY_FAILED'].includes(code)) throw new Error(code);
    throw error;
  }
  const identity = JSON.parse(result.trim());
  if (!/^S-\d(-\d+)+$/.test(identity.userSid) || typeof identity.processCreatedAt !== 'string' || !Number.isFinite(Date.parse(identity.processCreatedAt))) {
    throw new Error('BACKGROUND_IDENTITY_FAILED');
  }
  return identity;
}

/** 查询已记录编号是否还存在；权限不足视为仍存在，不借此结束未知或复用编号的进程。 */
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** 一次启动并等待本地只读服务退出；失败交给计划任务恢复，不实现常驻监督循环。 */
export async function runBackground(options) {
  let stage = 'platform';
  let record;
  let instancePath;
  let server;
  let ownsRecord = false;
  let exitCode = 0;
  /** 只清理本次实例记录；旧进程迟到退出不能删除新实例记录，也不删除日志或项目内容。 */
  function cleanupRecord() {
    if (!ownsRecord) return;
    try { if (readInstanceRecord(options.stateDirectory)?.instanceId === record.instanceId) unlinkSync(instancePath); } catch { /* 记录异常保留，不能猜测身份后删除。 */ }
  }
  /** 响应正常停止信号；先关监听与空闲连接，最多5秒后关闭本进程剩余连接。 */
  function stop() {
    if (!server) return;
    server.close();
    server.closeIdleConnections();
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
  }
  try {
    if (process.platform !== 'win32') throw new Error('BACKGROUND_WINDOWS_REQUIRED');
    stage = 'identity';
    const identity = nativeProcessIdentity();
    stage = 'binding';
    const settingsPath = path.join(ROOT, 'ops', 'background-settings.json');
    assertBindingFile(settingsPath);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    stage = 'identity_binding';
    // 管理员只安装任务，实际服务必须由绑定账户的有限令牌运行；其他授权不能偷换服务账户。
    assertRunIdentity(settings, identity, realpathSync(process.execPath));
    stage = 'registry';
    // 只有实际身份门禁通过才加载业务模块。静态导入会在runBackground之前执行，
    // 因而无法靠函数内的角色检查阻止高角色尝试提前运行工作区模块。
    const [{ createDashboardServer }, { readProjectRegistry }, { createAgentObserver }] = await Promise.all([
      import('../src/server.js'), import('../src/registry.js'), import('../src/agent-observer.js'),
    ]);
    // 名单验证仍先于身份记录、监听与服务日志；仅授权的安全失败诊断可在失败时单独写入。
    await readProjectRegistry(options.registryPath);
    stage = 'state_paths';
    assertRuntimePaths(options.stateDirectory);
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    assertRuntimePaths(options.stateDirectory);
    stage = 'record_read';
    const previous = readInstanceRecord(options.stateDirectory);
    if (previous && previous.port !== options.port && processExists(previous.pid)) throw new Error('BACKGROUND_STATE_IN_USE');
    const replacementBaseline = captureReplacementBaseline(options.stateDirectory, previous);
    record = { version: 1, owner: OWNER, projectRoot: ROOT, runnerPath: RUNNER, nodePath: realpathSync(process.execPath),
      registryPath: options.registryPath, port: options.port, pid: process.pid, ...identity, instanceId: randomUUID(), startedAt: new Date().toISOString() };
    instancePath = path.join(options.stateDirectory, 'instance.json');
    stage = 'server_create';
    server = createDashboardServer({ registryPath: options.registryPath, agentObserver: createAgentObserver(), onError: code => appendBoundedLog(options.stateDirectory, `read.${code}`) });
    stage = 'listen';
    // 必须先成功独占回环端口才能写instance.json；重复启动失败不覆盖首实例记录、不结束占端口者。
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: options.port, host: '127.0.0.1', exclusive: true }, resolve);
    });
    stage = 'record_write';
    await replaceInstanceRecord(options.stateDirectory, record, previous, replacementBaseline);
    ownsRecord = true;
    stage = 'service_log';
    appendBoundedLog(options.stateDirectory, 'started', { port: options.port, pid: process.pid });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    stage = 'runtime';
    await new Promise(resolve => {
      server.once('close', resolve);
      server.on('error', () => { exitCode = 1; stop(); });
    });
    stage = 'stopped_log';
    appendBoundedLog(options.stateDirectory, 'stopped', { pid: process.pid, exitCode });
    return exitCode;
  } catch (error) {
    stop();
    // 未取得端口者不写正在运行实例的日志，保证轮转只有一个写入者，也不改变它的身份记录。
    if (ownsRecord) { try { appendBoundedLog(options.stateDirectory, 'startup_failed', { port: options.port, pid: process.pid }); } catch { /* 失败诊断不得改写身份门禁结果。 */ } }
    else console.error(startupFailureCategory(error) === 'port_in_use' ? '看板后台端口被占用，未结束占用进程。' : '看板后台未建立可验证运行身份。');
    if (!writeStartupDiagnostic(options.stateDirectory, stage, error)) console.error('看板启动诊断未写入；原失败状态保持不变。');
    return 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    cleanupRecord();
  }
}

// 作为测试模块导入时不启动服务；命令行仅运行固定本项目服务，未知异常不打印敏感原文。
if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER) {
  try { process.exitCode = await runBackground(parseBackgroundArguments(process.argv.slice(2))); }
  catch { console.error('看板后台启动失败：请检查本项目运行记录、登记清单和运行权限。'); process.exitCode = 1; }
}
