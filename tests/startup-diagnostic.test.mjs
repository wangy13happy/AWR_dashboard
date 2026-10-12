import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, realpath, rm, link, symlink, unlink } from 'node:fs/promises';
import { startupFailureCategory, writeStartupDiagnostic, assertRunIdentity, runBackground } from '../bin/background-runner.mjs';

const ROOT = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const RUNNER_URL = new URL('../bin/background-runner.mjs', import.meta.url);
const BINDING = path.join(ROOT, 'ops', 'background-settings.json');
const LIMIT = 1024;
const PRIVATE = 'synthetic-secret-value-not-for-diagnostic';
const SAFE_CODES = ['BACKGROUND_WINDOWS_REQUIRED', 'BACKGROUND_IDENTITY_FAILED', 'BACKGROUND_BINDING_INVALID',
  'BACKGROUND_BINDING_VERSION_MISMATCH', 'BACKGROUND_USER_MISMATCH', 'BACKGROUND_ELEVATED_TOKEN', 'BACKGROUND_NODE_PATH_MISMATCH',
  'BACKGROUND_STATE_LINK', 'BACKGROUND_RECORD_INVALID', 'BACKGROUND_STATE_IN_USE', 'BACKGROUND_PROCESS_QUERY_FAILED',
  'BACKGROUND_PROCESS_QUERY_DENIED', 'BACKGROUND_TOKEN_QUERY_FAILED', 'REGISTRY_INVALID', 'REGISTRY_UNAVAILABLE', 'REGISTRY_TOO_LARGE'];
const STAGES = ['platform', 'identity', 'binding', 'identity_binding', 'registry', 'state_paths', 'record_read',
  'server_create', 'listen', 'record_write', 'service_log', 'runtime', 'stopped_log'];
const original = Object.fromEntries(['lstatSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'openSync']
  .map(name => [name, fs[name]]));
const execute = promisify(childProcess.execFile);

/** 创建并登记本测试独占临时根；清理前核对位置、目录身份和真实路径，不接受项目根或外部路径。 */
async function fixture(t, prefix = 'awr-dashboard-background-diagnostic-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const identity = await lstat(directory, { bigint: true });
  const cleanupBeforeRemove = [];
  t.after(async () => {
    for (const cleanup of cleanupBeforeRemove) await cleanup();
    const absolute = path.resolve(directory);
    const relative = path.relative(os.tmpdir(), absolute);
    assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(absolute).startsWith(prefix));
    const remaining = await lstat(absolute, { bigint: true });
    assert.ok(remaining.isDirectory() && !remaining.isSymbolicLink());
    assert.equal(remaining.dev, identity.dev);
    assert.equal(remaining.ino, identity.ino);
    assert.equal((await realpath(absolute)).toLowerCase(), absolute.toLowerCase());
    await rm(absolute, { recursive: true, force: true });
  });
  return { directory, cleanupBeforeRemove };
}

/** 校验固定诊断结构与字节上限；身份、路径、异常原文等额外字段都不能进入快照。 */
function snapshot(bytes, expected = {}) {
  assert.ok(Buffer.byteLength(bytes) <= LIMIT);
  const value = JSON.parse(bytes.toString());
  assert.deepEqual(Object.keys(value).sort(), ['at', 'category', 'event', 'pid', 'stage']);
  assert.equal(value.event, 'startup_failed');
  assert.ok(Number.isFinite(Date.parse(value.at)));
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  for (const [key, wanted] of Object.entries(expected)) assert.equal(value[key], wanted);
  assert.doesNotMatch(bytes.toString(), new RegExp(`${PRIVATE}|userSid|nodePath|stderr|stdout|stack`));
  return value;
}

/** 临时替换仅当前测试进程的内建函数；始终恢复方法并同步导入绑定，避免影响后续测试。 */
async function withMocks(t, replacements, action) {
  for (const [object, name, implementation] of replacements) t.mock.method(object, name, implementation);
  syncBuiltinESMExports();
  try { return await action(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

/** 构造纯合成身份与绑定替身；不读取机器绑定正文、不启动原生身份查询，也不修改实际配置。 */
function identityMocks(options = {}) {
  const { settings = {}, identity = {}, nativeError, bindingError } = options;
  const fixedSettings = { version: 1, userSid: 'S-1-5-21-100', nodePath: fs.realpathSync(process.execPath), ...settings };
  const fixedIdentity = { userSid: 'S-1-5-21-100', elevated: false, sessionId: 0,
    processCreatedAt: '2026-01-01T00:00:00.0000000Z', ...identity };
  return [
    [childProcess, 'execFileSync', (_file, _args, executionOptions) => {
      // 原生标准错误必须保持捕获，不能因诊断变更泄漏到继承的终端输出。
      assert.deepEqual(executionOptions.stdio, ['ignore', 'pipe', 'pipe']);
      if (Object.hasOwn(options, 'nativeError')) throw nativeError;
      return JSON.stringify(fixedIdentity);
    }],
    [fs, 'lstatSync', (filename, options) => {
      if (path.resolve(String(filename)).toLowerCase() !== BINDING.toLowerCase()) return original.lstatSync(filename, options);
      if (bindingError) throw bindingError;
      return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 256 };
    }],
    [fs, 'readFileSync', (filename, options) => {
      if (typeof filename !== 'string' || path.resolve(filename).toLowerCase() !== BINDING.toLowerCase()) return original.readFileSync(filename, options);
      return JSON.stringify(fixedSettings);
    }],
  ];
}

/** 为启动失败或健康监听测试写空登记夹具；其中没有任何真实被查看项目。 */
async function runnerFixture(t) {
  const own = await fixture(t);
  const registryPath = path.join(own.directory, 'projects.json');
  await writeFile(registryPath, JSON.stringify({ version: 1, defaultProjectId: null, projects: [] }));
  return { ...own, registryPath, stateDirectory: path.join(own.directory, 'state'), port: await freePort() };
}

/** 临时取得随机回环端口，不查询、停止或替换机器上任何真实服务。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 有界等待测试自己的内存运行实例；每次让出事件循环，不阻塞工作线程。 */
async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('专用启动诊断夹具等待超时');
}

/** 比较普通文件身份和写入时间；读取本身不应被误算为产品修改。 */
async function unchangedFile(filename) {
  const bytes = await readFile(filename);
  const meta = await lstat(filename, { bigint: true });
  return { bytes, dev: meta.dev, ino: meta.ino, size: meta.size, mtimeNs: meta.mtimeNs, ctimeNs: meta.ctimeNs };
}

/** 启动仅导入诊断函数的专用工作线程；失败清理先解除本测试屏障，再仅终止该线程句柄。 */
function diagnosticWorker(own, source, data = {}) {
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    execArgv: [], workerData: { url: RUNNER_URL.href, directory: own.directory, ...data },
  });
  let resolveReady;
  let rejectReady;
  let resolveDone;
  let rejectDone;
  let readyReceived = false;
  let doneReceived = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  worker.on('message', value => {
    if (value.ready) { readyReceived = true; resolveReady(value); }
    else if (value.done) { doneReceived = true; resolveDone(value); }
  });
  worker.on('error', error => { rejectReady(error); rejectDone(error); });
  const exited = new Promise((resolve, reject) => {
    worker.once('exit', code => {
      const failure = new Error(`诊断夹具线程退出${code}或未产生完整结果`);
      if (!readyReceived) rejectReady(failure);
      if (!doneReceived) rejectDone(failure);
      if (code === 0 && doneReceived) resolve(); else reject(failure);
    });
  });
  // 三个阶段会按顺序等待；预先登记失败观察，防止线程提前失败形成未处理拒绝。
  for (const pending of [ready, done, exited]) pending.catch(() => {});
  // 注册在夹具清理列表中，确保异常时没有线程继续写将要删除的自有临时根。
  own.cleanupBeforeRemove.push(async () => {
    if (data.barrier) { Atomics.store(new Int32Array(data.barrier), 0, 1); Atomics.notify(new Int32Array(data.barrier), 0); }
    await worker.terminate();
  });
  return { worker, ready, done, exited };
}

test('启动失败类别仅采用精确允许名单与固定系统映射，不接受前后缀或敏感对象转换', () => {
  for (const code of SAFE_CODES) {
    assert.equal(startupFailureCategory({ code, message: PRIVATE }), code);
    assert.equal(startupFailureCategory(new Error(code)), code);
    assert.equal(startupFailureCategory(new Error(`${code}: ${PRIVATE}`)), 'unknown');
  }
  for (const [code, category] of [['EACCES', 'access_denied'], ['EPERM', 'access_denied'], ['ENOENT', 'not_found'],
    ['EADDRINUSE', 'port_in_use'], ['ETIMEDOUT', 'timed_out']]) {
    assert.equal(startupFailureCategory({ code, message: PRIVATE, stdout: PRIVATE, stderr: PRIVATE }), category);
  }
  assert.equal(startupFailureCategory(new SyntaxError(PRIVATE)), 'invalid_json');
  assert.equal(startupFailureCategory({ status: 1, message: PRIVATE }), 'child_process_failed');
  for (const value of [null, undefined, PRIVATE, { status: 0, message: PRIVATE }, { status: '1', message: PRIVATE },
    { code: { toString() { throw new Error(PRIVATE); } } }, { get code() { throw new Error(PRIVATE); } }]) {
    assert.equal(startupFailureCategory(value), 'unknown');
  }
});

test('全部固定失败阶段均可写有界快照，未知阶段与错误只能归为unknown', async t => {
  const { directory } = await fixture(t);
  for (const stage of STAGES) {
    assert.equal(writeStartupDiagnostic(directory, stage, new Error('BACKGROUND_IDENTITY_FAILED')), true);
    snapshot(await readFile(path.join(directory, 'startup-failure.json')), { stage, category: 'BACKGROUND_IDENTITY_FAILED', pid: process.pid });
  }
  assert.equal(writeStartupDiagnostic(directory, `${PRIVATE}/path`, { message: PRIVATE, stack: PRIVATE, stdout: PRIVATE }), true);
  snapshot(await readFile(path.join(directory, 'startup-failure.json')), { stage: 'unknown', category: 'unknown' });
  assert.deepEqual(await readdir(directory), ['startup-failure.json']);
});

test('身份绑定细分类别不放宽版本、原账户、有限令牌和Node路径门禁', () => {
  const settings = { version: 1, userSid: 'S-1-5-21-100', nodePath: process.execPath };
  const identity = { userSid: settings.userSid, elevated: false };
  assert.doesNotThrow(() => assertRunIdentity(settings, identity, process.execPath.toUpperCase()));
  for (const [binding, token, executable, code] of [
    [{ ...settings, version: 2 }, identity, process.execPath, 'BACKGROUND_BINDING_VERSION_MISMATCH'],
    [settings, { ...identity, userSid: 'S-1-5-18' }, process.execPath, 'BACKGROUND_USER_MISMATCH'],
    ...[true, null, undefined, 0, 'false'].map(elevated => [settings, { ...identity, elevated }, process.execPath, 'BACKGROUND_ELEVATED_TOKEN']),
    [settings, identity, path.join(os.tmpdir(), 'synthetic-other-node.exe'), 'BACKGROUND_NODE_PATH_MISMATCH'],
  ]) assert.throws(() => assertRunIdentity(binding, token, executable), error => error.message === code);
});

test('参数错误只输出固定提示，不向未经信任的运行目录写任何诊断', async t => {
  const { directory } = await fixture(t, 'awr-dashboard-diagnostic-outside-');
  const marker = path.join(directory, 'unchanged.txt');
  await writeFile(marker, 'unchanged');
  const before = await unchangedFile(marker);
  await assert.rejects(execute(process.execPath, ['--no-warnings', fileURLToPath(RUNNER_URL), '--state-directory', directory],
    { windowsHide: true, cwd: ROOT, encoding: 'utf8', timeout: 10_000 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /看板后台启动失败：请检查本项目运行记录、登记清单和运行权限。/);
    assert.doesNotMatch(error.stderr, new RegExp(`${directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|BACKGROUND_STATE_DIRECTORY`));
    return true;
  });
  assert.deepEqual(await readdir(directory), ['unchanged.txt']);
  assert.deepEqual(await unchangedFile(marker), before);
});

test('失败诊断拒绝相对路径、临时根、越界根及前缀相似的未授权目录', async t => {
  const own = await fixture(t, 'awr-dashboard-diagnostic-outside-');
  for (const directory of ['', 'relative', os.tmpdir(), ROOT, own.directory, path.join(own.directory, 'state'),
    path.join(own.directory, '..', path.basename(own.directory), 'escaped')]) {
    assert.equal(writeStartupDiagnostic(directory, 'identity', new Error(PRIVATE)), false);
  }
  assert.deepEqual(await readdir(own.directory), []);
});

test('父目录链接拒绝写入，链接所指自有哨兵与目录内容保持不变', async t => {
  const own = await fixture(t);
  const other = await fixture(t);
  const sentinel = path.join(other.directory, 'unchanged.txt');
  await writeFile(sentinel, 'unchanged');
  const before = await unchangedFile(sentinel);
  const junction = path.join(own.directory, 'linked-parent');
  await symlink(other.directory, junction, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(writeStartupDiagnostic(path.join(junction, 'state'), 'identity', new Error(PRIVATE)), false);
    assert.deepEqual(await readdir(other.directory), ['unchanged.txt']);
    assert.deepEqual(await unchangedFile(sentinel), before);
  } finally { await unlink(junction); }
});

test('目标和临时文件硬链接、目录及超限文件均拒绝，不改变其他目标或未知内容', async t => {
  const { directory } = await fixture(t);
  for (const name of ['startup-failure.json', 'startup-failure.tmp']) {
    for (const kind of ['hardlink', 'directory', 'oversized']) {
      const state = path.join(directory, `${name}-${kind}`);
      await mkdir(state);
      const filename = path.join(state, name);
      const sentinel = path.join(state, 'unchanged.txt');
      await writeFile(sentinel, 'unchanged');
      if (kind === 'hardlink') await link(sentinel, filename);
      if (kind === 'directory') await mkdir(filename);
      if (kind === 'oversized') await writeFile(filename, 'x'.repeat(LIMIT + 1));
      const before = await unchangedFile(sentinel);
      const originalBytes = kind === 'oversized' ? await readFile(filename) : null;
      assert.equal(writeStartupDiagnostic(state, 'binding', new Error(PRIVATE)), false);
      assert.deepEqual(await unchangedFile(sentinel), before);
      if (kind === 'oversized') assert.deepEqual(await readFile(filename), originalBytes);
      if (kind === 'directory') assert.ok((await lstat(filename)).isDirectory());
      assert.deepEqual((await readdir(state)).sort(), [name, 'unchanged.txt'].sort());
    }
  }
});

test('未知普通临时残留不抢占、不删除、不覆盖既有完整诊断', async t => {
  const { directory } = await fixture(t);
  assert.equal(writeStartupDiagnostic(directory, 'registry', { code: 'REGISTRY_INVALID' }), true);
  const target = path.join(directory, 'startup-failure.json');
  const temporary = path.join(directory, 'startup-failure.tmp');
  await writeFile(temporary, `unknown-${PRIVATE}`);
  const before = await unchangedFile(target);
  const residual = await unchangedFile(temporary);
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(writeStartupDiagnostic(directory, 'identity', new Error(PRIVATE)), false);
  assert.deepEqual(await unchangedFile(target), before);
  assert.deepEqual(await unchangedFile(temporary), residual);
  assert.deepEqual((await readdir(directory)).sort(), ['startup-failure.json', 'startup-failure.tmp']);
});

test('诊断目标恰好上限仍可替换，重复写入始终只有一个有界固定快照', async t => {
  const { directory } = await fixture(t);
  const target = path.join(directory, 'startup-failure.json');
  await writeFile(target, 'x'.repeat(LIMIT));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(writeStartupDiagnostic(directory, 'binding', { code: 'EACCES', message: PRIVATE }), true);
    snapshot(await readFile(target), { stage: 'binding', category: 'access_denied' });
    assert.deepEqual(await readdir(directory), ['startup-failure.json']);
  }
});

test('诊断写入和原子替换失败返回false、保留旧快照并只清理本次自有临时文件', async t => {
  const { directory } = await fixture(t);
  assert.equal(writeStartupDiagnostic(directory, 'identity', new Error('BACKGROUND_IDENTITY_FAILED')), true);
  const target = path.join(directory, 'startup-failure.json');
  const before = await unchangedFile(target);
  for (const operation of ['writeFileSync', 'renameSync']) {
    await withMocks(t, [[fs, operation, (...args) => {
      if ((operation === 'writeFileSync' && typeof args[0] === 'number')
        || (operation === 'renameSync' && args[0] === path.join(directory, 'startup-failure.tmp'))) {
        throw Object.assign(new Error(PRIVATE), { code: 'EPERM' });
      }
      return original[operation](...args);
    }]], async () => assert.equal(writeStartupDiagnostic(directory, 'registry', { code: 'REGISTRY_INVALID' }), false));
    assert.deepEqual(await unchangedFile(target), before);
    assert.deepEqual(await readdir(directory), ['startup-failure.json']);
  }
});

test('临时快照写后被追加或扩为超限时拒绝发布，旧快照不变且只清理自有文件', async t => {
  const { directory } = await fixture(t);
  assert.equal(writeStartupDiagnostic(directory, 'identity', { code: 'BACKGROUND_IDENTITY_FAILED' }), true);
  const target = path.join(directory, 'startup-failure.json');
  const before = await unchangedFile(target);
  for (const extraLength of [1, LIMIT + 1]) {
    await withMocks(t, [[fs, 'writeFileSync', (...args) => {
      const result = original.writeFileSync(...args);
      // 故障只向本测试刚创建的句柄追加，不按路径写未知目标，也不改变实际项目文件。
      if (typeof args[0] === 'number') fs.writeSync(args[0], Buffer.alloc(extraLength, 120));
      return result;
    }]], async () => assert.equal(writeStartupDiagnostic(directory, 'registry', { code: 'REGISTRY_INVALID' }), false));
    assert.deepEqual(await unchangedFile(target), before);
    assert.deepEqual(await readdir(directory), ['startup-failure.json']);
  }
});

test('失败清理不能重新核对父目录链时保留自有残留，不再执行unlink', async t => {
  const { directory } = await fixture(t);
  const temporary = path.join(directory, 'startup-failure.tmp');
  let failDirectoryCheck = false;
  let attemptedRemoval = 0;
  await withMocks(t, [
    [fs, 'writeFileSync', (...args) => {
      if (typeof args[0] === 'number') { failDirectoryCheck = true; throw new Error(PRIVATE); }
      return original.writeFileSync(...args);
    }],
    [fs, 'lstatSync', (filename, options) => {
      // 只模拟核验失败，不实际创建重定向，因此测试清理绝不沿越界链接删除。
      if (failDirectoryCheck && filename === directory) throw new Error('BACKGROUND_STATE_LINK');
      return original.lstatSync(filename, options);
    }],
    [fs, 'unlinkSync', filename => { attemptedRemoval += 1; return original.unlinkSync(filename); }],
  ], async () => assert.equal(writeStartupDiagnostic(directory, 'identity', { code: 'EPERM' }), false));
  assert.equal(attemptedRemoval, 0);
  assert.equal((await lstat(temporary)).size, 0);
  assert.deepEqual(await readdir(directory), ['startup-failure.tmp']);
});

test('目标在写句柄取得后变为硬链接仍拒绝替换，不修改或删除链接所指内容', async t => {
  const { directory } = await fixture(t);
  const sentinel = path.join(directory, 'unchanged.txt');
  const target = path.join(directory, 'startup-failure.json');
  await writeFile(sentinel, 'unchanged');
  assert.equal(writeStartupDiagnostic(directory, 'identity', { code: 'EPERM' }), true);
  await withMocks(t, [[fs, 'writeFileSync', (...args) => {
    const result = original.writeFileSync(...args);
    if (typeof args[0] === 'number') { original.unlinkSync(target); fs.linkSync(sentinel, target); }
    return result;
  }]], async () => assert.equal(writeStartupDiagnostic(directory, 'registry', { code: 'REGISTRY_INVALID' }), false));
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.equal((await lstat(target)).nlink, 2);
  assert.deepEqual((await readdir(directory)).sort(), ['startup-failure.json', 'unchanged.txt']);
});

test('临时路径身份被替换后不删除未知替代文件，也不把替代内容提升为诊断', async t => {
  const { directory } = await fixture(t);
  const temporary = path.join(directory, 'startup-failure.tmp');
  const moved = path.join(directory, 'owned-moved.tmp');
  await withMocks(t, [[fs, 'writeFileSync', (...args) => {
    const result = original.writeFileSync(...args);
    if (typeof args[0] === 'number') {
      original.renameSync(temporary, moved);
      original.writeFileSync(temporary, `replacement-${PRIVATE}`, { flag: 'wx' });
    }
    return result;
  }]], async () => assert.equal(writeStartupDiagnostic(directory, 'identity', { code: 'EACCES' }), false));
  assert.equal(await readFile(temporary, 'utf8'), `replacement-${PRIVATE}`);
  snapshot(await readFile(moved), { stage: 'identity', category: 'access_denied' });
  assert.deepEqual((await readdir(directory)).sort(), ['owned-moved.tmp', 'startup-failure.tmp']);
});

test('固定排他临时文件锁持有期间并发竞争者均失败，只有锁拥有者提交完整快照', { timeout: 10_000 }, async t => {
  const own = await fixture(t);
  assert.equal(writeStartupDiagnostic(own.directory, 'registry', { code: 'REGISTRY_INVALID' }), true);
  const target = path.join(own.directory, 'startup-failure.json');
  const before = await unchangedFile(target);
  const barrier = new SharedArrayBuffer(4);
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { parentPort, workerData } from 'node:worker_threads';
    const { writeStartupDiagnostic } = await import(workerData.url);
    const originalOpen = fs.openSync;
    fs.openSync = (...args) => {
      const descriptor = originalOpen(...args);
      if (String(args[0]).endsWith('startup-failure.tmp')) {
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      }
      return descriptor;
    };
    syncBuiltinESMExports();
    try { parentPort.postMessage({ done: true, passed: writeStartupDiagnostic(workerData.directory, 'identity', { code: 'EPERM' }) }); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  `;
  const writer = diagnosticWorker(own, source, { barrier });
  await writer.ready;
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(writeStartupDiagnostic(own.directory, 'registry', { code: 'REGISTRY_INVALID' }), false);
  assert.deepEqual(await unchangedFile(target), before);
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  assert.equal((await writer.done).passed, true);
  await writer.exited;
  snapshot(await readFile(target), { stage: 'identity', category: 'access_denied' });
  assert.deepEqual(await readdir(own.directory), ['startup-failure.json']);
});

test('三个诊断写线程并发时读取只见完整固定快照，结束后文件数和大小仍有界', { timeout: 10_000 }, async t => {
  const own = await fixture(t);
  assert.equal(writeStartupDiagnostic(own.directory, 'registry', { code: 'REGISTRY_INVALID' }), true);
  const target = path.join(own.directory, 'startup-failure.json');
  const barrier = new SharedArrayBuffer(4);
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { writeStartupDiagnostic } = await import(workerData.url);
    parentPort.postMessage({ ready: true });
    Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
    let written = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (writeStartupDiagnostic(workerData.directory, 'registry', { code: 'REGISTRY_INVALID' })) written += 1;
    }
    parentPort.postMessage({ done: true, written });
  `;
  const writers = Array.from({ length: 3 }, () => diagnosticWorker(own, source, { barrier }));
  await Promise.all(writers.map(writer => writer.ready));
  let finished = false;
  const all = Promise.all(writers.map(writer => writer.done)).then(results => { finished = true; return results; });
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  let observed = 0;
  while (!finished) {
    snapshot(await readFile(target), { stage: 'registry', category: 'REGISTRY_INVALID' });
    observed += 1;
    const names = await readdir(own.directory);
    assert.ok(names.length <= 2 && names.every(name => ['startup-failure.json', 'startup-failure.tmp'].includes(name)));
  }
  assert.ok(observed > 0);
  assert.ok((await all).reduce((total, item) => total + item.written, 0) > 0);
  await Promise.all(writers.map(writer => writer.exited));
  snapshot(await readFile(target), { stage: 'registry', category: 'REGISTRY_INVALID' });
  assert.deepEqual(await readdir(own.directory), ['startup-failure.json']);
});

test('早期原生查询、绑定读取和严格身份绑定失败都保存阶段类别但不输出敏感错误', { timeout: 10_000 }, async t => {
  const variants = [
    { stage: 'identity', category: 'BACKGROUND_PROCESS_QUERY_DENIED', nativeError: Object.assign(new Error(PRIVATE),
      { stdout: 'BACKGROUND_PROCESS_QUERY_DENIED', stderr: PRIVATE, status: 1 }) },
    { stage: 'identity', category: 'BACKGROUND_TOKEN_QUERY_FAILED', nativeError: Object.assign(new Error(PRIVATE),
      { stdout: 'BACKGROUND_TOKEN_QUERY_FAILED', stderr: PRIVATE, status: 1 }) },
    { stage: 'binding', category: 'access_denied', bindingError: Object.assign(new Error(PRIVATE), { code: 'EACCES' }) },
    { stage: 'identity_binding', category: 'BACKGROUND_BINDING_VERSION_MISMATCH', settings: { version: 2 } },
    { stage: 'identity_binding', category: 'BACKGROUND_USER_MISMATCH', identity: { userSid: 'S-1-5-18' } },
    { stage: 'identity_binding', category: 'BACKGROUND_ELEVATED_TOKEN', identity: { elevated: true } },
    { stage: 'identity_binding', category: 'BACKGROUND_NODE_PATH_MISMATCH', settings: { nodePath: path.join(os.tmpdir(), `${PRIVATE}.exe`) } },
  ];
  for (const variant of variants) {
    const options = await runnerFixture(t);
    const messages = [];
    await withMocks(t, [...identityMocks(variant), [console, 'error', (...args) => messages.push(args.join(' '))]], async () => {
      assert.equal(await runBackground(options), 1);
    });
    snapshot(await readFile(path.join(options.stateDirectory, 'startup-failure.json')), { stage: variant.stage, category: variant.category });
    assert.deepEqual(await readdir(options.stateDirectory), ['startup-failure.json']);
    assert.doesNotMatch(messages.join('\n'), new RegExp(`${PRIVATE}|S-1-5-18|stdout|stderr|stack`));
  }
});

test('原生查询抛空值或不可信错误字段访问器仍返回失败并保存unknown诊断', { timeout: 10_000 }, async t => {
  const hostile = {
    stdout: '',
    stderr: PRIVATE,
    get code() { throw new Error(PRIVATE); },
    message: PRIVATE,
  };
  for (const nativeError of [null, hostile]) {
    const options = await runnerFixture(t);
    const messages = [];
    await withMocks(t, [...identityMocks({ nativeError }), [console, 'error', (...args) => messages.push(args.join(' '))]], async () => {
      assert.equal(await runBackground(options), 1);
    });
    snapshot(await readFile(path.join(options.stateDirectory, 'startup-failure.json')), { stage: 'identity', category: 'unknown' });
    assert.deepEqual(await readdir(options.stateDirectory), ['startup-failure.json']);
    assert.match(messages.join('\n'), /未建立可验证运行身份/);
    assert.doesNotMatch(messages.join('\n'), new RegExp(`${PRIVATE}|stdout|stderr|stack|TypeError`));
  }
});

test('平台与登记清单前置失败也有独立诊断，尚未建立监听或运行身份记录', async t => {
  const unsupported = await runnerFixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  await withMocks(t, [[console, 'error', () => {}]], async () => {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'synthetic-unsupported' });
    try { assert.equal(await runBackground(unsupported), 1); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
  });
  snapshot(await readFile(path.join(unsupported.stateDirectory, 'startup-failure.json')), { stage: 'platform', category: 'BACKGROUND_WINDOWS_REQUIRED' });
  const invalidRegistry = await runnerFixture(t);
  await writeFile(invalidRegistry.registryPath, `{${PRIVATE}`);
  await withMocks(t, [...identityMocks(), [console, 'error', () => {}]], async () => assert.equal(await runBackground(invalidRegistry), 1));
  snapshot(await readFile(path.join(invalidRegistry.stateDirectory, 'startup-failure.json')), { stage: 'registry', category: 'REGISTRY_INVALID' });
  assert.deepEqual(await readdir(invalidRegistry.stateDirectory), ['startup-failure.json']);
});

test('诊断写入及清理本身失败不掩盖原启动失败，旧快照保持且未知临时残留不抢占', async t => {
  const options = await runnerFixture(t);
  await mkdir(options.stateDirectory);
  assert.equal(writeStartupDiagnostic(options.stateDirectory, 'registry', { code: 'REGISTRY_INVALID' }), true);
  const target = path.join(options.stateDirectory, 'startup-failure.json');
  const temporary = path.join(options.stateDirectory, 'startup-failure.tmp');
  const before = await unchangedFile(target);
  const messages = [];
  await withMocks(t, [...identityMocks({ identity: { elevated: true } }),
    [console, 'error', (...args) => messages.push(args.join(' '))],
    [fs, 'writeFileSync', (...args) => { if (typeof args[0] === 'number') throw new Error(PRIVATE); return original.writeFileSync(...args); }],
    [fs, 'unlinkSync', filename => { if (filename === temporary) throw new Error(PRIVATE); return original.unlinkSync(filename); }],
  ], async () => assert.equal(await runBackground(options), 1));
  assert.deepEqual(await unchangedFile(target), before);
  assert.equal((await lstat(temporary)).size, 0);
  assert.match(messages.join('\n'), /原失败状态保持不变/);
  assert.doesNotMatch(messages.join('\n'), new RegExp(PRIVATE));
  const residual = await unchangedFile(temporary);
  assert.equal(writeStartupDiagnostic(options.stateDirectory, 'registry', { code: 'REGISTRY_INVALID' }), false);
  assert.deepEqual(await unchangedFile(temporary), residual);
});

test('重复失败诊断不改变已健康夹具的日志、运行身份、监听及进程存活', { timeout: 15_000 }, async t => {
  const options = await runnerFixture(t);
  const messages = [];
  await withMocks(t, [...identityMocks(), [console, 'error', (...args) => messages.push(args.join(' '))]], async () => {
    let healthyFinished = false;
    const healthy = runBackground(options).finally(() => { healthyFinished = true; });
    try {
      const recordPath = path.join(options.stateDirectory, 'instance.json');
      await waitFor(async () => { try { return (await readFile(recordPath)).length; } catch { return false; } });
      const record = await unchangedFile(recordPath);
      const serviceLog = await unchangedFile(path.join(options.stateDirectory, 'service.log'));
      assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(2000) })).status, 200);
      assert.equal(await runBackground(options), 1);
      snapshot(await readFile(path.join(options.stateDirectory, 'startup-failure.json')), { stage: 'listen', category: 'port_in_use' });
      assert.deepEqual(await unchangedFile(recordPath), record);
      assert.deepEqual(await unchangedFile(path.join(options.stateDirectory, 'service.log')), serviceLog);
      assert.equal(healthyFinished, false);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
      assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(2000) })).status, 200);
      assert.doesNotMatch(messages.join('\n'), new RegExp(PRIVATE));
    } finally {
      // 仅派发本测试进程中的停止事件，不向系统进程发送信号、不结束真实服务。
      process.emit('SIGTERM');
      assert.equal(await healthy, 0);
    }
  });
});

test('真实入口身份失败时不执行服务或登记模块的顶层代码', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const { directory } = await fixture(t);
  const stateDirectory = path.join(directory, 'run', 'background');
  const copiedRunner = path.join(directory, 'bin', 'background-runner.mjs');
  const marker = path.join(directory, 'premature-import.txt');
  await Promise.all(['bin', 'ops', 'src'].map(name => mkdir(path.join(directory, name))));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(copiedRunner, await readFile(fileURLToPath(RUNNER_URL)));
  // 只在合成根创建无效绑定和有副作用的模块，不修改真实绑定或实际业务源码。
  // 版本门禁应在任何业务模块导入前失败；标记文件可观察静态提前导入的回归。
  await writeFile(path.join(directory, 'ops', 'background-settings.json'), JSON.stringify({
    version: 0, userSid: 'S-1-5-21-100', nodePath: process.execPath,
  }));
  const trap = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected'); throw new Error('premature-module-load');`;
  await Promise.all(['server.js', 'registry.js'].map(name => writeFile(path.join(directory, 'src', name), trap)));
  await assert.rejects(execute(process.execPath, ['--no-warnings', copiedRunner], {
    cwd: directory, windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024,
  }), error => error.code === 1 && !String(error.stderr).includes('premature-module-load'));
  assert.equal(fs.existsSync(marker), false);
  snapshot(await readFile(path.join(stateDirectory, 'startup-failure.json')), {
    stage: 'identity_binding', category: 'BACKGROUND_BINDING_VERSION_MISMATCH',
  });
  assert.deepEqual(await readdir(stateDirectory), ['startup-failure.json']);
});
