import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { NATIVE_COMPILER, nativeSkipReason } from './native/native-test-support.mjs';
// 正式验证器只枚举tests根目录；显式引入隔离构建测试，避免嵌套文件被正式回归漏掉。
import './native/builder-fixture.test.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const FIXTURES = path.join(ROOT, 'tests', 'native');
const SOURCE = path.join(ROOT, 'ops', 'native', 'background-launcher.c');
const COMPILER = NATIVE_COMPILER;
const execute = promisify(execFile);

/** 创建唯一测试目录；不复用生产构建、运行或系统保护目录，删除前重新核对真实路径与父边界。 */
async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'awr-dashboard-native-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    const relative = path.relative(temporaryRoot, absolute);
    assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..'));
    assert.ok(path.basename(absolute).startsWith('awr-dashboard-native-'));
    assert.equal((await realpath(absolute)).toLowerCase(), absolute.toLowerCase());
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}

/** 把本测试固定值机械转为C宽字符串；不把路径、环境或参数解释成C源码片段。 */
function wideLiteral(value) {
  return `L"${String(value).replace(/[\\"\r\n\t]|[^\x20-\x7e]/g, character => {
    if (character === '\\') return '\\\\';
    if (character === '"') return '\\"';
    if (character === '\r') return '\\r';
    if (character === '\n') return '\\n';
    if (character === '\t') return '\\t';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  })}"`;
}

/** 生成仅夹具编译可见的绑定头；编译器搜索路径不指向生产生成目录，不能改变真实绑定产物。 */
async function binding(directory) {
  const runner = path.join(FIXTURES, 'job-child.mjs');
  const fields = {
    AWR_USER_SID: 'S-1-5-21-101-202-303-1001',
    AWR_PROJECT_ROOT: directory,
    AWR_NODE_PATH: process.execPath,
    AWR_RUNNER_PATH: runner,
    AWR_REGISTRY_PATH: path.join(directory, 'fixture-registry.json'),
    AWR_STATE_DIRECTORY: path.join(directory, 'fixture-state'),
    AWR_LAUNCHER_PATH: path.join(directory, 'fixture-launcher.exe'),
    AWR_TEMP_DIRECTORY: directory,
    AWR_COMMAND_LINE: `"${process.execPath}" "${runner}"`,
  };
  const lines = Object.entries(fields).map(([name, value]) => `static const wchar_t ${name}[] = ${wideLiteral(value)};`);
  await writeFile(path.join(directory, 'background-binding.h'),
    `#ifndef AWR_FIXTURE_BINDING_H\n#define AWR_FIXTURE_BINDING_H\n#include <wchar.h>\n${lines.join('\n')}\n#define AWR_PORT 4317\n#endif\n`, { flag: 'wx' });
}

/** 用现有32位编译器构建专用夹具；普通子进程隐藏窗口，输出有界，既不安装组件也不调用生产构建脚本。 */
async function compile(directory, filename, output) {
  const result = await execute(COMPILER, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-variable',
    '-Wno-unused-function', '-D_WIN32_WINNT=0x0A00', '-static-libgcc', '-I', directory,
    path.resolve(FIXTURES, filename), '-o', path.join(directory, output), '-ladvapi32'],
  { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 });
  assert.equal(result.stderr.trim(), '', '夹具编译不应留下未处理警告。');
  return path.join(directory, output);
}

/** 执行仅本测试编译的原生程序，解析其有界机器结果；超时只结束这个ChildProcess句柄。 */
async function run(binary, args = [], options = {}) {
  const result = await execute(binary, args, { windowsHide: true, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 128 * 1024, ...options });
  return JSON.parse(result.stdout.trim());
}

test('G2真实普通权限作业：创建结果发布前、恢复前及等待期硬停止父后合成子树均退出',
  { timeout: 120_000 }, async t => {
    const unavailable = await nativeSkipReason({ toolchain: true, jobs: true });
    if (unavailable) { t.skip(unavailable); return; }
    const directory = await fixture(t);
    await binding(directory);
    const binary = await compile(directory, 'job-lifecycle.c', 'job-lifecycle.exe');
    // 当前编译器是32位；固定Node来自本次测试进程，真实跨位数条件必须由运行事实满足。
    assert.equal(process.arch, 'x64', '此机专项要求32位夹具创建64位Node，不能把其他位数组合冒称已验。');
    for (const mode of ['creation', 'before-resume', 'waiting', 'exit-code']) {
      await t.test(mode, async () => {
        const result = await run(binary, [mode]);
        assert.equal(result.evidence, 'real-job-limited-fixture-not-s4u');
        assert.equal(result.pointerBits, 32);
        assert.equal(result.limitedParent, true);
        assert.equal(result.childImageVerified, true);
        assert.equal(result.creationIdentityVerified, true);
        assert.equal(result.parentAliveDuringAcquisition, true);
        assert.equal(result.guardOpenDuringAssertions, true);
        assert.equal(result.scopedGuardActiveZero, true);
        assert.equal(result.childrenExited, true);
        assert.equal(result.cleanupVerified, true);
        assert.equal(result.innerJobInherited, false);
        assert.equal(result.unknownProcessesScanned, false);
        assert.equal(result.phase, mode === 'creation' ? 1 : mode === 'before-resume' ? 2 : 3);
        // creation明确停在成功创建返回后、发布root元数据之前，不把phase1解释为内核调用中点。
        assert.equal(result.creationReturned, true);
        assert.equal(result.metadataPublished, mode !== 'creation');
        assert.ok(Number.isInteger(result.setupElapsedMs) && result.setupElapsedMs >= 0);
        assert.ok(Number.isInteger(result.observationElapsedMs) && result.observationElapsedMs >= 0);
        assert.equal(result.nodeCount, mode === 'waiting' ? 2 : 1);
        if (mode === 'exit-code') {
          assert.equal(result.parentExitCode, 0xf1234567);
          assert.equal(result.childExitCode, 0xf1234567);
        } else assert.equal(result.parentStoppedViaHeldHandle, true);
        t.diagnostic(JSON.stringify(result));
      });
    }
    await t.test('inner-job-required', async () => {
      // 只在临时夹具副本去掉内层关闭即杀树：外层guard继续打开，必须观察到子未退出而失败。
      // 这证明正常通过依赖内层作业语义，不能由最终关闭guard的兜底清理制造假绿。
      const source = await readFile(path.join(FIXTURES, 'job-lifecycle.c'), 'utf8');
      const assignment = 'limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;';
      assert.equal(source.split(assignment).length - 1, 2, '仅允许精确修改父内层作业，外层guard仍保留。');
      const mutantPath = path.join(directory, 'job-lifecycle-no-inner-kill.c');
      await writeFile(mutantPath, source.replace(assignment, 'limits.BasicLimitInformation.LimitFlags = 0;'), { flag: 'wx' });
      const mutant = await compile(directory, mutantPath, 'job-lifecycle-no-inner-kill.exe');
      await assert.rejects(run(mutant, ['creation']), error => {
        assert.equal(error.code, 1);
        assert.equal(error.killed, false);
        assert.equal(error.signal, null);
        assert.match(error.stderr, /stage=children-exit mode=1 error=1460 phase=1/);
        assert.match(error.stderr, /creationReturned=1 metadataPublished=0/);
        assert.match(error.stderr, /childWaitResult=258 cleanupVerified=true/);
        return true;
      });
      t.diagnostic('inner-job-negative: observed child timeout before outer guard cleanup; expected failure preserved');
    });
  });

test('G2接口替身直接编译生产源：令牌、父保护、作业属性、环境、挂起核验和清理失败关闭',
  { timeout: 120_000 }, async t => {
    // 协议接口使用内存替身，不需要真实作业/权限门禁；仅核对其实际编译运行条件。
    const unavailable = await nativeSkipReason({ toolchain: true });
    if (unavailable) { t.skip(unavailable); return; }
    const directory = await fixture(t);
    await binding(directory);
    const sourceSha256 = createHash('sha256').update(await readFile(SOURCE)).digest('hex');
    const binary = await compile(directory, 'launcher-protocol.c', 'launcher-protocol.exe');
    const result = await run(binary, [], { env: { ...process.env, NODE_OPTIONS: '--require fixture-injected-code',
      NODE_PATH: 'C:\\fixture-injected-modules', HTTP_PROXY: 'http://fixture.invalid', HTTPS_PROXY: 'http://fixture.invalid',
      ALL_PROXY: 'http://fixture.invalid', PATH: 'C:\\fixture-injected-path', TEMP: directory, TMP: directory } });
    assert.equal(result.evidence, 'fake-api-production-source-protocol-not-s4u');
    assert.equal(result.failed, 0);
    assert.ok(result.passed >= 20, '必须运行具体成功/负面断言，不能只把编译成功当协议验证。');
    assert.ok(result.allocationFailureScenarios > 0);
    assert.equal(createHash('sha256').update(await readFile(SOURCE)).digest('hex'), sourceSha256, '协议编译与执行期间生产源必须保持同一字节。');
    t.diagnostic(JSON.stringify({ ...result, sourceSha256 }));
  });

test('G2生产源没有测试绕过、创建后关联回退或继承环境复制接口', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.doesNotMatch(source, /^\s*#\s*(?:if|ifdef|ifndef).*\b(?:TEST|TESTING|AWR_TEST)\b/m);
  assert.doesNotMatch(source, /\bAssignProcessToJobObject\s*\(/);
  assert.doesNotMatch(source, /\b(?:GetEnvironmentStringsW?|CreateEnvironmentBlock)\s*\(/);
});
