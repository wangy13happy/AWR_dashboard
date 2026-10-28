import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';

export const NATIVE_COMPILER = 'C:\\MinGW\\bin\\gcc.exe';
export const NATIVE_OBJDUMP = 'C:\\MinGW\\bin\\objdump.exe';
export const NATIVE_POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execute = promisify(execFile);
let identityPromise;
let compilerTargetPromise;
// 只查询当前子进程的主令牌完整性；不导入生产管理器，不创建/查询作业或读取其它进程令牌。
const IDENTITY_QUERY = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NativeFixtureToken {
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int size, out int returned);
  [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  /// <summary>Read the current process token's integrity RID and always release the owned handle and buffer.</summary>
  public static int IntegrityRid() {
    IntPtr token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int size;
      bool first = GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
      int error = Marshal.GetLastWin32Error();
      if (first || error != 122 || size <= 0) throw new Win32Exception(error);
      buffer = Marshal.AllocHGlobal(size);
      if (!GetTokenInformation(token, 25, buffer, size, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      if (count == 0) throw new InvalidOperationException("Empty integrity SID");
      return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }
}
'@
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
[pscustomobject]@{userSid=$identity.User.Value;elevated=$principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator);
  integrityRid=[NativeFixtureToken]::IntegrityRid();
  commonData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData);
  systemX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::SystemX86)} | ConvertTo-Json -Compress
`;

/** 移除仅影响旧版PowerShell模块发现的继承项；不修改当前进程或系统的持久环境。 */
export function nativePowerShellEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.toLowerCase() === 'psmodulepath') delete environment[name];
  return environment;
}

/** 只把明确缺失、非文件或链接形式识别为工具条件不足；权限及其它读取错误仍然使测试失败。 */
async function missingToolReason(filename) {
  try {
    const item = await lstat(filename);
    return item.isFile() && !item.isSymbolicLink() ? null : `需要普通工具文件：${filename}`;
  } catch (error) {
    if (error.code === 'ENOENT') return `缺少测试工具：${filename}`;
    throw error;
  }
}

/** 仅查询当前公开身份和系统目录，不导入管理器、不访问配置、调度器或后台进程。 */
async function currentIdentity() {
  identityPromise ??= execute(NATIVE_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', IDENTITY_QUERY],
  { windowsHide: true, env: nativePowerShellEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 })
    .then(result => {
      const identity = JSON.parse(result.stdout.trim());
      assert.match(identity.userSid, /^S-1-/);
      assert.equal(typeof identity.elevated, 'boolean');
      assert.ok(Number.isInteger(identity.integrityRid));
      return identity;
    });
  return identityPromise;
}

/** 查询固定编译器实际目标；存在工具的执行失败不能包装成缺能力或跳过。 */
async function compilerTarget() {
  compilerTargetPromise ??= execute(NATIVE_COMPILER, ['-dumpmachine'],
    { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 })
    .then(result => {
      const target = result.stdout.trim();
      assert.match(target, /^[A-Za-z0-9_-]+$/, '编译器目标探测必须返回一个有效目标名称');
      return target;
    });
  return compilerTargetPromise;
}

/** 按用例检查明确先决条件；第二参数仅供隔离单元验证注入探测，不读取强制跳过环境开关。 */
export async function nativeSkipReason({ powerShell = false, toolchain = false, builder = false, jobs = false } = {},
  { platform = process.platform, architecture = process.arch, release = os.release(),
    toolReason = missingToolReason, identity = currentIdentity, target = compilerTarget } = {}) {
  if (platform !== 'win32') return '此用例需要Windows原生接口';
  if (jobs && architecture !== 'x64') return `此作业用例要求64位Node.js，当前为${architecture}`;
  if (jobs && Number.parseInt(release.split('.')[0], 10) < 10) {
    return `创建时作业列表需要Windows 10/Server 2016及以上，当前版本${release}`;
  }
  if (powerShell || builder || jobs) {
    const missing = await toolReason(NATIVE_POWERSHELL);
    // 真实条件是中等完整性且管理员角色未启用；PowerShell只是本夹具的只读核验工具，缺它不代表系统不支持作业。
    if (missing) return jobs ? `无法核验真实作业普通权限：${missing}` : missing;
    const current = await identity();
    if (current.elevated) return '此原生夹具要求当前普通权限账户；实际管理员角色已启用';
    if (jobs && current.integrityRid !== 8192) {
      return `真实作业夹具要求中等完整性令牌，当前完整性RID为${current.integrityRid}`;
    }
    if (builder && (current.commonData.toLowerCase() !== 'c:\\programdata'
      || current.systemX86.toLowerCase() !== 'c:\\windows\\syswow64')) {
      return `固定构建器需要C盘系统目录；当前公共目录${current.commonData}、32位系统目录${current.systemX86}`;
    }
  }
  if (toolchain || builder) {
    const missing = await toolReason(NATIVE_COMPILER);
    if (missing) return missing;
    const machine = await target();
    if (machine !== 'mingw32') return `此夹具要求mingw32工具链，当前目标为${machine}`;
  }
  if (builder) {
    const missing = await toolReason(NATIVE_OBJDUMP);
    if (missing) return missing;
  }
  return null;
}

/** 由受版本控制的示例生成临时项目自己的绑定；禁止读取正式绑定或把输出写入原项目。 */
export async function writeNativeFixtureBinding(sourceRoot, temporaryRoot, projectRoot) {
  const relative = path.relative(path.resolve(temporaryRoot), path.resolve(projectRoot));
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  assert.notEqual(path.resolve(sourceRoot).toLowerCase(), path.resolve(projectRoot).toLowerCase());
  const example = JSON.parse(await readFile(path.join(sourceRoot, 'ops', 'background-settings.example.json'), 'utf8'));
  assert.equal(example.version, 1);
  assert.deepEqual(Object.keys(example).sort(), ['nodePath', 'userSid', 'version']);
  const identity = await currentIdentity();
  // SID是当前账户的公开身份标识；示例只补这两个必要字段，不读取、复制或保存任何凭据。
  const binding = { ...example, userSid: identity.userSid, nodePath: await realpath(process.execPath) };
  await writeFile(path.join(projectRoot, 'ops', 'background-settings.json'),
    `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' });
  return binding;
}
