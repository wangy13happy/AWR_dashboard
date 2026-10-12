import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const execute = promisify(execFile);
const windows = process.platform === 'win32';
const APPROVED_DUMP = 'Magic 010b (PE32)\nEntry d 00000000 00000000 Delay Import Directory\n DLL Name: KERNEL32.dll\n DLL Name: ADVAPI32.dll\n DLL Name: msvcrt.dll';
const PUBLISHED = ['background-launcher.exe', 'build-receipt.json', 'source-manifest.json'];
const SYNTHETIC_C = `#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include "background-binding.h"
/* 仅用于编译和导入表检查，测试始终不执行此程序。所有绑定均引用以保持严格警告门禁。 */
int main(void) {
  const wchar_t *values[] = {AWR_USER_SID, AWR_PROJECT_ROOT, AWR_NODE_PATH, AWR_RUNNER_PATH,
    AWR_REGISTRY_PATH, AWR_STATE_DIRECTORY, AWR_LAUNCHER_PATH, AWR_TEMP_DIRECTORY, AWR_COMMAND_LINE};
  HANDLE token = NULL;
  size_t total = 0;
  unsigned int index;
  for (index = 0; index < sizeof(values) / sizeof(values[0]); ++index) total += wcslen(values[index]);
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) CloseHandle(token);
  return (int)((GetCurrentProcessId() + total + AWR_PORT) & 0x7f);
}
`;

/** 转义PowerShell数据字面量；所有脚本路径只来自本测试临时项目，不把数据解释为命令。 */
function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }

/** 对实际字节计算安全散列；清单和收据不通过自己的声明相互证明。 */
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** 在任何临时写入和递归删除前验证精确边界，拒绝相对逃逸、临时根本身或根目录替代。 */
function assertScopedPath(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** 创建合成项目并复制固定脚本原字节；只生成极简C，不复用生产构建目录、不运行服务入口。 */
async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'awr-dashboard-builder-fixture-'));
  const project = path.join(directory, 'synthetic project');
  assertScopedPath(temporaryRoot, directory);
  assertScopedPath(directory, project);
  t.after(async () => {
    assertScopedPath(temporaryRoot, directory);
    assert.ok(path.basename(directory).startsWith('awr-dashboard-builder-fixture-'));
    assert.equal((await realpath(directory)).toLowerCase(), path.resolve(directory).toLowerCase());
    await rm(directory, { recursive: true, force: true });
  });
  for (const relative of ['ops/native', 'bin', 'config']) {
    const target = path.join(project, relative);
    assertScopedPath(directory, target);
    await mkdir(target, { recursive: true });
  }
  const paths = {
    builder: path.join(project, 'ops', 'build-background-launcher.ps1'),
    manager: path.join(project, 'ops', 'manage-background.ps1'),
    source: path.join(project, 'ops', 'native', 'background-launcher.c'),
    runner: path.join(project, 'bin', 'background-runner.mjs'),
    registry: path.join(project, 'config', 'projects.json'),
    build: path.join(project, 'run', 'background-launcher-build'),
  };
  // 历史构建器仍加载当前管理器预检；补齐固定隐藏包装输入，但夹具禁止执行它或操作真实任务。
  for (const relative of ['ops/build-background-launcher.ps1', 'ops/manage-background.ps1', 'ops/background-settings.json', 'ops/start-background-hidden.vbs']) {
    const target = path.join(project, relative);
    assertScopedPath(directory, target);
    await writeFile(target, await readFile(path.join(ROOT, relative)), { flag: 'wx' });
  }
  await writeFile(paths.source, SYNTHETIC_C, { flag: 'wx' });
  await writeFile(paths.runner, 'throw new Error("合成入口不得执行");\n', { flag: 'wx' });
  await writeFile(paths.registry, '{"version":1,"defaultProjectId":null,"projects":[]}\n', { flag: 'wx' });
  return { directory, project, ...paths };
}

/** 只在普通权限隐藏PowerShell内运行合成脚本；屏蔽全部任务操作及普通进程启动接口。 */
async function powershell(options, body) {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ProgressPreference='SilentlyContinue'
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'fixture-requires-limited-token' }
function Get-ScheduledTask { <# 构建测试不得查询真实任务。 #> throw 'fixture-unexpected-task-query' }
function Get-ScheduledTaskInfo { <# 构建测试不得查询真实任务。 #> throw 'fixture-unexpected-task-info' }
function Register-ScheduledTask { <# 构建测试不得写入真实任务。 #> throw 'fixture-unexpected-register' }
function Start-ScheduledTask { <# 构建测试不得启动真实任务。 #> throw 'fixture-unexpected-start' }
function Stop-ScheduledTask { <# 构建测试不得停止真实任务。 #> throw 'fixture-unexpected-stop' }
function Enable-ScheduledTask { <# 构建测试不得启用真实任务。 #> throw 'fixture-unexpected-enable' }
function Disable-ScheduledTask { <# 构建测试不得停用真实任务。 #> throw 'fixture-unexpected-disable' }
function Unregister-ScheduledTask { <# 构建测试不得注销真实任务。 #> throw 'fixture-unexpected-unregister' }
function Start-Process { <# 除固定编译器/检查工具的直接调用，不允许生成产物或其他程序启动。 #> throw 'fixture-unexpected-process-start' }
. ${literal(options.builder)}
${body}`;
  // Node由PowerShell7启动时可能继承其模块搜索路径；只调整本测试子进程，不能全局修改环境。
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.toLowerCase() === 'psmodulepath') delete environment[name];
  try {
    return await execute(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: options.project, env: environment, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    // 失败结果保留真正退出码和有界错误正文，不把整份编码脚本重复打印成巨量诊断。
    throw new Error(`隔离构建PowerShell退出${error.code ?? '未知'}：${String(error.stderr ?? error.message).slice(-5000)}`);
  }
}

/** 仅调用合成项目中的生产构建函数；工具可执行但生成的程序永不执行。 */
async function build(options) {
  const result = await powershell(options, 'Invoke-LauncherBuild | ConvertTo-Json -Depth 5 -Compress');
  return JSON.parse(result.stdout.trim());
}

/** 读取固定发布文件的原字节，失败门禁后必须逐字保持旧收据和旧程序。 */
async function publishedBytes(options) {
  return Promise.all(PUBLISHED.map(name => readFile(path.join(options.build, name))));
}

/** 只查询专用临时路径存在性；不读取公共应用数据目录或生产构建根。 */
async function exists(target) {
  try { await access(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** 解码生成头中的UTF-16数组，独立比较完整命令而不只搜索入口名。 */
function wideConstant(header, name) {
  const match = header.match(new RegExp(`static const wchar_t ${name}\\[\\] = \\{ ([^}]+), 0 \\};`));
  assert.ok(match, `缺少固定宽字符绑定：${name}`);
  return String.fromCharCode(...match[1].split(', ').map(unit => Number.parseInt(unit, 16)));
}

/** 将固定工具路径映射为内存函数，仅产生本次合成暂存字节及导入表，不改生产编译接口。 */
function simulatedTools(options, dump, mutationTarget = null) {
  if (mutationTarget) assertScopedPath(options.directory, mutationTarget);
  return `$script:fixturePending=${literal(path.join(options.build, 'background-launcher.pending.exe'))}
$script:fixtureMutation=${mutationTarget ? literal(mutationTarget) : '$null'}
$script:fixtureDump=${literal(dump)}
$script:fixtureCompileCalls=0
Set-Item -LiteralPath 'Function:\\C:\\MinGW\\bin\\gcc.exe' -Value {
  <# 固定路径工具夹具不会调用真实编译器；输出名必须等于专用项目的固定暂存名。 #>
  if ($args.Count -eq 1 -and $args[0] -ceq '-dumpmachine') { $global:LASTEXITCODE=0; return 'mingw32' }
  $outputIndex=[Array]::IndexOf([string[]]$args,'-o')
  if ($outputIndex -lt 0 -or $args[$outputIndex+1] -cne $script:fixturePending) { throw 'fixture-compiler-output-escape' }
  $script:fixtureCompileCalls++
  [IO.File]::WriteAllBytes($script:fixturePending,[Text.Encoding]::UTF8.GetBytes('fixture-not-runnable-artifact'))
  if ($script:fixtureMutation) { [IO.File]::AppendAllText($script:fixtureMutation,"\n/* fixture-input-mutated-during-compile */\n",[Text.UTF8Encoding]::new($false)) }
  $global:LASTEXITCODE=0
}
Set-Item -LiteralPath 'Function:\\C:\\MinGW\\bin\\objdump.exe' -Value {
  <# 固定路径导入表夹具只返回受控文本，不执行生成产物。 #>
  $global:LASTEXITCODE=0
  return ($script:fixtureDump -split "\n")
}
`;
}

test('G2构建器隔离联测：四源清单、完整绑定、32位系统导入与重复发布', { skip: !windows }, async t => {
  const options = await fixture(t);
  const first = await build(options);
  const manifestPath = path.join(options.build, 'source-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const expectedPaths = ['ops/build-background-launcher.ps1', 'ops/manage-background.ps1',
    'ops/native/background-launcher.c', 'run/background-launcher-build/background-binding.h'];
  assert.deepEqual(manifest.map(entry => entry.path), expectedPaths);
  for (const entry of manifest) assert.equal(entry.sha256, sha256(await readFile(path.join(options.project, entry.path))));
  assert.equal(first.sourceManifestSha256, sha256(manifestBytes));
  assert.equal(first.launcherSha256, sha256(await readFile(path.join(options.build, 'background-launcher.exe'))));
  assert.equal(first.projectRoot, options.project);
  assert.equal(first.nodePath.toLowerCase(), process.execPath.toLowerCase());
  assert.deepEqual(first.nodeArguments, ['--no-warnings', options.runner, '--port', '4317', '--projects', options.registry,
    '--state-directory', path.join(options.project, 'run', 'background')]);
  const header = await readFile(path.join(options.build, 'background-binding.h'), 'utf8');
  const command = `"${first.nodePath}" --no-warnings "${options.runner}" --port 4317 --projects "${options.registry}" --state-directory "${path.join(options.project, 'run', 'background')}"`;
  assert.equal(wideConstant(header, 'AWR_COMMAND_LINE'), command);
  assert.equal(wideConstant(header, 'AWR_PROJECT_ROOT'), options.project);
  assert.equal(wideConstant(header, 'AWR_USER_SID'), first.userSid);
  assert.equal(wideConstant(header, 'AWR_LAUNCHER_PATH'), first.launcherPath);
  const imports = await readFile(path.join(options.build, 'objdump-imports.txt'), 'utf8');
  assert.match(imports, /^Magic\s+010b\s+\(PE32\)\s*$/m);
  assert.match(imports, /^Entry d\s+0+\s+0+\s+Delay Import Directory\s*$/m);
  assert.deepEqual(first.imports, ['advapi32.dll', 'kernel32.dll', 'msvcrt.dll']);
  assert.equal(first.architecture, 'PE32 / mingw32');
  const second = await build(options);
  assert.equal(second.launcherSha256, sha256(await readFile(path.join(options.build, 'background-launcher.exe'))));
  assert.equal(second.sourceManifestSha256, first.sourceManifestSha256);
  assert.equal(await exists(path.join(options.build, 'background-launcher.pending.exe')), false);
  const savedReceipt = JSON.parse(await readFile(path.join(options.build, 'build-receipt.json'), 'utf8'));
  assert.deepEqual(savedReceipt, second);
  t.diagnostic(JSON.stringify({ evidence: 'isolated-real-compiler-builder-not-production-launcher',
    manifestEntriesVerified: manifest.length, completeCommandVerified: true, architecture: second.architecture,
    imports: second.imports, delayImportAddressAndSizeZero: true, repeatedPublication: true,
    sourceManifestSha256: second.sourceManifestSha256, launcherSha256: second.launcherSha256,
    compiledArtifactExecuted: false, taskOperations: false }));
});

test('G2构建器不提供路径/命令/账户覆盖参数，拒绝发生在任何构建写入之前', { skip: !windows }, async t => {
  const options = await fixture(t);
  for (const name of ['NodePath', 'ProjectRoot', 'UserSid', 'Command']) {
    const result = await powershell(options, `
$rejected=$false
try { . ${literal(options.builder)} -${name} 'fixture-disallowed-override' } catch { $rejected=$true }
$tokens=$null; $parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${literal(options.builder)},[ref]$tokens,[ref]$parseErrors)
[pscustomobject]@{Rejected=$rejected;DeclaredParameters=$ast.ParamBlock.Parameters.Count;ParseErrors=$parseErrors.Count} | ConvertTo-Json -Compress
`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { Rejected: true, DeclaredParameters: 0, ParseErrors: 0 });
  }
  assert.equal(await exists(options.build), false);
  t.diagnostic(JSON.stringify({ evidence: 'isolated-builder-parameter-binding', rejectedOverrides: 4,
    declaredParameters: 0, buildDirectoryCreated: false, compiledArtifactExecuted: false, taskOperations: false }));
});

test('G2构建期间合成C变化拒绝发布，旧程序/清单/收据原字节保留', { skip: !windows }, async t => {
  const options = await fixture(t);
  await build(options);
  const before = await publishedBytes(options);
  const sourceBefore = await readFile(options.source);
  const result = await powershell(options, simulatedTools(options, APPROVED_DUMP, options.source) + `
$rejected=$false; $message=''
try { $null=Invoke-LauncherBuild } catch { $rejected=$true; $message=$_.Exception.Message }
[pscustomobject]@{Rejected=$rejected;Message=$message;CompileCalls=$script:fixtureCompileCalls} | ConvertTo-Json -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.equal(checks.Rejected, true);
  assert.match(checks.Message, /固定源码\/绑定发生变化/);
  assert.equal(checks.CompileCalls, 1);
  assert.deepEqual(await publishedBytes(options), before);
  assert.notEqual(sha256(await readFile(options.source)), sha256(sourceBefore));
  assert.equal(await exists(path.join(options.build, 'background-launcher.pending.exe')), true);
  t.diagnostic(JSON.stringify({ evidence: 'isolated-builder-fixed-compiler-function-source-mutation',
    rejected: true, simulatedCompileCalls: checks.CompileCalls, publishedFilesByteEqual: 3,
    sourceChanged: true, pendingPreserved: true, compiledArtifactExecuted: false, taskOperations: false }));
});

test('G2构建器拒绝不允许导入、延迟导入及未知结构，不覆盖旧发布', { skip: !windows }, async t => {
  const options = await fixture(t);
  await build(options);
  const before = await publishedBytes(options);
  const cases = [
    ['unsafe-import', APPROVED_DUMP + '\n DLL Name: USER32.dll', /未允许导入/],
    ['delay-address', APPROVED_DUMP.replace('Entry d 00000000', 'Entry d 00001000'), /延迟导入/],
    ['delay-size', APPROVED_DUMP.replace('00000000 Delay', '00000020 Delay'), /延迟导入/],
    ['missing-delay', APPROVED_DUMP.replace(/Entry d[^\n]*\n/, ''), /延迟导入/],
    ['wrong-architecture', APPROVED_DUMP.replace('010b (PE32)', '020b (PE32+)'), /32位PE32/],
  ];
  for (const [name, dump, expected] of cases) {
    const result = await powershell(options, simulatedTools(options, dump) + `
$rejected=$false; $message=''
try { $null=Invoke-LauncherBuild } catch { $rejected=$true; $message=$_.Exception.Message }
[pscustomobject]@{Rejected=$rejected;Message=$message;CompileCalls=$script:fixtureCompileCalls} | ConvertTo-Json -Compress
`);
    const checks = JSON.parse(result.stdout.trim());
    assert.equal(checks.Rejected, true, name);
    assert.match(checks.Message, expected, name);
    assert.equal(checks.CompileCalls, 1, name);
    assert.deepEqual(await publishedBytes(options), before, name);
    assert.equal(await exists(path.join(options.build, 'background-launcher.pending.exe')), true, name);
  }
  t.diagnostic(JSON.stringify({ evidence: 'isolated-builder-fixed-objdump-function-negative-inputs',
    rejectedCases: cases.map(([name]) => name), publishedFilesByteEqualPerCase: 3,
    pendingPreserved: true, compiledArtifactExecuted: false, taskOperations: false }));
});
