import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath, link, symlink, unlink, open, readdir } from 'node:fs/promises';
import { parseBackgroundArguments, appendBoundedLog, readInstanceRecord, assertRuntimePaths, assertBindingFile, assertRunIdentity, replaceInstanceRecord } from '../bin/background-runner.mjs';
import { createBackgroundProject, windowsPowerShellEnvironment } from './support/background-project-fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const MANAGER = path.join(ROOT, 'ops', 'manage-background.ps1');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execute = promisify(execFile);
const windows = process.platform === 'win32';
const OBSERVER_FILE_ASSIGNMENT = "$observer.StartInfo.FileName = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\\netstat.exe'";
const OBSERVER_ARGUMENT_ASSIGNMENT = "$observer.StartInfo.Arguments = '-ano'";
let runtimeProject;
let runtimeCleanupFailed = false;

// Windows用例共享只读产品副本；每个用例仍有自己的运行目录、名单和随机端口，不能读真实后台配置。
before(async () => { if (windows) runtimeProject = await createBackgroundProject(ROOT, POWERSHELL); });
after(async () => {
  // 清理失败时保留入口及记录供准确核对，不能先删除副本让仍存活的预览实例失去身份依据。
  assert.equal(runtimeCleanupFailed, false, '测试实例清理未通过；临时项目副本保留。');
  if (runtimeProject) await runtimeProject.cleanup();
});

/** 创建专用临时目录；清理仅针对本测试创建的绝对路径，不接收被查看项目根。 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'awr-dashboard-background-'));
  const registryPath = path.join(directory, 'projects.json');
  const stateDirectory = path.join(directory, 'state');
  const cleanupBeforeRemove = [];
  await writeFile(registryPath, JSON.stringify({ version: 1, defaultProjectId: null, projects: [] }));
  await writeFile(path.join(directory, 'start-hidden.vbs'), 'WScript.Quit 1\n', { flag: 'wx' });
  t.after(async () => {
    const cleanupErrors = [];
    // 一个实例结束失败不能阻止其余自有实例收尾；所有失败汇总后保留临时入口与身份记录。
    for (const callback of cleanupBeforeRemove) {
      try { await callback(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      runtimeCleanupFailed = true;
      throw new AggregateError(cleanupErrors, '测试实例清理未全部通过；临时目录保留。');
    }
    const absolute = path.resolve(directory);
    const relative = path.relative(os.tmpdir(), absolute);
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(absolute).startsWith('awr-dashboard-background-'));
    assert.equal((await realpath(absolute)).toLowerCase(), absolute.toLowerCase());
    await rm(absolute, { recursive: true, force: true });
  });
  return { directory, registryPath, stateDirectory, cleanupBeforeRemove };
}

/** 临时占用随机回环端口；关闭后供测试服务使用，不检查或停止真实服务。 */
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  // 即使机器改变动态端口范围，也不能让测试使用真实看板的产品默认端口。
  if (port === 4317) return freePort();
  return port;
}

/** 对测试自己启动的子进程句柄进行有限等待，避免进程启动失败时留下无界轮询。 */
async function waitFor(check, child, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`测试子进程提前退出：${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试等待超时');
}

/** 只启动已知Node及本项目入口，隐藏窗口；测试结束只操作本次ChildProcess句柄。 */
function launch(t, options) {
  const args = ['--no-warnings', runtimeProject.runnerPath, '--port', String(options.port), '--projects', options.registryPath, '--state-directory', options.stateDirectory];
  const child = spawn(runtimeProject.nodePath, args, { cwd: runtimeProject.root, windowsHide: true,
    env: windowsPowerShellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-4000); });
  /** 仅结束本次持有的子进程句柄，确认退出后记录证据，不靠临时目录删除推断服务已停。 */
  const cleanup = async () => {
    // 结束失败必须向夹具清理上抛，不能吞错后删除仍在运行实例的入口与身份记录。
    if (child.exitCode === null && child.signalCode === null) {
      assert.equal(child.kill(), true, '未能向本测试子进程发送停止信号。');
      await once(child, 'exit');
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, '本测试子进程尚未确认退出。');
    // 仅保存本测试临时目录里的产品安全诊断分类；不把预期失败当成成功，也不读取真实后台记录。
    try {
      const diagnostic = JSON.parse(await readFile(path.join(options.stateDirectory, 'startup-failure.json'), 'utf8'));
      // 多个实例可共用运行目录；末次诊断只属于其中记录的PID，不能复制归属到已经退出的首实例。
      if (diagnostic.pid === child.pid) t.diagnostic(JSON.stringify({ evidence: 'owned-runner-startup-diagnostic', pid: diagnostic.pid,
        stage: diagnostic.stage, category: diagnostic.category }));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    t.diagnostic(JSON.stringify({ evidence: 'owned-runner-exited', pid: child.pid, runner: runtimeProject.runnerPath,
      exitCode: child.exitCode, signalCode: child.signalCode }));
  };
  if (options.cleanupBeforeRemove) options.cleanupBeforeRemove.push(cleanup); else t.after(cleanup);
  return { child, args, stderr: () => output };
}

/** 生成仅供文件替换函数使用的完整合法记录；不启动进程，也不把这些夹具字段用作原生身份验证证据。 */
async function recordReplacementFixture(t) {
  const options = await fixture(t);
  await mkdir(options.stateDirectory);
  const root = await realpath(ROOT);
  const previous = { version: 1, owner: 'awr-dashboard-background-v1', projectRoot: root,
    runnerPath: path.join(root, 'bin', 'background-runner.mjs'), nodePath: await realpath(process.execPath),
    registryPath: options.registryPath, port: 43219, pid: process.pid, processCreatedAt: '2026-01-01T00:00:00.000Z',
    userSid: 'S-1-5-21-1', elevated: false, sessionId: 1, instanceId: randomUUID(), startedAt: '2026-01-01T00:00:00.000Z' };
  const record = { ...previous, instanceId: randomUUID() };
  const recordPath = path.join(options.stateDirectory, 'instance.json');
  const temporaryPath = path.join(options.stateDirectory, `instance-${record.instanceId}.tmp`);
  const previousBytes = Buffer.from(`${JSON.stringify(previous, null, 2)}\n`);
  await writeFile(recordPath, previousBytes);
  return { ...options, previous, record, recordPath, temporaryPath, previousBytes };
}

/** 在自有运行目录观察第二实例实际建立的临时记录；只枚举专用目录，绝不扫描真实后台目录。 */
async function waitForOwnedTemporaryRecord(options, child) {
  return waitFor(async () => {
    for (const name of await readdir(options.stateDirectory)) {
      if (!/^instance-[a-f0-9-]+\.tmp$/.test(name)) continue;
      const filename = path.join(options.stateDirectory, name);
      try {
        const record = JSON.parse(await readFile(filename, 'utf8'));
        if (record.pid === child.pid) return { filename, record };
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    return null;
  }, child);
}

/** 只确认自有实例健康响应；替换重试已异步让出执行权，健康成功不能代替新记录发布检查。 */
async function waitForRunnerHealth(options, child) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      return response.status === 200 && health.version === 1 && health.service === 'ok';
    } catch { return false; }
  }, child);
}

/** 转义PowerShell单引号字面量；数据不能变成命令，临时路径只在测试专用配置内使用。 */
function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }

/** 在Windows PowerShell中导入管理函数；保留固定期限及失败阶段，不调用实际Install或创建真实开机任务。 */
async function powershell(command, { allowPreview = false, managerPath = runtimeProject.managerPath } = {}) {
  // 默认屏蔽真实调度器；任务形态、只读状态和变更操作都必须由测试在内存中明确模拟。
  const schedulerFixture = `
function Get-ScheduledTask { <# 夹具不查询真实任务。 #> param($TaskPath,$TaskName,$ErrorAction) return $null }
function Get-ScheduledTaskInfo { <# 夹具不查询真实调度器退出码。 #> param($TaskPath,$TaskName,$ErrorAction) return [pscustomobject]@{LastTaskResult=$null} }
function Export-ScheduledTask { <# 未明确提供内存XML时禁止读取真实任务。 #> throw 'fixture-unexpected-export' }
function Get-BackgroundTaskInstanceCount { <# 未明确模拟时禁止组件对象查询真实任务实例。 #> throw 'fixture-unexpected-task-instances' }
function Get-BackgroundTaskSecurityDescriptor { <# 禁止读取真实任务权限。 #> throw 'fixture-unexpected-task-security-read' }
function Set-BackgroundTaskSecurityDescriptor { <# 禁止组件对象写入真实任务权限。 #> throw 'fixture-unexpected-task-security-write' }
function Register-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-register' }
function Start-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-start' }
function Stop-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-stop' }
function Enable-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-enable' }
function Disable-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-disable' }
function Unregister-ScheduledTask { <# 未显式模拟的调度器写入立即失败。 #> throw 'fixture-unexpected-unregister' }
function Set-ScheduledTask { <# 任何未授权新增调度写接口也必须拒绝。 #> throw 'fixture-unexpected-set' }
${allowPreview ? '' : "function Start-Process { <# 仅专用普通权限预览测试显式允许启动。 #> throw 'fixture-unexpected-process-start' }"}
`;
  const startedAt = Date.now();
  // 固定标记只报告测试执行阶段，不输出脚本正文；期限始终覆盖启动、导入和完整用例，不因阶段变化重置。
  try { return await execute(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
    `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); `
      + `[Console]::Error.WriteLine('[fresh-clone-tests:powershell:before-import]'); . ${literal(managerPath)}; `
      + `[Console]::Error.WriteLine('[fresh-clone-tests:powershell:after-import]'); ${schedulerFixture}; ${command}; `
      + "[Console]::Error.WriteLine('[fresh-clone-tests:powershell:command-complete]')"],
  { windowsHide: true, env: windowsPowerShellEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024 }); }
  catch (error) {
    const originalCommand = String(error.cmd ?? '');
    /** 有界保留子进程输出及消息；删除execFile附带的命令正文，避免错误及cause打印整个夹具。 */
    const bounded = value => {
      const text = String(value ?? '');
      return (originalCommand ? text.replaceAll(originalCommand, '[隔离PowerShell命令已省略]') : text).slice(-5000);
    };
    const stderr = bounded(error.stderr);
    const stages = ['before-import', 'after-import', 'command-complete', 'configuration-ready', 'status-start',
      'status-complete', 'start-rejection-start', 'start-rejection-end', 'network-query-start', 'network-query-complete'];
    // 从截断前输出按实际顺序读取最后一个完整固定标记，重复网络查询和错误正文都不能伪造阶段顺序。
    const stage = [...String(error.stderr ?? '').matchAll(/^\[fresh-clone-tests:powershell:([a-z-]+)\]\r?$/gm)]
      .map(match => match[1]).filter(value => stages.includes(value)).at(-1) ?? 'before-first-marker';
    const details = { code: error.code ?? null, killed: error.killed === true, signal: error.signal ?? null,
      elapsedMs: Date.now() - startedAt, stage, stdout: bounded(error.stdout), stderr, message: bounded(error.message) };
    // Node测试报告会递归打印cause；保留同一原错误的分类及堆栈帧，移除命令正文并限制重复输出。
    const frames = String(error.stack ?? '').split('\n').filter(line => /^\s+at\s/.test(line)).join('\n');
    error.message = details.message;
    error.cmd = '[隔离PowerShell命令已省略]';
    error.stdout = details.stdout;
    error.stderr = details.stderr;
    error.stack = `${error.name}: ${error.message}${frames ? `\n${frames}` : ''}`;
    // 超时/终止仍按真实失败上抛；null退出码不会伪装成已发生的管理器业务拒绝。
    throw new Error(`隔离管理器执行失败：${JSON.stringify(details)}`, { cause: error });
  }
}

/** 构造专用内存配置并隔离真实任务查询，保证机器已有生产任务时夹具也不触碰它。 */
function configuration(options) {
  const temporaryRoot = options.directory ?? path.dirname(options.registryPath);
  const protectDirectory = path.join(temporaryRoot, 'protected');
  return `$configuration = Get-BackgroundConfiguration; $configuration.RegistryPath = ${literal(options.registryPath)}; `
    + `$configuration.StateDirectory = ${literal(options.stateDirectory)}; $configuration.Port = ${options.port}; `
    + `$configuration.HiddenRunnerPath = ${literal(path.join(temporaryRoot, 'start-hidden.vbs'))}; `
    + `$configuration.ProtectDirectory = ${literal(protectDirectory)}; $configuration.LauncherPath = ${literal(path.join(protectDirectory, 'background-launcher.exe'))}; `
    + `$configuration.BuildDirectory = ${literal(path.join(temporaryRoot, 'build'))}; $configuration.ReceiptPath = ${literal(path.join(protectDirectory, 'install-receipt.json'))}; `;
}

/** 只读核查本次产品观察者的退出编号；既不扫描其他进程，也不按编号结束任何进程。 */
function observerExitReadback() {
  return `
function Get-FixturePortObservation {
  <# 保留实际产品结果，并独立查询本次返回的观察者编号是否已经退出；编号被复用时保守失败。 #>
  param([int]$Port)
  $observation=Get-BackgroundPortObservation -Port $Port
  $absent=$false
  if ($observation.ObserverStarted -and $observation.ObserverProcessId -gt 0) {
    $held=$null
    try { $held=[Diagnostics.Process]::GetProcessById($observation.ObserverProcessId); $absent=$held.HasExited }
    catch [ArgumentException] { $absent=$true }
    finally { if ($held) { $held.Dispose() } }
  }
  return [pscustomobject]@{Observation=$observation;ObserverAbsent=$absent}
}
`;
}

/** 提供完整内存登录任务及任务操作替身；真实组件对象、端口和进程写入均不参与管理事务测试。 */
function managementFixture(options) {
  return configuration(options) + `
$script:fixtureConfiguration=$configuration
$script:fixtureXml=Get-BackgroundTaskXml $configuration
$script:operations=@()
$script:fail=''
$script:recordPresent=$false
$script:fixtureTask=[pscustomobject]@{
  Description=$configuration.Owner+'|root='+$configuration.ProjectRoot+'|sid='+$configuration.UserSid
  Actions=@([pscustomobject]@{Execute=$configuration.ScriptHostPath;Arguments=(Get-BackgroundHiddenArguments $configuration);WorkingDirectory=$configuration.ProjectRoot})
  Principal=[pscustomobject]@{UserId=$configuration.UserSid;LogonType='Interactive';RunLevel='Limited'}
  Settings=[pscustomobject]@{Enabled=$true}
  State='Ready'
}
$script:fixtureSecurity='O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;'+$configuration.UserSid+')'
function Get-BackgroundConfiguration { <# 管理入口只返回本测试专用配置。 #> return $script:fixtureConfiguration }
function Get-ScheduledTask { <# 归属核验仍运行生产逻辑，只模拟查询结果。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureTask }
function Export-ScheduledTask { <# 仅导出本测试内存定义。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureXml }
function Get-BackgroundTaskInstanceCount { <# 只模拟本任务实例数，不调用调度器组件。 #> param($Configuration) return 0 }
function Get-BackgroundTaskSecurityDescriptor { <# 只读内存权限。 #> param($Configuration) return $script:fixtureSecurity }
function Set-BackgroundTaskSecurityDescriptor {
  <# 只更新内存访问控制表；模拟对象保留所有者/主组和控制位。 #>
  param($Configuration,$Dacl)
  $script:operations += 'security'
  $original=[Security.AccessControl.RawSecurityDescriptor]::new($script:fixtureSecurity)
  $original.DiscretionaryAcl=[Security.AccessControl.RawSecurityDescriptor]::new($Dacl).DiscretionaryAcl
  $script:fixtureSecurity=$original.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
  if ($script:fail -eq 'security') { $script:fixtureSecurity=$script:fixtureSecurity.Replace('GXGR','GA') }
}
function Get-NetTCPConnection { <# 事务测试不访问真实端口或结束监听者。 #> param($State,$ErrorAction) return @() }
function Get-BackgroundPortObservation {
  <# 事务夹具只提供明确的内存观测；真实查询、超时及进程收尾另有独立集成测试。 #>
  param($Port)
  return [pscustomobject]@{State='Absent';Reason='Observed';ObserverProcessId=123;ObserverStarted=$true;ObserverExited=$true;ElapsedMilliseconds=0}
}
function Get-VerifiedBackgroundProcess { <# 无真实进程，状态观测另有明确内存替身。 #> param($Configuration) return $null }
function Get-BackgroundStatus {
  <# 只模拟状态来源；权限判据与实际句柄另由专门原生/竞态测试覆盖。 #>
  param($Configuration)
  return [pscustomobject]@{Installed=($null -ne $script:fixtureTask);Enabled=($script:fixtureTask -and $script:fixtureTask.Settings.Enabled);
    TaskState=if($script:fixtureTask){$script:fixtureTask.State}else{'NotInstalled'};TaskConfigurationValid=$true;RuntimeRecordError=$false;
    ManagedProcessId=if($script:recordPresent){111}else{$null};Healthy=$script:recordPresent;
    LimitedTokenVerified=($script:fail -ne 'token');InteractiveSessionVerified=($script:fail -ne 'session')}
}
function Enable-ScheduledTask {
  <# 仅内存启用；没有真实任务写入。 #>
  param($TaskPath,$TaskName,$ErrorAction)
  $script:operations += 'enable'
  if ($script:fail -eq 'enable') { throw 'fixture-enable-failed' }
  $script:fixtureTask.Settings.Enabled=$true; $script:fixtureTask.State='Ready'
}
function Disable-ScheduledTask { <# 仅内存停用且保留操作顺序。 #> param($TaskPath,$TaskName,$ErrorAction) $script:operations += 'disable'; $script:fixtureTask.Settings.Enabled=$false; $script:fixtureTask.State='Disabled' }
function Stop-ScheduledTask { <# 仅停止内存实例标志，不操作进程。 #> param($TaskPath,$TaskName,$ErrorAction) $script:operations += 'stop'; $script:recordPresent=$false; if($script:fixtureTask.Settings.Enabled){$script:fixtureTask.State='Ready'}else{$script:fixtureTask.State='Disabled'} }
function Start-ScheduledTask {
  <# 只启动内存实例并模拟有界错误。 #>
  param($TaskPath,$TaskName,$ErrorAction)
  $script:operations += 'start'
  if ($script:fail -eq 'start') { throw 'fixture-start-failed' }
  $script:fixtureTask.State='Running'; $script:recordPresent=$true
}
`;
}

/** 把完整事务夹具改成旧非交互定义并隔离注册，确认备份先于停用注册，拒绝管理员直接Node启动。 */
function installFixture(options, kind = 'Legacy') {
  return managementFixture(options) + `
function Assert-BackgroundAdministrator { <# 仅模拟安装控制令牌门禁，不提权。 #> $script:operations += 'administrator' }
$script:fixtureTask.Settings.Enabled=$false
$script:fixtureTask.State='Disabled'
$script:fixtureTask.Principal.LogonType='S4U'
$script:fixtureTask.Actions[0].Execute=${kind === 'Protected' ? '$configuration.LauncherPath' : '$configuration.NodePath'}
$script:fixtureTask.Actions[0].Arguments=${kind === 'Protected' ? "''" : '(Get-BackgroundArguments $configuration)'}
$script:fixtureTask.Actions[0].WorkingDirectory=${kind === 'Protected' ? '$configuration.ProtectDirectory' : '$configuration.ProjectRoot'}
[xml]$oldDefinition=$script:fixtureXml
$oldNamespace=[Xml.XmlNamespaceManager]::new($oldDefinition.NameTable); $oldNamespace.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
$oldDefinition.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:LogonType',$oldNamespace).InnerText='S4U'
$oldDefinition.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command',$oldNamespace).InnerText=$script:fixtureTask.Actions[0].Execute
$oldDefinition.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments',$oldNamespace).InnerText=$script:fixtureTask.Actions[0].Arguments
$oldDefinition.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:WorkingDirectory',$oldNamespace).InnerText=$script:fixtureTask.Actions[0].WorkingDirectory
$script:fixtureXml=$oldDefinition.OuterXml
$script:originalXml=$script:fixtureXml
$script:backupBeforeRegister=$false
$script:registeredDisabled=$false
function Register-ScheduledTask {
  <# 模拟注册并核对排他备份及停用初态，不调用任何真实调度器接口。 #>
  param($TaskPath,$TaskName,$Xml,$Force,$ErrorAction)
  $backup=Join-Path $configuration.StateDirectory 'task-definition-before-login.xml'
  $script:backupBeforeRegister=((Get-Content -LiteralPath $backup -Raw -Encoding UTF8) -ceq $script:originalXml)
  [xml]$definition=$Xml
  $ns=[Xml.XmlNamespaceManager]::new($definition.NameTable); $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $script:registeredDisabled=($definition.SelectSingleNode('/t:Task/t:Settings/t:Enabled',$ns).InnerText -ceq 'false')
  $script:operations += 'register'
  $script:fixtureXml=$Xml
  $script:fixtureTask.Principal.LogonType='Interactive'
  $script:fixtureTask.Actions[0].Execute=$configuration.ScriptHostPath
  $script:fixtureTask.Actions[0].Arguments=Get-BackgroundHiddenArguments $configuration
  $script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProjectRoot
  if ($script:fail -eq 'register') { throw 'fixture-register-failed-after-disabled-definition' }
  if ($script:fail -eq 'readback') { $script:fixtureXml=$Xml.Replace('PT15S','PT30S') }
}
`;
}

test('后台参数只允许本地登记清单、合法端口与自有/专用临时运行目录', () => {
  const defaults = parseBackgroundArguments([]);
  assert.equal(defaults.port, 4317);
  assert.equal(defaults.stateDirectory, path.join(ROOT, 'run', 'background'));
  for (const args of [['--host', '0.0.0.0'], ['--port', '0'], ['--port', '65536'], ['--port', '12', '--port', '13'],
    ['--projects', 'relative.json'], ['--state-directory', ROOT], ['--state-directory', os.tmpdir()], ['--projects']]) {
    assert.throws(() => parseBackgroundArguments(args));
  }
  const temporary = path.join(os.tmpdir(), 'awr-dashboard-background-explicit', 'state');
  assert.equal(parseBackgroundArguments(['--state-directory', temporary]).stateDirectory, temporary);
});

test('日志固定两份、有界、安全字段过滤，不写任意源内容', async t => {
  const { directory } = await fixture(t);
  for (let index = 0; index < 20; index += 1) appendBoundedLog(directory, 'read.ERROR', { pid: 123, source: 'private-content', port: 12345 }, 256);
  for (const filename of ['service.log', 'service.log.1']) {
    assert.ok((await stat(path.join(directory, filename))).size <= 256);
    const text = await readFile(path.join(directory, filename), 'utf8');
    assert.doesNotMatch(text, /private-content|source/);
    for (const line of text.trim().split('\n')) assert.equal(JSON.parse(line).event, 'read.ERROR');
  }
  assert.throws(() => appendBoundedLog(directory, 'x', {}, 2 * 1024 * 1024));
});

test('运行记录缺失可启动，但损坏/超限/其他所有者不允许静默覆盖', async t => {
  const { directory } = await fixture(t);
  assert.equal(readInstanceRecord(directory), null);
  for (const bytes of ['{', JSON.stringify({ version: 1, owner: 'foreign-process', pid: 123 }), 'x'.repeat(16385)]) {
    await writeFile(path.join(directory, 'instance.json'), bytes);
    assert.throws(() => readInstanceRecord(directory));
    assert.equal(await readFile(path.join(directory, 'instance.json'), 'utf8'), bytes);
  }
});

test('Prepare只在内存生成固定隐藏动作、当前用户登录15秒和无限一分钟重复定义', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureConfiguration=$configuration
function Get-BackgroundConfiguration { <# Prepare使用专用路径夹具，不读取生产保护目录。 #> return $script:fixtureConfiguration }
Invoke-BackgroundManagement 'Prepare'
`);
  assert.match(result.stdout, /<LogonTrigger>/);
  assert.match(result.stdout, /<Delay>PT15S<\/Delay>/);
  assert.match(result.stdout, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(result.stdout, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(result.stdout, /<Interval>PT1M<\/Interval>/);
  assert.match(result.stdout, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(result.stdout, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(result.stdout, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(result.stdout, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(result.stdout, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(result.stdout, /<Command>[^<]*System32\\wscript\.exe<\/Command>/);
  assert.match(result.stdout, /<Arguments>\/\/B \/\/Nologo (?:&quot;|")[^<]*start-hidden\.vbs(?:&quot;|") (?:&quot;|")[^<]*node\.exe(?:&quot;|")<\/Arguments>/);
  assert.ok(result.stdout.includes(`<WorkingDirectory>${runtimeProject.root}</WorkingDirectory>`));
  assert.match(result.stdout, /<Enabled>false<\/Enabled>/);
  assert.match(result.stdout, /<Hidden>true<\/Hidden>/);
  assert.doesNotMatch(result.stdout, /<BootTrigger>|<Duration>|<EndBoundary>|<Password>|<LogonType>S4U|background-launcher\.exe|<UserId>S-1-5-18<\/UserId>/);
});

test('未提升Install在任何配置/任务/目录变化前明确退出，不自动提权', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:queries=0
$script:operations=@()
function Get-BackgroundConfiguration { <# 首个提升门禁失败后不能进入配置读取。 #> $script:queries++; throw 'fixture-unexpected-configuration' }
function Get-ScheduledTask { <# 首个提升门禁失败后不能查询真实或模拟任务。 #> param($TaskPath,$TaskName,$ErrorAction) $script:queries++; return $null }
$rejected=$false
$message=''
try { $null=Invoke-BackgroundManagement 'Install' } catch { $rejected=$true; $message=$_.Exception.Message }
[pscustomobject]@{Elevated=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator);Rejected=$rejected;Message=$message;Queries=$script:queries;StateExists=(Test-Path -LiteralPath $configuration.StateDirectory);ProtectionExists=(Test-Path -LiteralPath $configuration.ProtectDirectory)} | ConvertTo-Json -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.equal(checks.Elevated, false, '此测试必须以普通权限运行。');
  assert.equal(checks.Rejected, true);
  assert.match(checks.Message, /Install/);
  assert.equal(checks.Queries, 0);
  assert.equal(checks.StateExists, false);
  assert.equal(checks.ProtectionExists, false);
});

test('同名任务仅接受精确Legacy/Protected/Login，逐项主体或动作差异全部拒绝', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureTask = [pscustomobject]@{
  Description = $configuration.Owner + '|root=' + $configuration.ProjectRoot + '|sid=' + $configuration.UserSid
  Actions = @([pscustomobject]@{ Execute=$configuration.NodePath; Arguments=(Get-BackgroundArguments $configuration); WorkingDirectory=$configuration.ProjectRoot })
  Principal = [pscustomobject]@{ UserId=$configuration.UserSid; LogonType='S4U'; RunLevel='Limited' }
}
function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureTask }
$legacy=Get-BackgroundTaskDefinitionKind $configuration (Get-OwnedBackgroundTask $configuration)
$originalLegacy=$script:fixtureTask
$script:fixtureTask=$originalLegacy | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$script:fixtureTask.Actions[0].Execute=$configuration.LauncherPath
$script:fixtureTask.Actions[0].Arguments=''
$script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProtectDirectory
$protected=Get-BackgroundTaskDefinitionKind $configuration (Get-OwnedBackgroundTask $configuration)
$originalProtected=$script:fixtureTask
$script:fixtureTask=$originalLegacy | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$script:fixtureTask.Actions[0].Execute=$configuration.ScriptHostPath
$script:fixtureTask.Actions[0].Arguments=Get-BackgroundHiddenArguments $configuration
$script:fixtureTask.Principal.LogonType='Interactive'
$login=Get-BackgroundTaskDefinitionKind $configuration (Get-OwnedBackgroundTask $configuration)
$originalLogin=$script:fixtureTask
$results = @()
foreach ($definition in @($originalLegacy,$originalProtected,$originalLogin)) {
$script:fixtureTask=$definition
foreach ($field in @('description','execute','arguments','directory','sid','logon','runlevel','multiple')) {
  $copy = $script:fixtureTask | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  switch ($field) {
    'description' { $copy.Description = 'foreign' }
    'execute' { $copy.Actions[0].Execute = 'C:\\unknown.exe' }
    'arguments' { $copy.Actions[0].Arguments += ' --extra' }
    'directory' { $copy.Actions[0].WorkingDirectory = 'C:\\' }
    'sid' { $copy.Principal.UserId = 'S-1-5-18' }
    'logon' { $copy.Principal.LogonType = 'Password' }
    'runlevel' { $copy.Principal.RunLevel = 'Highest' }
    'multiple' { $copy.Actions = @($copy.Actions[0],$copy.Actions[0]) }
  }
  $original = $script:fixtureTask
  $script:fixtureTask = $copy
  try { $null = Get-OwnedBackgroundTask $configuration; $results += $false } catch { $results += $true }
  $script:fixtureTask = $original
}
}
[pscustomobject]@{Legacy=$legacy;Protected=$protected;Login=$login;Rejected=$results} | ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { Legacy: 'Legacy', Protected: 'Protected', Login: 'Login', Rejected: Array(24).fill(true) });
});

test('原Legacy和Protected的Start/Enable在实例快捷返回及任何写入前均拒绝', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureConfiguration=$configuration
$script:fixtureTask=[pscustomobject]@{
  Description=$configuration.Owner+'|root='+$configuration.ProjectRoot+'|sid='+$configuration.UserSid
  Actions=@([pscustomobject]@{Execute=$configuration.NodePath;Arguments=(Get-BackgroundArguments $configuration);WorkingDirectory=$configuration.ProjectRoot})
  Principal=[pscustomobject]@{UserId=$configuration.UserSid;LogonType='S4U';RunLevel='Limited'}
  Settings=[pscustomobject]@{Enabled=$true}
  State='Running'
}
$script:processQueries=0
$script:writes=@()
function Get-BackgroundConfiguration { <# 管理入口仅使用已隔离配置。 #> return $script:fixtureConfiguration }
function Get-ScheduledTask { <# 精确任务身份仍走生产归属核验。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureTask }
function Get-VerifiedBackgroundProcess { <# 禁止旧链用已有记录快速返回，也禁止未核验新链查实例放行。 #> param($Configuration) $script:processQueries++; throw 'fixture-unexpected-instance-query' }
function Start-ScheduledTask { <# 记录内存写入，不操作真实任务。 #> param($TaskPath,$TaskName) $script:writes += 'start' }
function Enable-ScheduledTask { <# 记录内存写入，不操作真实任务。 #> param($TaskPath,$TaskName) $script:writes += 'enable' }
function Register-ScheduledTask { <# 记录内存写入，不操作真实任务。 #> param($TaskPath,$TaskName,$Xml) $script:writes += 'register' }
$results=@()
foreach ($kind in @('Legacy','Protected')) {
  if ($kind -eq 'Protected') {
    $script:fixtureTask.Actions[0].Execute=$configuration.LauncherPath
    $script:fixtureTask.Actions[0].Arguments=''
    $script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProtectDirectory
  }
  foreach ($requestedAction in @('Start','Enable')) {
    $rejected=$false
    $message=''
    try { $null=Invoke-BackgroundManagement $requestedAction } catch { $rejected=$true; $message=$_.Exception.Message }
    $results += [pscustomobject]@{Kind=$kind;Action=$requestedAction;Rejected=$rejected;Message=$message}
  }
}
[pscustomobject]@{Results=$results;ProcessQueries=$script:processQueries;Writes=$script:writes} | ConvertTo-Json -Depth 5 -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.equal(checks.ProcessQueries, 0);
  assert.deepEqual(checks.Writes, []);
  assert.deepEqual(checks.Results.map(item => [item.Kind, item.Action, item.Rejected]), [
    ['Legacy', 'Start', true], ['Legacy', 'Enable', true], ['Protected', 'Start', true], ['Protected', 'Enable', true],
  ]);
  for (const item of checks.Results) assert.match(item.Message, /旧非交互任务定义/);
});

test('Status区分任务形态并读取真实接口退出码，运行记录不能证明真实权限或登录会话', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureTask=[pscustomobject]@{
  Description=$configuration.Owner+'|root='+$configuration.ProjectRoot+'|sid='+$configuration.UserSid
  Actions=@([pscustomobject]@{Execute=$configuration.NodePath;Arguments=(Get-BackgroundArguments $configuration);WorkingDirectory=$configuration.ProjectRoot})
  Principal=[pscustomobject]@{UserId=$configuration.UserSid;LogonType='S4U';RunLevel='Limited'}
  Settings=[pscustomobject]@{Enabled=$false}
  State='Disabled'
}
$script:infoQueries=0
function Get-ScheduledTask { <# 内存模拟归属任务，不读真实任务。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureTask }
function Get-ScheduledTaskInfo { <# 覆盖只读原生接口的已知结果，核对查询确实发生。 #> param($TaskPath,$TaskName,$ErrorAction) $script:infoQueries++; return [pscustomobject]@{LastTaskResult=1314} }
function Get-BackgroundRecord { <# 可写记录即使宣称有限权限和会话0，也不等于真实令牌核验。 #> param($Configuration) return [pscustomobject]@{elevated=$false;sessionId=0} }
function Get-VerifiedBackgroundProcess { <# 模拟已由稳定创建身份定位的进程，未提供令牌证明。 #> param($Configuration) $p=[pscustomobject]@{Id=111}; $p | Add-Member ScriptMethod Dispose { <# 内存句柄无需清理真实进程。 #> }; return $p }
function Test-BackgroundHealth { <# 不访问生产回环端口。 #> param($Configuration) return $true }
$legacy=Get-BackgroundStatus $configuration
$script:fixtureTask.Actions[0].Execute=$configuration.LauncherPath
$script:fixtureTask.Actions[0].Arguments=''
$script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProtectDirectory
$protected=Get-BackgroundStatus $configuration
$script:fixtureTask.Actions[0].Execute=$configuration.ScriptHostPath
$script:fixtureTask.Actions[0].Arguments=Get-BackgroundHiddenArguments $configuration
$script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProjectRoot
$script:fixtureTask.Principal.LogonType='Interactive'
$script:fixtureXml=Get-BackgroundTaskXml $configuration
function Export-ScheduledTask { <# 登录定义只读取本测试内存XML。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureXml }
$login=Get-BackgroundStatus $configuration
function Get-ScheduledTaskInfo { <# 查询失败必须呈现未知而非成功退出码。 #> param($TaskPath,$TaskName,$ErrorAction) throw 'fixture-info-query-failed' }
$unknownResult=Get-BackgroundStatus $configuration
$script:fixtureTask=$null
$none=Get-BackgroundStatus $configuration
[pscustomobject]@{Legacy=$legacy;Protected=$protected;Login=$login;UnknownResult=$unknownResult.LastTaskResult;None=$none;InfoQueries=$script:infoQueries} | ConvertTo-Json -Depth 6 -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.equal(checks.InfoQueries, 3);
  for (const [kind, status] of [['Legacy', checks.Legacy], ['Protected', checks.Protected], ['Login', checks.Login]]) {
    assert.equal(status.TaskDefinitionKind, kind);
    assert.equal(status.Installed, true);
    assert.equal(status.Enabled, false);
    assert.equal(status.TaskConfigurationValid, kind === 'Login');
    assert.equal(status.LauncherProtectionVerified, false);
    assert.equal(status.LastTaskResult, 1314);
    assert.equal(status.Healthy, true);
    assert.equal(status.LimitedTokenVerified, false);
    assert.equal(status.NonInteractiveSessionVerified, false);
    assert.equal(status.InteractiveSessionVerified, false);
    assert.equal(status.StartupMode, 'UserLogon');
    assert.equal(status.BootRecoveryVerified, false);
  }
  assert.equal(checks.UnknownResult, null);
  assert.equal(checks.None.TaskDefinitionKind, 'None');
  assert.equal(checks.None.Installed, false);
  assert.equal(checks.None.LastTaskResult, null);
});

test('精确Legacy和Protected的Stop/Disable/Uninstall保留安全控制且不依赖新产物', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureConfiguration=$configuration
$originalTask=[pscustomobject]@{
  Description=$configuration.Owner+'|root='+$configuration.ProjectRoot+'|sid='+$configuration.UserSid
  Actions=@([pscustomobject]@{Execute=$configuration.NodePath;Arguments=(Get-BackgroundArguments $configuration);WorkingDirectory=$configuration.ProjectRoot})
  Principal=[pscustomobject]@{UserId=$configuration.UserSid;LogonType='S4U';RunLevel='Limited'}
  Settings=[pscustomobject]@{Enabled=$true}
  State='Running'
}
function Get-BackgroundConfiguration { <# 全部管理操作使用隔离目录。 #> return $script:fixtureConfiguration }
function Get-ScheduledTask { <# 生产函数核对内存任务的完整归属。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:fixtureTask }
function Get-VerifiedBackgroundProcess { <# 无真实进程；仅核对调度停止顺序。 #> param($Configuration) return $null }
function Disable-ScheduledTask { <# 内存停用且记录顺序。 #> param($TaskPath,$TaskName) $script:operations += 'disable'; $script:fixtureTask.Settings.Enabled=$false }
function Stop-ScheduledTask { <# 内存停止且记录顺序。 #> param($TaskPath,$TaskName) $script:operations += 'stop'; $script:fixtureTask.State='Ready' }
function Unregister-ScheduledTask { <# 内存注销且保留所有本地文件。 #> param($TaskPath,$TaskName,$Confirm) $script:operations += 'unregister'; $script:fixtureTask=$null }
$results=@()
foreach ($kind in @('Legacy','Protected')) {
foreach ($requestedAction in @('Stop','Disable','Uninstall')) {
  $script:fixtureTask=$originalTask | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  if ($kind -eq 'Protected') {
    $script:fixtureTask.Actions[0].Execute=$configuration.LauncherPath
    $script:fixtureTask.Actions[0].Arguments=''
    $script:fixtureTask.Actions[0].WorkingDirectory=$configuration.ProtectDirectory
  }
  $script:operations=@()
  $status=Invoke-BackgroundManagement $requestedAction
  $results += [pscustomobject]@{Action=$requestedAction;Operations=$script:operations;Installed=$status.Installed;Kind=$status.TaskDefinitionKind}
}
}
$results | ConvertTo-Json -Depth 5 -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), [
    { Action: 'Stop', Operations: ['stop'], Installed: true, Kind: 'Legacy' },
    { Action: 'Disable', Operations: ['disable', 'stop'], Installed: true, Kind: 'Legacy' },
    { Action: 'Uninstall', Operations: ['disable', 'stop', 'unregister'], Installed: false, Kind: 'None' },
    { Action: 'Stop', Operations: ['stop'], Installed: true, Kind: 'Protected' },
    { Action: 'Disable', Operations: ['disable', 'stop'], Installed: true, Kind: 'Protected' },
    { Action: 'Uninstall', Operations: ['disable', 'stop', 'unregister'], Installed: false, Kind: 'None' },
  ]);
});

test('Windows PowerShell5.1与可用的PowerShell7分别解析带UTF8 BOM的管理入口', { skip: !windows }, async t => {
  const bytes = await readFile(MANAGER);
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  await t.test('Windows PowerShell5.1解析必须通过', async () => {
    const result = await powershell(`$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile(${literal(MANAGER)},[ref]$tokens,[ref]$errors) | Out-Null; [pscustomobject]@{Version=$PSVersionTable.PSVersion.ToString();Errors=$errors.Count} | ConvertTo-Json -Compress`);
    assert.equal(JSON.parse(result.stdout.trim()).Errors, 0);
    assert.match(JSON.parse(result.stdout.trim()).Version, /^5\.1\./);
  });
  await t.test('PowerShell7可用时解析必须通过', async subtest => {
    let current;
    try {
      current = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseFile(${literal(MANAGER)},[ref]$tokens,[ref]$errors) | Out-Null; [pscustomobject]@{Version=$PSVersionTable.PSVersion.ToString();Errors=$errors.Count} | ConvertTo-Json -Compress`],
      { windowsHide: true, timeout: 30_000, encoding: 'utf8' });
    } catch (error) {
      // 仅可选解释器确实不存在时跳过该子例；解析失败、权限错误或超时仍必须失败。
      if (error.code === 'ENOENT') { subtest.skip('命令搜索路径未提供pwsh.exe；PowerShell7解析未验证。'); return; }
      throw error;
    }
    assert.match(JSON.parse(current.stdout.trim()).Version, /^7\./);
    assert.equal(JSON.parse(current.stdout.trim()).Errors, 0);
  });
});

test('任务导出缺登录或有限周期、错误主体动作及额外触发均不算配置通过', { skip: !windows }, async t => {
  const result = await powershell(configuration({ ...await fixture(t), port: await freePort() }) + `
$script:fixtureXml = Get-BackgroundTaskXml $configuration
function Export-ScheduledTask { param($TaskPath,$TaskName) return $script:fixtureXml }
Assert-BackgroundTaskConfiguration $configuration
$results = @()
foreach ($change in @('logon','limit','period','battery','duration','end','logonEnd','future','network','idle','idleStop','extraBoot','duplicateLogon','logonSid','delay','execute','arguments','directory','principalSid','interactive','directNode')) {
  $original = $script:fixtureXml
  [xml]$copy = $original
  $ns=[Xml.XmlNamespaceManager]::new($copy.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  switch ($change) {
    'logon' { $node=$copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$ns); $null=$node.ParentNode.RemoveChild($node) }
    'limit' { $copy.SelectSingleNode('/t:Task/t:Settings/t:ExecutionTimeLimit',$ns).InnerText='PT72H' }
    'period' { $copy.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Interval',$ns).InnerText='PT2M' }
    'battery' { $copy.SelectSingleNode('/t:Task/t:Settings/t:StopIfGoingOnBatteries',$ns).InnerText='true' }
    'duration' { $node=$copy.CreateElement('Duration','http://schemas.microsoft.com/windows/2004/02/mit/task'); $node.InnerText='PT1H'; $null=$copy.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:Repetition',$ns).AppendChild($node) }
    'end' { $node=$copy.CreateElement('EndBoundary','http://schemas.microsoft.com/windows/2004/02/mit/task'); $node.InnerText='2099-01-01T00:00:00'; $null=$copy.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger',$ns).AppendChild($node) }
    'logonEnd' { $node=$copy.CreateElement('EndBoundary','http://schemas.microsoft.com/windows/2004/02/mit/task'); $node.InnerText='2099-01-01T00:00:00'; $null=$copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$ns).AppendChild($node) }
    'extraBoot' { $node=$copy.CreateElement('BootTrigger','http://schemas.microsoft.com/windows/2004/02/mit/task'); $null=$copy.SelectSingleNode('/t:Task/t:Triggers',$ns).AppendChild($node) }
    'duplicateLogon' { $node=$copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$ns); $null=$node.ParentNode.AppendChild($node.CloneNode($true)) }
    'logonSid' { $copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger/t:UserId',$ns).InnerText='S-1-5-18' }
    'delay' { $copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger/t:Delay',$ns).InnerText='PT30S' }
    'execute' { $copy.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command',$ns).InnerText='C:\\unknown.exe' }
    'arguments' { $copy.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments',$ns).InnerText+=' --extra' }
    'directory' { $copy.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:WorkingDirectory',$ns).InnerText='C:\\' }
    'principalSid' { $copy.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId',$ns).InnerText='S-1-5-18' }
    'interactive' { $copy.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:LogonType',$ns).InnerText='S4U' }
    'directNode' { $copy.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command',$ns).InnerText=$configuration.NodePath }
    'future' { $copy.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:StartBoundary',$ns).InnerText='2099-01-01T00:00:00' }
    'network' { $copy.SelectSingleNode('/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable',$ns).InnerText='true' }
    'idle' { $copy.SelectSingleNode('/t:Task/t:Settings/t:RunOnlyIfIdle',$ns).InnerText='true' }
    'idleStop' { $copy.SelectSingleNode('/t:Task/t:Settings/t:IdleSettings/t:StopOnIdleEnd',$ns).InnerText='true' }
  }
  $script:fixtureXml=$copy.OuterXml
  try { Assert-BackgroundTaskConfiguration $configuration; $results += $false } catch { $results += $true }
  $script:fixtureXml=$original
}
$results | ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), Array(21).fill(true));
});

test('任务导出的主体与登录账户名只按原安全标识等价接受，陌生空白及重复仍拒绝', { skip: !windows }, async t => {
  // Windows注册后会将登录触发的UserId导出为账户名；只改内存XML，不能为测试注册或查询真实任务。
  const result = await powershell(configuration({ ...await fixture(t), port: await freePort() }) + `
$original = Get-BackgroundTaskXml $configuration
$script:fixtureXml = $original
function Export-ScheduledTask { <# 仅返回本测试内存定义，不接触真实调度器。 #> param($TaskPath,$TaskName) return $script:fixtureXml }
$sameAccount = ([Security.Principal.SecurityIdentifier]::new($configuration.UserSid)).Translate([Security.Principal.NTAccount]).Value
$foreignAccount = ([Security.Principal.SecurityIdentifier]::new('S-1-5-18')).Translate([Security.Principal.NTAccount]).Value
$paths = @('/t:Task/t:Principals/t:Principal/t:UserId','/t:Task/t:Triggers/t:LogonTrigger/t:UserId')
$accepted = @()
foreach ($principalValue in @($configuration.UserSid,$sameAccount)) {
  foreach ($triggerValue in @($configuration.UserSid,$sameAccount)) {
    [xml]$copy = $original
    $ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $copy.SelectSingleNode($paths[0],$ns).InnerText = $principalValue
    $copy.SelectSingleNode($paths[1],$ns).InnerText = $triggerValue
    $script:fixtureXml = $copy.OuterXml
    try { Assert-BackgroundTaskConfiguration $configuration; $accepted += $true } catch { $accepted += $false }
  }
}
$rejected = @()
foreach ($field in $paths) {
  foreach ($change in @('foreignSid','foreignName','unmapped','invalidSid','empty','blank','missing','duplicate')) {
    [xml]$copy = $original
    $ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $node = $copy.SelectSingleNode($field,$ns)
    switch ($change) {
      'foreignSid' { $node.InnerText = 'S-1-5-18' }
      'foreignName' { $node.InnerText = $foreignAccount }
      'unmapped' { $node.InnerText = [Environment]::MachineName+'\\AWR_dashboard_unmapped_0d0f679886e0441faf15' }
      'invalidSid' { $node.InnerText = 'S-1-5-not-a-security-identifier' }
      'empty' { $node.InnerText = '' }
      'blank' { $node.InnerText = ' ' }
      'missing' { $null = $node.ParentNode.RemoveChild($node) }
      'duplicate' { $null = $node.ParentNode.AppendChild($node.CloneNode($true)) }
    }
    $script:fixtureXml = $copy.OuterXml
    try { Assert-BackgroundTaskConfiguration $configuration; $rejected += $false } catch { $rejected += $true }
  }
}
# 同一账户名也不能让多个登录触发获得授权；唯一触发约束必须与身份规范化一起保持。
[xml]$copy = $original
$ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
$logon = $copy.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$ns)
$logon.SelectSingleNode('t:UserId',$ns).InnerText = $sameAccount
$null = $logon.ParentNode.AppendChild($logon.CloneNode($true))
$script:fixtureXml = $copy.OuterXml
try { Assert-BackgroundTaskConfiguration $configuration; $rejected += $false } catch { $rejected += $true }
[pscustomobject]@{Accepted=$accepted;Rejected=$rejected} | ConvertTo-Json -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.deepEqual(checks.Accepted, Array(4).fill(true));
  assert.deepEqual(checks.Rejected, Array(17).fill(true));
});

test('任务导出默认省略只接受官方默认值，缺RunLevel仍核对实际有限权限', { skip: !windows }, async t => {
  // 模拟注册后导出的省略形式；所有操作仅替换函数内存返回值，不注册或改写真实任务。
  const result = await powershell(configuration({ ...await fixture(t), port: await freePort() }) + `
$script:fixtureXml = Get-BackgroundTaskXml $configuration
$script:effectiveMode = 'limited'
function Export-ScheduledTask { <# 仅返回本测试内存XML。 #> param($TaskPath,$TaskName) return $script:fixtureXml }
function Get-OwnedBackgroundTask {
  <# 模拟实际归属查询的结果和失败；生产身份核对仍由原函数及独立身份测试覆盖。 #>
  param($Configuration)
  if ($script:effectiveMode -eq 'missing') { return $null }
  if ($script:effectiveMode -eq 'error') { throw 'fixture-query-failed' }
  $level = switch ($script:effectiveMode) { 'highest' { 'Highest' } 'unknown' { '' } default { 'Limited' } }
  return [pscustomobject]@{Principal=[pscustomobject]@{RunLevel=$level}}
}
$paths = @(
  '/t:Task/t:Principals/t:Principal/t:RunLevel',
  '/t:Task/t:Triggers/t:LogonTrigger/t:Enabled',
  '/t:Task/t:Triggers/t:TimeTrigger/t:Enabled',
  '/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:StopAtDurationEnd',
  '/t:Task/t:Settings/t:MultipleInstancesPolicy',
  '/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable',
  '/t:Task/t:Settings/t:RunOnlyIfIdle',
  '/t:Task/t:Settings/t:IdleSettings/t:RestartOnIdle',
  '/t:Task/t:Settings/t:AllowStartOnDemand',
  '/t:Task/t:Settings/t:AllowHardTerminate'
)
$original = $script:fixtureXml
$omittedAccepted = @()
$wrongRejected = @()
$emptyRejected = @()
foreach ($field in $paths) {
  [xml]$copy = $original
  $ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $node = $copy.SelectSingleNode($field,$ns)
  if (-not $node) { throw 'fixture-explicit-node-missing' }
  $null = $node.ParentNode.RemoveChild($node)
  $script:fixtureXml = $copy.OuterXml
  try { Assert-BackgroundTaskConfiguration $configuration; $omittedAccepted += $true } catch { $omittedAccepted += $false }

  # 存在但错误或空白的节点不能回退默认值，权限提升也不能借缺省归一化放行。
  [xml]$copy = $original
  $node = $copy.SelectSingleNode($field,$ns)
  $node.InnerText = if ($field -like '*/RunLevel') { 'HighestAvailable' } elseif ($field -like '*/MultipleInstancesPolicy') { 'Parallel' } elseif ($node.InnerText -eq 'true') { 'false' } else { 'true' }
  $script:fixtureXml = $copy.OuterXml
  try { Assert-BackgroundTaskConfiguration $configuration; $wrongRejected += $false } catch { $wrongRejected += $true }
  $node.InnerText = ' '
  $script:fixtureXml = $copy.OuterXml
  try { Assert-BackgroundTaskConfiguration $configuration; $emptyRejected += $false } catch { $emptyRejected += $true }
}
[xml]$copy = $original
$ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
foreach ($field in $paths) { $node = $copy.SelectSingleNode($field,$ns); $null = $node.ParentNode.RemoveChild($node) }
$script:fixtureXml = $copy.OuterXml
$allOmittedAccepted = $false
try { Assert-BackgroundTaskConfiguration $configuration; $allOmittedAccepted = $true } catch { }
$unverifiedPrivilegeRejected = @()
foreach ($mode in @('missing','highest','unknown','error')) {
  $script:effectiveMode = $mode
  try { Assert-BackgroundTaskConfiguration $configuration; $unverifiedPrivilegeRejected += $false } catch { $unverifiedPrivilegeRejected += $true }
}
[pscustomobject]@{OmittedAccepted=$omittedAccepted;WrongRejected=$wrongRejected;EmptyRejected=$emptyRejected;AllOmittedAccepted=$allOmittedAccepted;UnverifiedPrivilegeRejected=$unverifiedPrivilegeRejected} | ConvertTo-Json -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.deepEqual(checks.OmittedAccepted, Array(10).fill(true));
  assert.equal(checks.AllOmittedAccepted, true);
  assert.deepEqual(checks.WrongRejected, Array(10).fill(true));
  assert.deepEqual(checks.EmptyRejected, Array(10).fill(true));
  assert.deepEqual(checks.UnverifiedPrivilegeRejected, Array(4).fill(true));
});

test('非默认必要字段缺失不能用系统默认值冒充用户登录恢复配置', { skip: !windows }, async t => {
  // 这些字段的默认值不等于目标，或没有安全默认；仍须逐项显式存在且符合目标。
  const result = await powershell(configuration({ ...await fixture(t), port: await freePort() }) + `
$script:fixtureXml = Get-BackgroundTaskXml $configuration
function Export-ScheduledTask { <# 不读取或变更真实任务，仅使用内存夹具。 #> param($TaskPath,$TaskName) return $script:fixtureXml }
$original = $script:fixtureXml
$results = @()
foreach ($field in @(
  '/t:Task/t:Principals/t:Principal/t:LogonType',
  '/t:Task/t:Triggers/t:LogonTrigger/t:Delay',
  '/t:Task/t:Triggers/t:LogonTrigger/t:UserId',
  '/t:Task/t:Principals/t:Principal/t:UserId',
  '/t:Task/t:Actions/t:Exec/t:Command',
  '/t:Task/t:Actions/t:Exec/t:Arguments',
  '/t:Task/t:Actions/t:Exec/t:WorkingDirectory',
  '/t:Task/t:Settings/t:Hidden',
  '/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Interval',
  '/t:Task/t:Settings/t:ExecutionTimeLimit',
  '/t:Task/t:Settings/t:DisallowStartIfOnBatteries',
  '/t:Task/t:Settings/t:StopIfGoingOnBatteries',
  '/t:Task/t:Settings/t:StartWhenAvailable',
  '/t:Task/t:Settings/t:IdleSettings/t:StopOnIdleEnd',
  '/t:Task/t:Settings/t:RestartOnFailure/t:Interval',
  '/t:Task/t:Settings/t:RestartOnFailure/t:Count'
)) {
  [xml]$copy = $original
  $ns = [Xml.XmlNamespaceManager]::new($copy.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $node = $copy.SelectSingleNode($field,$ns)
  if (-not $node) { throw 'fixture-required-node-missing' }
  $null = $node.ParentNode.RemoveChild($node)
  $script:fixtureXml = $copy.OuterXml
  try { Assert-BackgroundTaskConfiguration $configuration; $results += $false } catch { $results += $true }
}
$results | ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), Array(16).fill(true));
});

test('绑定安装期Node与原SID；停用配置不要求登记清单仍存在，Start明确拒绝', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:configuration-ready]')
$before=$configuration.NodePath
$configuration.RegistryPath=${literal(path.join(options.directory, 'missing.json'))}
function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) return $null }
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:status-start]')
$status=Get-BackgroundStatus $configuration
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:status-complete]')
$rejected=$false; $message=''; $details=''
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:start-rejection-start]')
try { Start-BackgroundInstance $configuration } catch { $rejected=$true; $message=$_.Exception.Message; $details=$_.ErrorDetails.Message }
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:start-rejection-end]')
[pscustomobject]@{NodeStillFixed=($before -eq (Get-BackgroundConfiguration).NodePath);StatusAllowed=($status.Installed -eq $false);StartRejected=$rejected;Message=$message;Details=$details} | ConvertTo-Json -Compress
`);
  const { Message: message, Details: details, ...checks } = JSON.parse(result.stdout.trim());
  assert.deepEqual(checks, { NodeStillFixed: true, StatusAllowed: true, StartRejected: true });
  assert.equal(message, '本看板Node、入口或登记清单缺失，未启动或修改启动项。');
  assert.ok(details.startsWith(message), '原始缺输入拒绝必须保留在附加收尾信息之前。');
  const observation = details.match(/端口观测=(Absent|Present|Unknown)\/([^；]+)/);
  assert.ok(observation, '缺输入拒绝的收尾信息必须保留真实端口观测结果。');
  // 观测未知不能因原始拒绝已正确发生而假绿；只有明确Absent才允许报告无实例。
  if (observation[1] !== 'Absent') assert.match(details, /无实例读回=False/);
  if (/无实例读回=True/.test(details)) {
    assert.equal(observation[1], 'Absent');
    assert.equal(observation[2], 'Observed');
  }
  t.diagnostic(JSON.stringify({ evidence: 'missing-input-original-error-retained', originalError: message,
    portState: observation[1], portReason: observation[2], noInstanceConfirmed: /无实例读回=True/.test(details) }));
  const settings = JSON.parse(await readFile(runtimeProject.settingsPath, 'utf8'));
  assert.equal(settings.nodePath.toLowerCase(), runtimeProject.nodePath.toLowerCase());
  assert.equal(settings.userSid, runtimeProject.userSid);
});

test('已归属任务Running但记录缺失/损坏也先停止任务，不猜PID', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  await mkdir(options.stateDirectory);
  for (const bytes of [null, '{']) {
    const recordPath = path.join(options.stateDirectory, 'instance.json');
    if (bytes === null) { await rm(recordPath, { force: true }); } else { await writeFile(recordPath, bytes); }
    const result = await powershell(configuration(options) + `
$script:stopped=$false
function Stop-ScheduledTask { param($TaskPath,$TaskName) $script:stopped=$true }
Stop-BackgroundInstance $configuration ([pscustomobject]@{State='Running'})
$script:stopped
`);
    assert.match(result.stdout, /True/);
  }
});

test('Uninstall在坏记录或运行链接下仍注销已归属任务，最终状态明确身份记录异常', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const foreign = await fixture(t);
  await mkdir(options.stateDirectory);
  await writeFile(path.join(options.stateDirectory, 'instance.json'), '{');
  const junction = path.join(options.directory, 'runtime-link');
  await symlink(foreign.directory, junction, 'junction');
  try {
    for (const stateDirectory of [options.stateDirectory, junction]) {
      const result = await powershell(configuration({ ...options, stateDirectory }) + `
$script:fixtureConfiguration=$configuration
$script:ownedTask=[pscustomobject]@{State='Running';Settings=[pscustomobject]@{Enabled=$true}}
$script:operations=@()
function Get-BackgroundConfiguration { return $script:fixtureConfiguration }
function Get-OwnedBackgroundTask { param($Configuration) return $script:ownedTask }
function Disable-ScheduledTask { param($TaskName,$TaskPath) $script:operations += 'disable' }
function Stop-ScheduledTask { param($TaskName,$TaskPath) $script:operations += 'stop' }
function Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm) $script:operations += 'unregister'; $script:ownedTask=$null }
$status=Invoke-BackgroundManagement 'Uninstall'
[pscustomobject]@{Operations=$script:operations;Installed=$status.Installed;Healthy=$status.Healthy;RuntimeRecordError=$status.RuntimeRecordError} | ConvertTo-Json -Compress
`);
      const json = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('\n{') + 1).trim());
      assert.deepEqual(json, { Operations: ['disable', 'stop', 'unregister'], Installed: false, Healthy: false, RuntimeRecordError: true });
    }
  } finally { await unlink(junction); }
});

test('Install仅接受Disabled无实例且端口可核对的前置状态，不注册或停止任何不合格实例', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureConfiguration=$configuration
$originalTask=[pscustomobject]@{
  Description=$configuration.Owner+'|root='+$configuration.ProjectRoot+'|sid='+$configuration.UserSid
  Actions=@([pscustomobject]@{Execute=$configuration.NodePath;Arguments=(Get-BackgroundArguments $configuration);WorkingDirectory=$configuration.ProjectRoot})
  Principal=[pscustomobject]@{UserId=$configuration.UserSid;LogonType='S4U';RunLevel='Limited'}
  Settings=[pscustomobject]@{Enabled=$false}
  State='Disabled'
}
function Assert-BackgroundAdministrator { <# 只测试控制流程，不实际提权。 #> $script:operations += 'administrator-gate' }
function Get-BackgroundConfiguration { <# 管理入口只能返回已隔离配置。 #> return $script:fixtureConfiguration }
function Get-ScheduledTask { <# 精确任务归属仍由生产函数核对。 #> param($TaskPath,$TaskName,$ErrorAction) return $script:ownedTask }
function Get-BackgroundTaskInstanceCount { <# 只返回本测试模拟实例数。 #> param($Configuration) return $script:instanceCount }
function Get-NetTCPConnection {
  <# 只模拟固定端口元数据；查询失败不能当成没有监听者。 #>
  param($State,$ErrorAction)
  if ($script:portFailure) { throw 'fixture-port-query-failed' }
  if ($script:foreignListener) { return [pscustomobject]@{LocalPort=$configuration.Port;OwningProcess=999} }
  return @()
}
function Get-VerifiedBackgroundProcess {
  <# 模拟预览句柄并记录释放；安装不能把它停止后自动转成调度运行。 #>
  param($Configuration)
  $script:processQueries++
  if ($script:badRecord) { throw '看板运行身份记录损坏，拒绝操作进程。' }
  if ($script:preview) {
    $p=[pscustomobject]@{Id=111}
    $p | Add-Member ScriptMethod Dispose { <# 仅记录模拟句柄释放。 #> $script:disposed++ }
    return $p
  }
  return $null
}
function Stop-BackgroundInstance { <# 记录不应发生的预览停止。 #> param($Configuration,$Task) $script:operations += 'stop-preview' }
function Start-ScheduledTask { <# 内存记录，绝不调用真实任务。 #> param($TaskPath,$TaskName) $script:operations += 'start-scheduled' }
function Register-ScheduledTask { <# 内存记录，绝不注册真实任务。 #> param($TaskPath,$TaskName,$Xml) $script:operations += 'register' }
function Start-Process { <# 安装控制侧不能启动管理员预览。 #> $script:operations += 'start-process' }
$results=@()
foreach ($mode in @('preview','legacyPreview','enabled','running','queued','ready','instances','port','portError','badRecord')) {
  $script:ownedTask=$originalTask | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  $script:preview=$false
  $script:instanceCount=0
  $script:foreignListener=$false
  $script:portFailure=$false
  $script:badRecord=$false
  switch ($mode) {
    'preview' { $script:ownedTask=$null; $script:preview=$true }
    'legacyPreview' { $script:preview=$true }
    'enabled' { $script:ownedTask.Settings.Enabled=$true }
    'running' { $script:ownedTask.State='Running' }
    'queued' { $script:ownedTask.State='Queued' }
    'ready' { $script:ownedTask.State='Ready' }
    'instances' { $script:instanceCount=1 }
    'port' { $script:foreignListener=$true }
    'portError' { $script:portFailure=$true }
    'badRecord' { $script:badRecord=$true }
  }
  $script:operations=@()
  $script:processQueries=0
  $script:disposed=0
  $rejected=$false
  $message=''
  try { $null=Invoke-BackgroundManagement 'Install' } catch { $rejected=$true; $message=$_.Exception.Message }
  $results += [pscustomobject]@{Mode=$mode;Rejected=$rejected;Message=$message;Operations=$script:operations;ProcessQueries=$script:processQueries;Disposed=$script:disposed;Preview=$script:preview}
}
$results | ConvertTo-Json -Depth 5 -Compress
`);
  for (const item of JSON.parse(result.stdout.trim())) {
    assert.equal(item.Rejected, true);
    assert.deepEqual(item.Operations, ['administrator-gate']);
    if (['preview', 'legacyPreview'].includes(item.Mode)) {
      assert.match(item.Message, /不会自动停止或转换普通预览/);
      assert.equal(item.Preview, true);
      assert.equal(item.Disposed, 1);
    } else if (['enabled', 'running', 'queued', 'ready', 'instances'].includes(item.Mode)) {
      assert.match(item.Message, /已停用且无任务实例/);
      assert.equal(item.ProcessQueries, 0);
    } else if (item.Mode === 'port') {
      assert.match(item.Message, /其他或未核对进程占用/);
      assert.equal(item.ProcessQueries, 1);
    } else if (item.Mode === 'portError') {
      assert.match(item.Message, /fixture-port-query-failed/);
      assert.equal(item.ProcessQueries, 1);
    } else {
      assert.match(item.Message, /运行身份记录损坏/);
      assert.equal(item.ProcessQueries, 1);
    }
  }
});

test('Install隔离事务排他保留旧Legacy/Protected定义，停用注册与权限读回后才启用启动', { skip: !windows }, async t => {
  for (const kind of ['Legacy', 'Protected']) {
    const options = { ...await fixture(t), port: await freePort() };
    const result = await powershell(installFixture(options, kind) + `
$status=Invoke-BackgroundManagement 'Install'
[pscustomobject]@{Operations=$script:operations;BackupBeforeRegister=$script:backupBeforeRegister;RegisteredDisabled=$script:registeredDisabled;
  BackupEqual=((Get-Content -LiteralPath (Join-Path $configuration.StateDirectory 'task-definition-before-login.xml') -Raw -Encoding UTF8) -ceq $script:originalXml);
  Security=$script:fixtureSecurity;Kind=(Get-BackgroundTaskDefinitionKind $configuration (Get-OwnedBackgroundTask $configuration));Healthy=$status.Healthy;Limited=$status.LimitedTokenVerified;Interactive=$status.InteractiveSessionVerified} | ConvertTo-Json -Depth 5 -Compress
`);
    const checks = JSON.parse(result.stdout.trim());
    assert.deepEqual(checks.Operations, ['administrator', 'register', 'security', 'enable', 'start']);
    assert.equal(checks.BackupBeforeRegister, true);
    assert.equal(checks.RegisteredDisabled, true);
    assert.equal(checks.BackupEqual, true);
    assert.match(checks.Security, /O:BAG:BAD:P\(A;;FA;;;SY\)\(A;;FA;;;BA\)\(A;;GXGR;;;S-1-/);
    assert.equal(checks.Kind, 'Login');
    assert.equal(checks.Healthy && checks.Limited && checks.Interactive, true);
  }
});

test('Install各阶段失败停用并停止登录定义，不回装旧链；备份冲突和注册前竞态不写任务', { skip: !windows }, async t => {
  for (const failure of ['register', 'readback', 'security', 'enable', 'start', 'token', 'session', 'backup', 'race']) {
    const options = { ...await fixture(t), port: await freePort() };
    const result = await powershell(installFixture(options) + `
$script:fail=${literal(failure)}
if ($script:fail -eq 'backup') {
  $null=[IO.Directory]::CreateDirectory($configuration.StateDirectory)
  [IO.File]::WriteAllText((Join-Path $configuration.StateDirectory 'task-definition-before-login.xml'),'preserve-existing-evidence')
}
if ($script:fail -eq 'race') {
  function Get-BackgroundTaskXml {
    <# 仅在原定义已备份后模拟任务被别的操作者启用，必须在注册前拒绝。 #>
    param($Configuration)
    $script:fixtureTask.Settings.Enabled=$true
    return $script:fixtureXml
  }
}
$rejected=$false; $message=''
try { $null=Invoke-BackgroundManagement 'Install' } catch {$rejected=$true; $message=if($_.ErrorDetails){$_.ErrorDetails.Message}else{$_.Exception.Message}}
[pscustomobject]@{Rejected=$rejected;Message=$message;Operations=$script:operations;Enabled=$script:fixtureTask.Settings.Enabled;RecordPresent=$script:recordPresent;
  Kind=(Get-BackgroundTaskDefinitionKind $configuration $script:fixtureTask);Backup=[IO.File]::ReadAllText((Join-Path $configuration.StateDirectory 'task-definition-before-login.xml'))} | ConvertTo-Json -Depth 5 -Compress
`);
    const checks = JSON.parse(result.stdout.trim());
    assert.equal(checks.Rejected, true, failure);
    assert.equal(checks.RecordPresent, false, failure);
    if (['backup', 'race'].includes(failure)) {
      assert.deepEqual(checks.Operations, ['administrator'], failure);
      assert.equal(checks.Kind, 'Legacy', failure);
      if (failure === 'backup') assert.equal(checks.Backup, 'preserve-existing-evidence');
      else assert.match(checks.Message, /注册前任务状态或导出发生变化/);
    } else {
      assert.equal(checks.Kind, 'Login', failure);
      assert.equal(checks.Enabled, false, failure);
      assert.ok(checks.Operations.includes('disable') && checks.Operations.includes('stop'), failure);
      assert.equal(checks.Operations.filter(value => value === 'register').length, 1, failure);
      assert.match(checks.Message, /停用读回=True；无实例读回=True/, failure);
    }
  }
});

test('Login的Start/Enable必须健康与真实有限登录身份同时通过，失败停用且不能用已有健康实例快捷放行', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(managementFixture(options) + `
$results=@()
foreach ($requested in @('Start','Enable')) {
  foreach ($failure in @('start','token','session','healthy-existing')) {
    $script:fail=$failure; $script:operations=@(); $script:recordPresent=$false
    $script:fixtureTask.Settings.Enabled=($requested -eq 'Start'); $script:fixtureTask.State='Ready'
    function Get-VerifiedBackgroundProcess { <# 无真实进程；仅健康失败的快捷路径提供可释放内存对象。 #> param($Configuration) if($script:fail -eq 'healthy-existing'){ $p=[pscustomobject]@{Id=111}; $p|Add-Member ScriptMethod Dispose { <# 释放模拟句柄。 #> }; return $p }; return $null }
    function Get-BackgroundStatus {
      <# 每项证据单独失败，不访问真实健康或令牌；生产判据仍由独立句柄测试覆盖。 #>
      param($Configuration)
      return [pscustomobject]@{Installed=$true;Enabled=$script:fixtureTask.Settings.Enabled;TaskState=$script:fixtureTask.State;TaskConfigurationValid=$true;RuntimeRecordError=$false;
        ManagedProcessId=if($script:recordPresent -or $script:fail -eq 'healthy-existing'){111}else{$null};Healthy=($script:fail -ne 'healthy-existing' -and $script:recordPresent);
        LimitedTokenVerified=($script:fail -ne 'token');InteractiveSessionVerified=($script:fail -ne 'session')}
    }
    function Stop-BackgroundInstance { <# 只模拟已定位实例停止，不处理真实PID。 #> param($Configuration,$Task) $script:recordPresent=$false }
    $rejected=$false; $message=''
    try {$null=Invoke-BackgroundManagement $requested} catch {$rejected=$true; $message=if($_.ErrorDetails){$_.ErrorDetails.Message}else{$_.Exception.Message}}
    $results += [pscustomobject]@{Action=$requested;Failure=$failure;Rejected=$rejected;Enabled=$script:fixtureTask.Settings.Enabled;Operations=$script:operations;Message=$message}
  }
}
$results | ConvertTo-Json -Depth 5 -Compress
`);
  for (const item of JSON.parse(result.stdout.trim())) {
    assert.equal(item.Rejected, true, `${item.Action}:${item.Failure}`);
    assert.equal(item.Enabled, false);
    assert.ok(item.Operations.includes('disable') && item.Operations.includes('stop'));
    if (item.Failure === 'healthy-existing') assert.ok(!item.Operations.includes('start'));
  }
});

test('独立令牌判据接受标准登录有限身份，逐项拒绝权限、会话、查询和稳定句柄竞态', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:expectedHandle=[IntPtr]1234
function Get-BackgroundNativeTokenEvidence {
  <# 只替代原生读取，不替代生产有限权限和句柄稳定判定；必须收到既有Handle而非PID。 #>
  param($ProcessHandle)
  if ($ProcessHandle -ne $script:expectedHandle) { throw 'fixture-wrong-handle' }
  if ($script:case -eq 'query') { throw 'fixture-token-query-failed' }
  $evidence=[pscustomobject]@{UserSid=$configuration.UserSid;Primary=$true;TokenSessionId=1;Elevated=$false;IntegrityRid=8192;EffectiveAdministrator=$false}
  switch ($script:case) {
    'sid' {$evidence.UserSid='S-1-5-18'}
    'primary' {$evidence.Primary=$false}
    'administrator' {$evidence.EffectiveAdministrator=$true}
    'elevated' {$evidence.Elevated=$true}
    'high' {$evidence.IntegrityRid=12288}
    'negative-integrity' {$evidence.IntegrityRid=-1}
    'token-session0' {$evidence.TokenSessionId=0}
    'token-other-session' {$evidence.TokenSessionId=2}
  }
  return $evidence
}
function Get-BackgroundInteractiveSessionEvidence {
  <# 模拟独立会话读取；查询失败和其他登录用户不能通过。 #>
  param($SessionId)
  if ($script:case -eq 'session-query') {throw 'fixture-session-query-failed'}
  return [pscustomobject]@{SessionId=1;UserSid=if($script:case -eq 'session-owner'){'S-1-5-18'}else{$configuration.UserSid};LoggedOn=$true}
}
$results=@()
foreach ($script:case in @('valid','sid','primary','administrator','elevated','high','negative-integrity','token-session0','token-other-session','session0','other-session','session-owner','query','session-query','pid-race','created-race','session-race','exit-race')) {
  $p=[pscustomobject]@{Id=111;Handle=$script:expectedHandle;StartTime=[DateTime]::UtcNow;SessionId=1;HasExited=$false}
  if($script:case -eq 'session0'){$p.SessionId=0}
  if($script:case -eq 'other-session'){$p.SessionId=2}
  $p|Add-Member ScriptMethod Refresh {
    <# 在令牌读取后模拟编号/创建时间/会话/退出竞态，不能返回稳定身份成功。 #>
    switch ($script:case) {'pid-race' {$this.Id++} 'created-race' {$this.StartTime=$this.StartTime.AddTicks(1)} 'session-race' {$this.SessionId++} 'exit-race' {$this.HasExited=$true}}
  }
  $verification=Get-BackgroundTokenVerification $configuration $p
  $results += [pscustomobject]@{Case=$script:case;Limited=$verification.LimitedTokenVerified;Interactive=$verification.InteractiveSessionVerified}
}
$results | ConvertTo-Json -Depth 4 -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.deepEqual(checks[0], { Case: 'valid', Limited: true, Interactive: true });
  for (const item of checks.slice(1)) assert.equal(item.Limited && item.Interactive, false, item.Case);
  for (const item of checks.filter(item => ['administrator', 'elevated', 'high', 'negative-integrity', 'primary', 'query', 'pid-race', 'created-race', 'session-race', 'exit-race'].includes(item.Case))) assert.equal(item.Limited, false, item.Case);
});

test('Status不采信record.elevated=false与健康响应，原生失败保持权限未验证且释放稳定句柄', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:disposed=0
function Get-BackgroundRecord { <# 可写记录只定位实例，不能证明权限。 #> param($Configuration) return [pscustomobject]@{elevated=$false;sessionId=1} }
function Get-VerifiedBackgroundProcess { <# 模拟已经完整定位的稳定进程；状态结束必须释放。 #> param($Configuration) $p=[pscustomobject]@{Id=111;Handle=[IntPtr]1234;StartTime=[DateTime]::UtcNow;SessionId=1;HasExited=$false}; $p|Add-Member ScriptMethod Dispose { <# 记录唯一模拟句柄释放。 #> $script:disposed++ }; return $p }
function Get-BackgroundNativeTokenEvidence { <# 独立读取失败，不能沿用记录内false。 #> param($ProcessHandle) throw 'fixture-token-query-failed' }
function Test-BackgroundHealth { <# 健康单独成功不证明身份。 #> param($Configuration) return $true }
$status=Get-BackgroundStatus $configuration
[pscustomobject]@{Healthy=$status.Healthy;Limited=$status.LimitedTokenVerified;Interactive=$status.InteractiveSessionVerified;Disposed=$script:disposed;Boot=$status.BootRecoveryVerified;NonInteractive=$status.NonInteractiveSessionVerified} | ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { Healthy: true, Limited: false, Interactive: false, Disposed: 1, Boot: false, NonInteractive: false });
});

test('纯内存系统查询桥在PowerShell5.1查询真实当前令牌，并在无效句柄调用内部捕获错误6', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$p=[Diagnostics.Process]::GetCurrentProcess()
try {
  $evidence=Get-BackgroundNativeTokenEvidence $p.Handle
  $verification=Get-BackgroundTokenVerification $configuration $p
  $native=Initialize-BackgroundTokenNative
  $arguments=[object[]]@([IntPtr]987654,[uint32]8,[IntPtr]::Zero,[int]0)
  $opened=$native.GetMethod('OpenProcessToken').Invoke($null,$arguments)
  [pscustomobject]@{UserMatches=($evidence.UserSid -eq $configuration.UserSid);Primary=$evidence.Primary;Limited=$verification.LimitedTokenVerified;
    Interactive=$verification.InteractiveSessionVerified;InvalidHandleRejected=($opened -eq 0);Error=$arguments[3]} | ConvertTo-Json -Compress
} finally {$p.Dispose()}
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { UserMatches: true, Primary: true, Limited: true, Interactive: true, InvalidHandleRejected: true, Error: 6 });
});

test('失败收尾独立核对真实任务实例与端口；读回失败或未知残留不会宣称无实例或误杀', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(managementFixture(options) + `
$results=@()
foreach ($mode in @('clear','instances','port','port-error','observer-live','observer-error','disable-error','foreign')) {
  $script:mode=$mode; $script:operations=@(); $script:fixtureTask.Settings.Enabled=$true; $script:fixtureTask.State='Running'
  function Get-BackgroundTaskInstanceCount { <# 每项只返回受控实例残留。 #> param($Configuration) return $(if($script:mode -eq 'instances'){1}else{0}) }
  function Get-NetTCPConnection { <# 未知监听者只留存元数据，不能被收尾结束。 #> param($State,$ErrorAction) if($script:mode -eq 'port-error'){throw 'fixture-port-query-failed'}; if($script:mode -eq 'port'){return [pscustomobject]@{LocalPort=$configuration.Port;OwningProcess=999}}; return @() }
  function Get-BackgroundPortObservation {
    <# 各项隔离端口存在、查询未知及观察者未退出，任何一项都不能形成无实例结论。 #>
    param($Port)
    if ($script:mode -eq 'observer-error') { throw 'fixture-observer-failed' }
    return [pscustomobject]@{
      State=$(if($script:mode -eq 'port'){'Present'}elseif($script:mode -eq 'port-error'){'Unknown'}else{'Absent'})
      Reason=$(if($script:mode -eq 'port-error'){'QueryFailed'}else{'Observed'})
      ObserverProcessId=123;ObserverStarted=$true;ObserverExited=($script:mode -ne 'observer-live');ElapsedMilliseconds=0
    }
  }
  function Disable-ScheduledTask { <# 模拟普通控制令牌无停用权限，不能报停用成功。 #> param($TaskPath,$TaskName,$ErrorAction) $script:operations += 'disable'; if($script:mode -eq 'disable-error'){throw 'fixture-access-denied'}; $script:fixtureTask.Settings.Enabled=$false; $script:fixtureTask.State='Disabled' }
  function Get-OwnedBackgroundTask { <# 归属变为外来时禁止任何收尾写入。 #> param($Configuration) if($script:mode -eq 'foreign'){throw 'fixture-foreign-task'}; return $script:fixtureTask }
  $message=Stop-BackgroundFailedRun $configuration
  $results += [pscustomobject]@{Mode=$mode;Message=$message;Operations=$script:operations}
}
$results | ConvertTo-Json -Depth 5 -Compress
`);
  for (const item of JSON.parse(result.stdout.trim())) {
    if (item.Mode === 'clear') assert.match(item.Message, /停用读回=True；无实例读回=True/);
    if (['instances', 'port', 'port-error', 'observer-live', 'observer-error'].includes(item.Mode)) assert.match(item.Message, /无实例读回=False/);
    if (item.Mode === 'clear') assert.match(item.Message, /端口观测=Absent\/Observed/);
    if (item.Mode === 'port') assert.match(item.Message, /端口观测=Present\/Observed/);
    if (item.Mode === 'port-error') assert.match(item.Message, /端口观测=Unknown\/QueryFailed.*监听状态无法确认/);
    if (item.Mode === 'observer-live') assert.match(item.Message, /监听状态无法确认/);
    if (item.Mode === 'observer-error') assert.match(item.Message, /状态读回失败/);
    if (item.Mode === 'disable-error') assert.match(item.Message, /停用读回=False.*停用失败/);
    if (item.Mode === 'foreign') assert.deepEqual(item.Operations, []);
  }
});

test('失败收尾监听快照只接受完整数字地址表，坏行、陌生目标状态与伪表头均保持未知', { skip: !windows }, async t => {
  const port = 45123;
  const header = 'Active Connections\r\n\r\n  Proto  Local Address  Foreign Address  State  PID\r\n';
  const chineseHeader = '活动连接\r\n\r\n  协议  本地地址  外部地址  状态  PID\r\n';
  const present = `  TCP  127.0.0.1:${port}  0.0.0.0:0  LISTENING  504\r\n`;
  const udp = `  UDP  0.0.0.0:${port}  *:*  600\r\n`;
  const cases = [
    ['ipv4-listening', header + present, 'Present'],
    ['chinese-headers', chineseHeader + present, 'Present'],
    ['without-headers', present, 'Present'],
    ['ipv6-listening', header + `TCP [::1]:${port} [::]:0 LISTENING 408`, 'Present'],
    ['ipv6-scoped-listening', header + `TCP [fe80::abcd%12]:${port} [::]:0 LISTENING 408`, 'Present'],
    ['listening-pid-zero', header + `TCP 0.0.0.0:${port} 0.0.0.0:0 LISTENING 0`, 'Present'],
    ['udp-does-not-prove-tcp', header + udp, 'Absent'],
    ['scoped-ipv6-udp', header + `UDP [fe80::abcd%12]:${port} *:* 600`, 'Absent'],
    ['different-local-port', header + 'TCP 127.0.0.1:45124 0.0.0.0:0 LISTENING 504', 'Absent'],
    ['target-established', header + `TCP 127.0.0.1:${port} 127.0.0.1:55000 ESTABLISHED 504`, 'Absent'],
    ['target-time-wait-pid-zero', header + `TCP 127.0.0.1:${port} 127.0.0.1:55000 TIME_WAIT 0`, 'Absent'],
    ['remote-port-is-not-local', header + `TCP 127.0.0.1:55000 127.0.0.1:${port} ESTABLISHED 504`, 'Absent'],
    ['empty', '', 'Unknown'],
    ['whitespace-only', ' \r\n\t', 'Unknown'],
    ['headers-without-data', header, 'Unknown'],
    ['fake-header-without-data', 'Something Local Address Foreign Address State PID', 'Unknown'],
    ['fake-header-before-valid-udp', 'Network query failed\r\n' + udp, 'Unknown'],
    ['fake-column-header-before-valid-udp', 'Active Connections\r\nSomething Local Address Foreign Address State PID\r\n' + udp, 'Unknown'],
    ['unrecognized-localized-header', 'Connexions actives\r\n' + udp, 'Unknown'],
    ['numeric-header-cannot-hide-row', 'Active Connections 45123\r\n' + udp, 'Unknown'],
    ['truncated-tcp-row', header + `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING`, 'Unknown'],
    ['truncated-udp-row', header + `UDP 0.0.0.0:${port} *:*`, 'Unknown'],
    ['invalid-process-number', header + `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING not-a-pid`, 'Unknown'],
    ['overflow-process-number', header + `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 4294967296`, 'Unknown'],
    ['invalid-local-address', header + `TCP localhost:${port} 0.0.0.0:0 LISTENING 504`, 'Unknown'],
    ['invalid-remote-address', header + `TCP 127.0.0.1:${port} hostname:0 LISTENING 504`, 'Unknown'],
    ['ipv6-missing-brackets', header + `TCP fe80::abcd%12:${port} [::]:0 LISTENING 504`, 'Unknown'],
    ['overflow-local-port', header + 'TCP 127.0.0.1:65536 0.0.0.0:0 LISTENING 504', 'Unknown'],
    ['unknown-target-state', header + `TCP 127.0.0.1:${port} 0.0.0.0:0 FUTURE_STATE 504`, 'Unknown'],
    ['localized-target-state', header + `TCP 127.0.0.1:${port} 0.0.0.0:0 侦听 504`, 'Unknown'],
    ['valid-target-plus-truncated-row', header + present + 'TCP 127.0.0.1:', 'Unknown'],
    ['valid-target-plus-garbage', header + present + 'unexpected trailing diagnostic', 'Unknown'],
    ['unsupported-protocol-prefix', header + `TCP4 127.0.0.1:${port} 0.0.0.0:0 LISTENING 504`, 'Unknown'],
  ].map(([name, text, expected]) => ({ name, text, expected }));
  const result = await powershell(`
$cases=ConvertFrom-Json -InputObject ${literal(JSON.stringify(cases))}
$results=@(foreach ($case in $cases) {
  [pscustomobject]@{Name=$case.name;State=(ConvertFrom-BackgroundListenerSnapshot -Text $case.text -Port ${port})}
})
ConvertTo-Json -InputObject $results -Depth 3 -Compress
`);
  const actual = JSON.parse(result.stdout.trim());
  assert.equal(actual.length, cases.length);
  for (let index = 0; index < cases.length; index += 1) {
    assert.equal(actual[index].Name, cases[index].name);
    assert.equal(actual[index].State, cases[index].expected, cases[index].name);
  }
  t.diagnostic(JSON.stringify({ evidence: 'listener-snapshot-parser-cases', passed: cases.length,
    present: cases.filter(item => item.expected === 'Present').length,
    absent: cases.filter(item => item.expected === 'Absent').length,
    unknown: cases.filter(item => item.expected === 'Unknown').length }));
});

test('失败收尾真实端口观察区分存在与不存在，观察进程退出后才返回确定状态', { skip: !windows }, async t => {
  const port = await freePort();
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve));
  t.after(async () => { if (listener.listening) await new Promise(resolve => listener.close(resolve)); });
  for (const expected of ['Present', 'Absent']) {
    if (expected === 'Absent') await new Promise(resolve => listener.close(resolve));
    const result = await powershell(observerExitReadback() + `Get-FixturePortObservation -Port ${port} | ConvertTo-Json -Depth 4 -Compress`);
    const { Observation: observation, ObserverAbsent: observerAbsent } = JSON.parse(result.stdout.trim());
    assert.equal(observation.State, expected);
    assert.equal(observation.Reason, 'Observed');
    assert.equal(observation.ObserverStarted, true);
    assert.equal(observation.ObserverExited, true);
    assert.equal(observerAbsent, true, '产品返回的自有观察者仍存在，不能只采信退出标志。');
    assert.ok(Number.isSafeInteger(observation.ObserverProcessId) && observation.ObserverProcessId > 0);
    assert.ok(Number.isSafeInteger(observation.ElapsedMilliseconds) && observation.ElapsedMilliseconds >= 0);
    t.diagnostic(JSON.stringify({ evidence: 'real-port-observation-observer-exited', ...observation, observerAbsent }));
  }
  await t.test('系统支持IPv6时真实回环监听同样可观测，关闭后不再报告存在', async subtest => {
    const ipv6Port = await freePort();
    const ipv6Listener = net.createServer();
    subtest.after(async () => { if (ipv6Listener.listening) await new Promise(resolve => ipv6Listener.close(resolve)); });
    try {
      await new Promise((resolve, reject) => {
        ipv6Listener.once('error', reject);
        ipv6Listener.listen({ port: ipv6Port, host: '::1', ipv6Only: true }, () => {
          ipv6Listener.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'ENOTSUP'].includes(error.code)) {
        subtest.skip(`系统未提供IPv6回环监听能力：${error.code}`);
        return;
      }
      throw error;
    }
    for (const expected of ['Present', 'Absent']) {
      if (expected === 'Absent') await new Promise(resolve => ipv6Listener.close(resolve));
      const result = await powershell(observerExitReadback() + `Get-FixturePortObservation -Port ${ipv6Port} | ConvertTo-Json -Depth 4 -Compress`);
      const { Observation: observation, ObserverAbsent: observerAbsent } = JSON.parse(result.stdout.trim());
      assert.equal(observation.State, expected);
      assert.equal(observation.Reason, 'Observed');
      assert.equal(observation.ObserverStarted, true);
      assert.equal(observation.ObserverExited, true);
      assert.equal(observerAbsent, true);
      subtest.diagnostic(JSON.stringify({ evidence: 'real-ipv6-port-observation-observer-exited', ...observation, observerAbsent }));
    }
  });
});

test('失败收尾观察的查询异常、超时和异常退出均保持未知，超时只结束自有观察进程', { skip: !windows }, async t => {
  const port = await freePort();
  for (const [name, filename, args, reason] of [
    ['query-error', 'cmd.exe', '/d /c exit /b 37', 'QueryFailed'],
    ['timeout', 'ping.exe', '-n 15 127.0.0.1', 'Timeout'],
    ['invalid-output', 'cmd.exe', '/d /c echo fixture-invalid-listener-output', 'InvalidResponse'],
  ]) {
    const result = await powershell(observerExitReadback() + `
$original=(Get-Command Get-BackgroundPortObservation -CommandType Function).Definition
$file=${literal(OBSERVER_FILE_ASSIGNMENT)}
$arguments=${literal(OBSERVER_ARGUMENT_ASSIGNMENT)}
$kill='$observer.Kill()'
foreach ($needle in @($file,$arguments,$kill)) {
  if ($original.IndexOf($needle) -lt 0 -or $original.IndexOf($needle) -ne $original.LastIndexOf($needle)) { throw 'fixture-observer-fault-boundary-not-unique' }
}
$script:fixtureObserverKillCount=0
try {
  # 仅替换固定程序和参数：cmd使用内建exit/echo，阻塞直接使用ping单进程，不经shell创建孙进程。
  # 实际Kill前只增加计数，保留原Kill、等待和退出读回，不能让自然退出冒充期限取消。
  $changed=$original.Replace($file,${literal(`$observer.StartInfo.FileName = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\\${filename}'`)})
  $changed=$changed.Replace($arguments,${literal(`$observer.StartInfo.Arguments = ${literal(args)}`)}).Replace($kill,'$script:fixtureObserverKillCount += 1; '+$kill)
  Set-Item -LiteralPath 'Function:\\Get-BackgroundPortObservation' -Value ([scriptblock]::Create($changed))
  $result=Get-FixturePortObservation -Port ${port}
  [pscustomobject]@{Observation=$result.Observation;ObserverAbsent=$result.ObserverAbsent;KillCount=$script:fixtureObserverKillCount} | ConvertTo-Json -Depth 4 -Compress
} finally {
  Set-Item -LiteralPath 'Function:\\Get-BackgroundPortObservation' -Value ([scriptblock]::Create($original))
}
`);
    const { Observation: observation, ObserverAbsent: observerAbsent, KillCount: killCount } = JSON.parse(result.stdout.trim());
    assert.equal(observation.State, 'Unknown', name);
    assert.equal(observation.Reason, reason, name);
    assert.equal(observation.ObserverStarted, true, name);
    assert.equal(observation.ObserverExited, true, name);
    assert.equal(observerAbsent, true, `${name}后的自有观察进程必须实际退出。`);
    assert.equal(killCount, name === 'timeout' ? 1 : 0, '超时须实际取消自有观察者；已正常退出的故障不可被补杀。');
    if (name === 'timeout') assert.ok(observation.ElapsedMilliseconds >= 3000, '不能提前伪造3秒观测期限已耗尽。');
    t.diagnostic(JSON.stringify({ evidence: 'observer-fault-remains-unknown-and-exited', fault: name, ...observation, observerAbsent, killCount }));
  }
});

test('失败收尾观察不把预算之后读到的有效退出码当成期限内无监听', { skip: !windows }, async t => {
  const port = await freePort();
  const result = await powershell(observerExitReadback() + `
$original=(Get-Command Get-BackgroundPortObservation -CommandType Function).Definition
$file=${literal(OBSERVER_FILE_ASSIGNMENT)}
$arguments=${literal(OBSERVER_ARGUMENT_ASSIGNMENT)}
$wait='if ($observer.WaitForExit($remaining) -and $observer.HasExited) {'
foreach ($needle in @($file,$arguments,$wait)) {
  if ($original.IndexOf($needle) -lt 0 -or $original.IndexOf($needle) -ne $original.LastIndexOf($needle)) { throw 'fixture-late-result-boundary-not-unique' }
}
try {
  # 只模拟父进程迟迟恢复调度：先确认自有观察者已给出有效码，再延迟超过原预算；产品判据与期限不变。
  $delay='$null=$observer.WaitForExit(3000); if(-not $observer.HasExited -or $observer.ExitCode -ne 0){throw "fixture-late-exit-not-ready"}; if(-not $stdout.Wait(1000)){throw "fixture-late-output-not-ready"}; $script:fixtureLateExitCode=$observer.ExitCode; $script:fixtureLateSnapshotState=ConvertFrom-BackgroundListenerSnapshot -Text $stdout.Result -Port $Port; if($script:fixtureLateSnapshotState -ne "Absent"){throw "fixture-late-snapshot-not-absent"}; [Threading.Thread]::Sleep(3100); '
  $changed=$original.Replace($file,${literal("$observer.StartInfo.FileName = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\\cmd.exe'")})
  $changed=$changed.Replace($arguments,${literal("$observer.StartInfo.Arguments = '/d /c echo TCP 127.0.0.1:1 0.0.0.0:0 LISTENING 0'")}).Replace($wait,$delay+$wait)
  Set-Item -LiteralPath 'Function:\\Get-BackgroundPortObservation' -Value ([scriptblock]::Create($changed))
  $result=Get-FixturePortObservation -Port ${port}
  [pscustomobject]@{Observation=$result.Observation;ObserverAbsent=$result.ObserverAbsent;LateExitCode=$script:fixtureLateExitCode;LateSnapshotState=$script:fixtureLateSnapshotState} | ConvertTo-Json -Depth 4 -Compress
} finally {
  Set-Item -LiteralPath 'Function:\\Get-BackgroundPortObservation' -Value ([scriptblock]::Create($original))
}
`);
  const { Observation: observation, ObserverAbsent: observerAbsent, LateExitCode: lateExitCode,
    LateSnapshotState: lateSnapshotState } = JSON.parse(result.stdout.trim());
  assert.equal(lateExitCode, 0, '必须先实际读到自有观察者的零退出码，不能只模拟一个超时。');
  assert.equal(lateSnapshotState, 'Absent', '必须先读到可确定的有效快照，不能用空输出代替晚到有效结果。');
  assert.equal(observation.State, 'Unknown');
  assert.equal(observation.Reason, 'Timeout');
  assert.equal(observation.ObserverExited, true);
  assert.equal(observerAbsent, true);
  assert.ok(observation.ElapsedMilliseconds >= 3100);
  t.diagnostic(JSON.stringify({ evidence: 'late-valid-observer-exit-remains-unknown', lateExitCode, lateSnapshotState, ...observation, observerAbsent }));
});

test('Start、Enable与Install保留原错误记录，收尾抛错及嵌套传播都只收尾一次', { skip: !windows }, async t => {
  for (const action of ['Start', 'Enable', 'Install']) {
    for (const cleanupThrows of [false, true]) {
      const options = { ...await fixture(t), port: await freePort() };
      const setup = action === 'Install' ? installFixture(options) : managementFixture(options);
      const result = await powershell(setup + `
$script:cleanupCalls=0
$script:primaryFailure=$null
function Start-ScheduledTask {
  <# 在真实三入口都经过的启动边界产生固定原错误；不启动任务或进程。 #>
  param($TaskPath,$TaskName,$ErrorAction)
  $exception=[InvalidOperationException]::new('fixture-primary-start-rejection')
  $script:primaryFailure=[Management.Automation.ErrorRecord]::new($exception,'FixturePrimaryStart',[Management.Automation.ErrorCategory]::InvalidOperation,'fixture-owned-task')
  $script:primaryFailure.ErrorDetails=[Management.Automation.ErrorDetails]::new('fixture-original-detail fixture-primary-start-rejection')
  throw $script:primaryFailure
}
function Stop-BackgroundFailedRun {
  <# 只计数本次收尾调用；模拟收尾本身失败时也不能替换最初错误记录。 #>
  param($Configuration)
  $script:cleanupCalls++
  if (${cleanupThrows ? '$true' : '$false'}) { throw 'fixture-cleanup-failed' }
  return 'fixture-cleanup-confirmed'
}
$rejected=$false; $record=$null
try { $null=Invoke-BackgroundManagement ${literal(action)} } catch {
  $rejected=$true
  $record=[pscustomobject]@{
    Message=$_.Exception.Message;Details=$_.ErrorDetails.Message;ErrorId=$_.FullyQualifiedErrorId
    OriginalErrorId=$script:primaryFailure.FullyQualifiedErrorId
    Category=$_.CategoryInfo.Category.ToString();Target=$_.TargetObject
    SameException=[object]::ReferenceEquals($_.Exception,$script:primaryFailure.Exception)
    CleanupMarked=$_.Exception.Data.Contains('AwrDashboard.FailedRunCleanup')
  }
}
[pscustomobject]@{Rejected=$rejected;CleanupCalls=$script:cleanupCalls;Record=$record} | ConvertTo-Json -Depth 4 -Compress
`);
      const checks = JSON.parse(result.stdout.trim());
      const label = `${action}; cleanupThrows=${cleanupThrows}`;
      assert.equal(checks.Rejected, true, label);
      assert.equal(checks.CleanupCalls, 1, label);
      assert.equal(checks.Record.Message, 'fixture-primary-start-rejection', label);
      assert.equal(checks.Record.ErrorId, checks.Record.OriginalErrorId, label);
      assert.equal(checks.Record.Category, 'InvalidOperation', label);
      assert.equal(checks.Record.Target, 'fixture-owned-task', label);
      assert.equal(checks.Record.SameException, true, label);
      assert.equal(checks.Record.CleanupMarked, true, label);
      assert.match(checks.Record.Details, /fixture-original-detail fixture-primary-start-rejection/, label);
      if (cleanupThrows) {
        assert.match(checks.Record.Details, /无实例读回=False.*收尾异常，状态无法确认/, label);
        assert.doesNotMatch(checks.Record.Details, /fixture-cleanup-failed/, label);
      } else assert.match(checks.Record.Details, /fixture-cleanup-confirmed/, label);
      t.diagnostic(JSON.stringify({ evidence: 'original-start-error-retained-once', action, cleanupThrows,
        cleanupCalls: checks.CleanupCalls, sameException: checks.Record.SameException, errorIdRetained: true }));
    }
  }
});

test('原SID权限只接受精确读取执行及系统映射，保留写数据拒绝项，其他权限或主体读回变化拒绝', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(managementFixture(options) + `
$results=@()
foreach ($script:permissionCase in @('normal','mapped','deny-write-data','deny-GW','deny-read','callback','wide','owner','group','control','other-ace')) {
  $script:operations=@()
  $script:fixtureSecurity='O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;'+$configuration.UserSid+')'
  if ($script:permissionCase -in @('deny-write-data','deny-GW','deny-read')) {
    $deny=switch($script:permissionCase){'deny-write-data'{'0x00000002'} 'deny-GW'{'GW'} default{'GR'}}
    $script:fixtureSecurity='O:BAG:BAD:P(D;;'+$deny+';;;'+$configuration.UserSid+')(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;'+$configuration.UserSid+')'
  }
  if ($script:permissionCase -eq 'callback') {$script:fixtureSecurity='O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(XA;;GRGX;;;'+$configuration.UserSid+';(@User.flag == "allowed"))'}
  $original=$script:fixtureSecurity
  function Set-BackgroundTaskSecurityDescriptor {
    <# 只模拟系统映射或异常读回，不操作真实任务权限。 #>
    param($Configuration,$Dacl)
    $script:operations += 'security'
    $copy=[Security.AccessControl.RawSecurityDescriptor]::new($script:fixtureSecurity)
    $copy.DiscretionaryAcl=[Security.AccessControl.RawSecurityDescriptor]::new($Dacl).DiscretionaryAcl
    if ($script:permissionCase -in @('mapped','wide')) {
      for($i=0;$i -lt $copy.DiscretionaryAcl.Count;$i++){
        $ace=$copy.DiscretionaryAcl[$i]
        if($ace.SecurityIdentifier.Value -eq $configuration.UserSid -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed){$ace.AccessMask=if($script:permissionCase -eq 'mapped'){0x001200A9}else{0x001200AB}}
      }
    }
    switch ($script:permissionCase) {
      'owner' {$copy.Owner=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')}
      'group' {$copy.Group=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')}
      'control' {$copy.SetFlags([Security.AccessControl.ControlFlags]([int]$copy.ControlFlags -bxor [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected))}
      'other-ace' {$copy.DiscretionaryAcl.RemoveAce(1)}
    }
    $script:fixtureSecurity=$copy.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
  }
  $accepted=$false; $message=''
  try {Set-BackgroundTaskReadExecutePermission $configuration; $accepted=$true} catch {$message=$_.Exception.Message}
  $results += [pscustomobject]@{Case=$script:permissionCase;Accepted=$accepted;Operations=$script:operations;Unchanged=($script:fixtureSecurity -ceq $original);Security=$script:fixtureSecurity;Message=$message}
}
$results | ConvertTo-Json -Depth 5 -Compress
`);
  for (const item of JSON.parse(result.stdout.trim())) {
    assert.equal(item.Accepted, ['normal', 'mapped', 'deny-write-data'].includes(item.Case), item.Case);
    if (['deny-GW', 'deny-read', 'callback'].includes(item.Case)) {
      assert.deepEqual(item.Operations, [], item.Case);
      assert.equal(item.Unchanged, true, item.Case);
    }
    if (item.Case === 'deny-write-data') assert.match(item.Security, /\(D;;DC;;;S-1-/);
  }
});

test('权限读回期间同名任务主体或动作被替换，启用前复核拒绝且收尾不操作外来任务', { skip: !windows }, async t => {
  for (const change of ['action', 'principal']) {
    const options = { ...await fixture(t), port: await freePort() };
    const result = await powershell(installFixture(options) + `
function Get-BackgroundTaskSecurityDescriptor {
  <# 仅在权限写回后模拟外来替换；启用前必须重新查完整归属。 #>
  param($Configuration)
  if($script:operations -contains 'security') {
    if (${literal(change)} -eq 'action') {$script:fixtureTask.Actions[0].Execute='C:\\foreign.exe'}
    else {$script:fixtureTask.Principal.UserId='S-1-5-18'}
  }
  return $script:fixtureSecurity
}
$rejected=$false; $message=''
try {$null=Invoke-BackgroundManagement 'Install'} catch {$rejected=$true; $message=$_.Exception.Message}
[pscustomobject]@{Rejected=$rejected;Operations=$script:operations;Message=$message} | ConvertTo-Json -Depth 4 -Compress
`);
    const checks = JSON.parse(result.stdout.trim());
    assert.equal(checks.Rejected, true, change);
    assert.deepEqual(checks.Operations, ['administrator', 'register', 'security'], change);
    assert.match(checks.Message, /拒绝|归属/, change);
  }
});

test('任务查询拒绝访问或服务故障不能当作未安装，也不能回退预览或宣称收尾安全', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const result = await powershell(configuration(options) + `
$script:fixtureConfiguration=$configuration
$script:writes=@()
function Get-BackgroundConfiguration { <# 入口只读取本测试内存配置。 #> return $script:fixtureConfiguration }
function Get-NetTCPConnection { <# 固定端口无监听，不能弥补任务查询未知。 #> param($State,$ErrorAction) return @() }
function Start-Process { <# 若错误地回退预览必须被断言发现，不真实启动。 #> $script:writes += 'preview'; throw 'fixture-unexpected-preview' }
function Get-ScheduledTask {
  <# 显式非终止错误由生产ErrorAction Stop提升；除了精确不存在不能被SilentlyContinue吞掉。 #>
  [CmdletBinding()]param($TaskPath,$TaskName)
  switch ($script:mode) {
    'denied' {Write-Error -Message 'fixture-access-denied' -ErrorId 'TaskAccessDenied' -Category PermissionDenied}
    'service' {Write-Error -Message 'fixture-service-failure' -ErrorId 'TaskServiceFailure' -Category ResourceUnavailable}
    'wrong-notfound' {Write-Error -Message 'fixture-not-task-absence' -ErrorId 'DifferentObjectNotFound' -Category ObjectNotFound}
  }
}
$results=@()
foreach ($script:mode in @('denied','service','wrong-notfound')) {
  $statusRejected=$false; $startRejected=$false
  try {$null=Invoke-BackgroundManagement 'Status'} catch {$statusRejected=$true}
  try {$null=Invoke-BackgroundManagement 'Start'} catch {$startRejected=$true}
  $cleanup=Stop-BackgroundFailedRun $configuration
  $results += [pscustomobject]@{Mode=$script:mode;StatusRejected=$statusRejected;StartRejected=$startRejected;Cleanup=$cleanup}
}
[pscustomobject]@{Results=$results;Writes=$script:writes} | ConvertTo-Json -Depth 5 -Compress
`);
  const checks = JSON.parse(result.stdout.trim());
  assert.deepEqual(checks.Writes, []);
  for (const item of checks.Results) {
    assert.equal(item.StatusRejected && item.StartRejected, true, item.Mode);
    assert.match(item.Cleanup, /停用读回=False；无实例读回=False/, item.Mode);
  }
});

test('已归属Queued任务仍可精确停止；隐藏包装硬链接和非固定系统宿主输入拒绝', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const foreign = await fixture(t);
  const result = await powershell(configuration(options) + `
$script:stopped=0
function Stop-ScheduledTask { <# 只计数精确队列实例停止，不操作真实任务。 #> param($TaskPath,$TaskName,$ErrorAction) $script:stopped++ }
Stop-BackgroundInstance $configuration ([pscustomobject]@{State='Queued'})
Assert-BackgroundInputs $configuration
$configuration.ScriptHostPath=$configuration.NodePath
$hostRejected=$false
try {Assert-BackgroundInputs $configuration} catch {$hostRejected=$true}
[pscustomobject]@{Stopped=$script:stopped;HostRejected=$hostRejected} | ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { Stopped: 1, HostRejected: true });
  const target = path.join(foreign.directory, 'source.vbs');
  const wrapper = path.join(options.directory, 'start-hidden.vbs');
  await writeFile(target, 'untouched-source');
  await unlink(wrapper);
  await link(target, wrapper);
  // 同时核对真实退出类别；即使业务文字已输出，随后被超时终止也不能算门禁通过。
  await assert.rejects(powershell(configuration(options) + 'Assert-BackgroundInputs $configuration'), error => {
    assert.equal(error.cause?.code, 1);
    assert.equal(error.cause?.killed, false);
    assert.equal(error.cause?.signal, null);
    assert.match(String(error.cause?.stderr ?? ''), /后台固定文件不是普通单链接文件/);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), 'untouched-source');
});

test('运行目录父链接和固定日志硬链接均拒绝，不改变链接目标', { skip: !windows }, async t => {
  const own = await fixture(t);
  const foreign = await fixture(t);
  await mkdir(own.stateDirectory);
  const target = path.join(foreign.directory, 'untouched.txt');
  await writeFile(target, 'unchanged');
  const logPath = path.join(own.stateDirectory, 'service.log');
  await link(target, logPath);
  assert.throws(() => appendBoundedLog(own.stateDirectory, 'started'));
  await assert.rejects(powershell(configuration({ ...own, port: await freePort() }) + 'Assert-BackgroundRuntimePaths $configuration'), /后台固定文件不是普通单链接文件/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  await unlink(logPath);
  const parentLink = path.join(own.directory, 'linked-parent');
  await symlink(foreign.directory, parentLink, 'junction');
  try {
    assert.throws(() => assertRuntimePaths(path.join(parentLink, 'state')));
    const options = { registryPath: own.registryPath, stateDirectory: path.join(parentLink, 'state'), port: await freePort() };
    await assert.rejects(powershell(configuration(options) + 'Assert-BackgroundRuntimePaths $configuration'), /后台运行目录或父路径是链接\/非目录/);
  } finally { await unlink(parentLink); }
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('原账户绑定及有限令牌门禁拒绝管理员、其他SID或替代Node', () => {
  const settings = { version: 1, userSid: 'S-1-5-21-1', nodePath: process.execPath };
  const identity = { userSid: settings.userSid, elevated: false };
  assert.doesNotThrow(() => assertRunIdentity(settings, identity, process.execPath));
  assert.throws(() => assertRunIdentity(settings, { ...identity, elevated: true }, process.execPath));
  assert.throws(() => assertRunIdentity(settings, { ...identity, userSid: 'S-1-5-18' }, process.execPath));
  assert.throws(() => assertRunIdentity(settings, identity, path.join(os.tmpdir(), 'another-node.exe')));
});

test('身份绑定普通文件/上限门禁拒绝硬链接和父目录链接，不读取其目标内容', async t => {
  const own = await fixture(t);
  const foreign = await fixture(t);
  const target = path.join(foreign.directory, 'source.json');
  const binding = path.join(own.directory, 'binding.json');
  await writeFile(target, 'untouched-content');
  await link(target, binding);
  assert.throws(() => assertBindingFile(binding));
  await unlink(binding);
  await writeFile(binding, 'x'.repeat(4097));
  assert.throws(() => assertBindingFile(binding));
  const parentLink = path.join(own.directory, 'binding-parent');
  await symlink(foreign.directory, parentLink, 'junction');
  try { assert.throws(() => assertBindingFile(path.join(parentLink, 'source.json'))); }
  finally { await unlink(parentLink); }
  assert.equal(await readFile(target, 'utf8'), 'untouched-content');
});

test('真实runner只监听回环，读取空夹具名单；重复启动不覆盖身份、不杀占端口实例', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const { child } = launch(t, options);
  const record = await waitFor(async () => {
    try { return JSON.parse(await readFile(path.join(options.stateDirectory, 'instance.json'), 'utf8')); } catch { return null; }
  }, child);
  assert.equal(record.pid, child.pid);
  assert.equal(record.projectRoot, runtimeProject.root);
  assert.match(record.processCreatedAt, /^\d{4}-/);
  assert.match(record.userSid, /^S-1-/);
  const before = await readFile(path.join(options.stateDirectory, 'instance.json'), 'utf8');
  assert.equal((await (await fetch(`http://127.0.0.1:${options.port}/api/health`)).json()).service, 'ok');
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${options.port}/api/projects`)).json()).projects, []);
  // 真实.NET监听表提供地址证据；另执行产品观察器核对同一随机端口，二者都不替换为模拟结果。
  const native = await powershell(observerExitReadback() + `
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:network-query-start]')
$listeners=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object {$_.Port -eq ${options.port}})
$observed=Get-FixturePortObservation -Port ${options.port}
[pscustomobject]@{LocalAddress=@($listeners | ForEach-Object {$_.Address.ToString()});Observation=$observed.Observation;ObserverAbsent=$observed.ObserverAbsent} | ConvertTo-Json -Depth 4 -Compress
[Console]::Error.WriteLine('[fresh-clone-tests:powershell:network-query-complete]')
`);
  const listener = JSON.parse(native.stdout.trim());
  assert.deepEqual(listener.LocalAddress, ['127.0.0.1']);
  assert.equal(listener.Observation.State, 'Present');
  assert.equal(listener.Observation.Reason, 'Observed');
  assert.equal(listener.Observation.ObserverExited, true);
  assert.equal(listener.ObserverAbsent, true);
  t.diagnostic(JSON.stringify({ evidence: 'real-runner-port-observer-exited', ...listener.Observation,
    observerAbsent: listener.ObserverAbsent }));
  const duplicate = launch(t, options);
  assert.equal((await once(duplicate.child, 'exit'))[0], 1);
  assert.equal(await readFile(path.join(options.stateDirectory, 'instance.json'), 'utf8'), before);
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/health`)).status, 200);
});

test('管理器通过原生创建身份核对真实runner；篡改创建时刻或完整参数后拒绝结束', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const { child } = launch(t, options);
  const recordPath = path.join(options.stateDirectory, 'instance.json');
  await waitFor(async () => { try { return JSON.parse(await readFile(recordPath, 'utf8')); } catch { return null; } }, child);
  const identify = () => powershell(configuration(options) + '$p = Get-VerifiedBackgroundProcess $configuration; if ($p) { $p.Id; $p.Dispose() } else { "not-matched" }');
  assert.equal((await identify()).stdout.trim(), String(child.pid));
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...original, processCreatedAt: '2000-01-01T00:00:00.0000000Z' }));
  assert.equal((await identify()).stdout.trim(), 'not-matched');
  await powershell(configuration(options) + 'Stop-BackgroundInstance $configuration $null');
  assert.equal(child.exitCode, null);
  await writeFile(recordPath, JSON.stringify({ ...original, port: options.port + 1 }));
  // 端口篡改须触发记录归属门禁；PowerShell启动失败或超时不是预期的产品拒绝。
  await assert.rejects(identify(), error => {
    assert.equal(error.cause?.code, 1);
    assert.equal(error.cause?.killed, false);
    assert.equal(error.cause?.signal, null);
    assert.match(String(error.cause?.stderr ?? ''), /运行身份记录不属于当前看板配置，拒绝操作进程。/);
    return true;
  });
  assert.equal(child.exitCode, null);
  await writeFile(recordPath, JSON.stringify(original));
  await powershell(configuration(options) + 'Stop-BackgroundInstance $configuration $null');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, undefined, 5000);
});

test('管理Start普通用户隐藏启动且可重复调用，Stop只结束匹配夹具实例', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  options.cleanupBeforeRemove.push(async () => {
    await powershell(configuration(options) + 'Stop-BackgroundInstance $configuration $null');
    const stopped = JSON.parse((await powershell(configuration(options) + 'Get-BackgroundStatus $configuration | ConvertTo-Json -Compress')).stdout.trim());
    assert.equal(stopped.ManagedProcessId, null, '清理后仍有可核对的测试实例。');
    assert.equal(stopped.Healthy, false, '清理后测试端口仍提供健康服务。');
  });
  const start = () => powershell(configuration(options) + 'Start-BackgroundInstance $configuration | ConvertTo-Json -Compress', { allowPreview: true });
  const first = JSON.parse((await start()).stdout.trim());
  assert.equal(first.Installed, false);
  assert.equal(first.Healthy, true);
  assert.equal(first.LimitedTokenVerified, true);
  assert.equal(first.InteractiveSessionVerified, true);
  assert.equal(first.NonInteractiveSessionVerified, false);
  const second = JSON.parse((await start()).stdout.trim());
  assert.equal(second.ManagedProcessId, first.ManagedProcessId);
  await powershell(configuration(options) + 'Stop-BackgroundInstance $configuration $null');
  const status = await powershell(configuration(options) + 'Get-BackgroundStatus $configuration | ConvertTo-Json -Compress');
  assert.equal(JSON.parse(status.stdout.trim()).Healthy, false);
});

test('进程被停止后的旧记录可安全重启，不靠删除锁或终止未知进程恢复', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const first = launch(t, options);
  const recordPath = path.join(options.stateDirectory, 'instance.json');
  const previous = await waitFor(async () => { try { return JSON.parse(await readFile(recordPath, 'utf8')); } catch { return null; } }, first.child);
  first.child.kill();
  await once(first.child, 'exit');
  const second = launch(t, options);
  const current = await waitFor(async () => {
    try { const value = JSON.parse(await readFile(recordPath, 'utf8')); return value.pid === second.child.pid ? value : null; } catch { return null; }
  }, second.child);
  assert.notEqual(current.instanceId, previous.instanceId);
  assert.equal((await fetch(`http://127.0.0.1:${options.port}/api/health`)).status, 200);
});

for (const temporary of [true, false]) {
  test(`真实runner旧记录只读句柄${temporary ? '短暂占用释放后重启成功' : '持续占用时有界失败并保留旧记录'}`, { skip: !windows }, async t => {
    const options = { ...await fixture(t), port: await freePort() };
    const recordPath = path.join(options.stateDirectory, 'instance.json');
    const first = launch(t, options);
    await waitForRunnerHealth(options, first.child);
    const previousBytes = await readFile(recordPath);
    const previous = JSON.parse(previousBytes);
    assert.equal(previous.pid, first.child.pid);
    const firstExited = once(first.child, 'exit');
    assert.equal(first.child.kill(), true);
    await firstExited;
    assert.deepEqual(await readFile(recordPath), previousBytes);
    let reader = await open(recordPath, 'r');
    try {
      const second = launch(t, options);
      if (temporary) {
        const waiting = await waitForOwnedTemporaryRecord(options, second.child);
        // 临时记录出现后再持有100ms，并核对它仍存在，证明实际走过被读句柄阻塞的替换阶段。
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(second.child.exitCode, null);
        assert.equal(second.child.signalCode, null);
        assert.equal(JSON.parse(await readFile(waiting.filename, 'utf8')).pid, second.child.pid);
        assert.deepEqual(await readFile(recordPath), previousBytes);
        await reader.close();
        reader = undefined;
        const current = await waitFor(async () => {
          const value = JSON.parse(await readFile(recordPath, 'utf8'));
          return value.pid === second.child.pid ? value : null;
        }, second.child);
        await waitForRunnerHealth(options, second.child);
        assert.equal(current.pid, second.child.pid);
        assert.notEqual(current.pid, previous.pid);
        assert.notEqual(current.instanceId, previous.instanceId);
        await assert.rejects(stat(waiting.filename), { code: 'ENOENT' });
        t.diagnostic(JSON.stringify({ evidence: 'real-runner-transient-reader-recovered', previousPid: previous.pid,
          currentPid: current.pid, temporaryObserved: true, heldAfterObservationMilliseconds: 100 }));
      } else {
        // 使用原有15秒外部等待，不靠扩大启动期限使持续占用通过；失败必须来自产品正常退出。
        await waitFor(() => second.child.exitCode !== null || second.child.signalCode !== null);
        assert.equal(second.child.exitCode, 1);
        assert.equal(second.child.signalCode, null);
        const diagnostic = JSON.parse(await readFile(path.join(options.stateDirectory, 'startup-failure.json'), 'utf8'));
        assert.equal(diagnostic.pid, second.child.pid);
        assert.equal(diagnostic.stage, 'record_write');
        assert.equal(diagnostic.category, 'access_denied');
        assert.deepEqual(await readFile(recordPath), previousBytes);
        assert.deepEqual((await readdir(options.stateDirectory)).filter(name => /^instance-.*\.tmp$/.test(name)), []);
        t.diagnostic(JSON.stringify({ evidence: 'real-runner-persistent-reader-rejected', ...diagnostic, exitCode: second.child.exitCode }));
      }
    } finally { if (reader) await reader.close(); }
  });
}

test('记录替换遇持续真实读句柄在1000ms预算后保留原rename错误，不删除旧记录', { skip: !windows, timeout: 15_000 }, async t => {
  const options = await recordReplacementFixture(t);
  const reader = openSync(options.recordPath, 'r');
  const started = performance.now();
  let replacement;
  try {
    replacement = replaceInstanceRecord(options.stateDirectory, options.record, options.previous);
    // 先安装拒绝观察者；后续夹具断言若失败，finally仍等待产品操作收尾，不能留下未处理Promise。
    replacement.catch(() => {});
    // 调用返回前已执行首次真实rename；未成功的完整临时记录使该测试不会把初始化失败当成重试证据。
    assert.equal(JSON.parse(readFileSync(options.temporaryPath, 'utf8')).instanceId, options.record.instanceId);
    await assert.rejects(replacement, error => {
      assert.ok(['EPERM', 'EACCES'].includes(error.code));
      assert.equal(error.syscall, 'rename');
      return true;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1000 && elapsed < 15_000, `记录替换未遵守1000ms产品预算与15秒外部边界：${elapsed}ms`);
    assert.deepEqual(await readFile(options.recordPath), options.previousBytes);
    await assert.rejects(stat(options.temporaryPath), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ evidence: 'record-replacement-persistent-reader-bounded', elapsedMilliseconds: elapsed,
      originalRenameError: true, oldRecordPreserved: true, ownedTemporaryRemoved: true }));
  } finally { closeSync(reader); if (replacement) await replacement.catch(() => {}); }
});

for (const change of ['target-content', 'target-identity', 'temporary-content', 'temporary-identity']) {
  test(`记录替换等待期间${change}变化明确拒绝，保留变化后的文件`, { skip: !windows, timeout: 15_000 }, async t => {
    const options = await recordReplacementFixture(t);
    let reader = openSync(options.recordPath, 'r');
    let replacement;
    try {
      replacement = replaceInstanceRecord(options.stateDirectory, options.record, options.previous);
      replacement.catch(() => {});
      const temporaryBefore = readFileSync(options.temporaryPath);
      const changedPath = change.startsWith('target-') ? options.recordPath : options.temporaryPath;
      const originalBytes = readFileSync(changedPath);
      const originalIdentity = lstatSync(changedPath, { bigint: true });
      let expectedBytes = originalBytes;
      let relocated;
      // 所有变化都发生在首次await返回的同一个JavaScript轮次；50ms重试尚不能执行，不依赖抢占概率。
      if (change.endsWith('-identity')) {
        if (change.startsWith('target-')) { closeSync(reader); reader = undefined; }
        relocated = path.join(options.stateDirectory, `${change}-original.json`);
        renameSync(changedPath, relocated);
        writeFileSync(changedPath, originalBytes, { flag: 'wx' });
        assert.notEqual(lstatSync(changedPath, { bigint: true }).ino, originalIdentity.ino);
      } else {
        const value = JSON.parse(originalBytes);
        expectedBytes = Buffer.from(`${JSON.stringify({ ...value, instanceId: randomUUID() }, null, 2)}\n`);
        assert.equal(expectedBytes.length, originalBytes.length);
        writeFileSync(changedPath, expectedBytes);
        assert.equal(lstatSync(changedPath, { bigint: true }).ino, originalIdentity.ino);
      }
      await assert.rejects(replacement, { message: 'BACKGROUND_RECORD_INVALID' });
      assert.deepEqual(await readFile(changedPath), expectedBytes, '未知变化后的文件不得被替换或清理。');
      if (relocated) assert.deepEqual(await readFile(relocated), originalBytes);
      if (change.startsWith('target-')) {
        await assert.rejects(stat(options.temporaryPath), { code: 'ENOENT' });
      } else {
        assert.deepEqual(await readFile(options.recordPath), options.previousBytes);
        if (relocated) assert.deepEqual(await readFile(relocated), temporaryBefore);
      }
    } finally {
      if (reader !== undefined) closeSync(reader);
      if (replacement) await replacement.catch(() => {});
    }
  });
}

test('记录替换以wx拒绝预存临时文件，不覆盖或删除其内容', { skip: !windows, timeout: 15_000 }, async t => {
  const options = await recordReplacementFixture(t);
  const foreignBytes = Buffer.from('fixture-preexisting-temporary-content');
  await writeFile(options.temporaryPath, foreignBytes, { flag: 'wx' });
  await assert.rejects(replaceInstanceRecord(options.stateDirectory, options.record, options.previous), { code: 'EEXIST' });
  assert.deepEqual(await readFile(options.temporaryPath), foreignBytes);
  assert.deepEqual(await readFile(options.recordPath), options.previousBytes);
});

test('记录替换等待期间同名普通目录身份改变即拒绝，不删除新目录中的未知临时文件', { skip: !windows, timeout: 15_000 }, async t => {
  const options = await recordReplacementFixture(t);
  let reader = openSync(options.recordPath, 'r');
  let replacement;
  try {
    replacement = replaceInstanceRecord(options.stateDirectory, options.record, options.previous);
    replacement.catch(() => {});
    const temporaryBytes = readFileSync(options.temporaryPath);
    const originalIdentity = lstatSync(options.stateDirectory, { bigint: true });
    const relocated = path.join(options.directory, 'state-original');
    // 同一JavaScript轮次先关闭目标读句柄再换目录，原产品重试仍未恢复；普通目录也不能只按路径信任。
    closeSync(reader);
    reader = undefined;
    renameSync(options.stateDirectory, relocated);
    mkdirSync(options.stateDirectory);
    writeFileSync(options.recordPath, options.previousBytes, { flag: 'wx' });
    writeFileSync(options.temporaryPath, temporaryBytes, { flag: 'wx' });
    assert.notEqual(lstatSync(options.stateDirectory, { bigint: true }).ino, originalIdentity.ino);
    await assert.rejects(replacement, { message: 'BACKGROUND_STATE_LINK' });
    assert.deepEqual(await readFile(options.recordPath), options.previousBytes);
    assert.deepEqual(await readFile(options.temporaryPath), temporaryBytes, '换入目录的未知临时文件必须保留。');
    assert.deepEqual(await readFile(path.join(relocated, 'instance.json')), options.previousBytes);
    assert.deepEqual(await readFile(path.join(relocated, path.basename(options.temporaryPath))), temporaryBytes);
  } finally {
    if (reader !== undefined) closeSync(reader);
    if (replacement) await replacement.catch(() => {});
  }
});

test('不属于看板的端口监听不会被管理Start关闭，未知运行记录不会被覆盖', { skip: !windows }, async t => {
  const options = { ...await fixture(t), port: await freePort() };
  const foreign = net.createServer();
  await new Promise(resolve => foreign.listen(options.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await assert.rejects(powershell(configuration(options) + 'Start-BackgroundInstance $configuration'), /看板端口被其他或未核对进程占用/);
  assert.equal(foreign.listening, true);
  await mkdir(options.stateDirectory);
  const recordPath = path.join(options.stateDirectory, 'instance.json');
  await writeFile(recordPath, '{"owner":"foreign"}');
  const unknown = launch(t, options);
  assert.equal((await once(unknown.child, 'exit'))[0], 1);
  // 退出码不足以证明未知记录门禁：必须已通过身份绑定并在读取记录阶段因精确类别拒绝。
  const diagnostic = JSON.parse(await readFile(path.join(options.stateDirectory, 'startup-failure.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'record_read');
  assert.equal(diagnostic.category, 'BACKGROUND_RECORD_INVALID');
  assert.equal(await readFile(recordPath, 'utf8'), '{"owner":"foreign"}');
  assert.equal(foreign.listening, true);
});
