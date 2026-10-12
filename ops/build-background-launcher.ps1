<#!
.SYNOPSIS
仅以普通权限构建本机固定绑定启动器；不接收命令、路径或账户覆盖，不操作真实计划任务。
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LauncherBuildLimited {
  <# 任何工作区脚本/编译器执行前拒绝管理员令牌；安装只复制已核验的冻结产物。 #>
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw '原生启动器只能以普通用户权限构建；未运行编译器或修改任务。'
  }
}

function ConvertTo-LauncherWideConstant {
  <# 按UTF-16代码单元生成固定宽字符数组，路径中的引号/反斜杠不能变成C源码。 #>
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
  if ($Name -notmatch '^AWR_[A-Z_]+$' -or $Value.Length -eq 0 -or $Value.IndexOf([char]0) -ge 0) {
    throw '编译绑定名称或内容无效，拒绝生成头文件。'
  }
  $units = @($Value.ToCharArray() | ForEach-Object { '0x{0:X4}' -f [int]$_ })
  return ('static const wchar_t {0}[] = {{ {1}, 0 }};' -f $Name,($units -join ', '))
}

function Write-LauncherBuildText {
  <# 仅写本次固定构建目录内的普通产物；拒绝父目录、目标链接与目录替代。 #>
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$BuildDirectory)
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path)) -ine $BuildDirectory) { throw '构建写入越界。' }
  Assert-BackgroundDirectoryChain $BuildDirectory
  if (Test-Path -LiteralPath $Path) { Assert-BackgroundPlainFile $Path }
  [IO.File]::WriteAllText($Path,$Value,[Text.UTF8Encoding]::new($false))
}

function Assert-LauncherImports {
  <# 读取而不执行产物；只允许本机已核验的系统KnownDLLs，延迟导入和外部运行库均拒绝。 #>
  param([Parameter(Mandatory)][string]$Artifact, [Parameter(Mandatory)][string]$Objdump)
  $lines = @(& $Objdump '-p' $Artifact 2>&1)
  if ($LASTEXITCODE -ne 0) { throw '读取启动器导入表失败，产物未冻结。' }
  $dump = ($lines | ForEach-Object { [string]$_ }) -join "`n"
  if ($dump -notmatch '(?m)^Magic\s+010b\s+\(PE32\)\s*$') { throw '启动器不是预期的32位PE32产物。' }
  $delay = [Regex]::Match($dump,'(?m)^Entry d\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+Delay Import Directory\s*$')
  if (-not $delay.Success -or $delay.Groups[1].Value -notmatch '^0+$' -or $delay.Groups[2].Value -notmatch '^0+$') {
    throw '启动器包含延迟导入或无法核对延迟导入目录，未冻结。'
  }
  $names = @([Regex]::Matches($dump,'(?m)^\s*DLL Name:\s*(\S+)\s*$') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } | Sort-Object -Unique)
  if ($names.Count -eq 0) { throw '启动器导入表为空或格式未知。' }
  $known = Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\KnownDLLs'
  $systemX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::SystemX86)
  if ($systemX86 -ine 'C:\Windows\SysWOW64') { throw '本机32位系统库目录与已核对设计不一致。' }
  foreach ($name in $names) {
    if ($name -notin @('kernel32.dll','advapi32.dll','msvcrt.dll')) { throw ('启动器存在未允许导入：' + $name) }
    $match = @($known.PSObject.Properties | Where-Object { [string]$_.Value -ieq $name })
    if ($match.Count -eq 0) { throw '启动器导入未在本机KnownDLLs中确认。' }
    $systemFile = Join-Path $systemX86 $name
    Assert-BackgroundDirectoryChain $systemX86
    # 系统KnownDLLs本机均有WinSxS硬链接；这不属于用户可替换安装产物。
    # 此处只确认系统目录的普通非重解析文件，不能套用产品文件单链接规则。
    $systemItem = Get-Item -LiteralPath $systemFile -Force
    if ($systemItem.PSIsContainer -or ($systemItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw '系统已知库目标不是普通非重解析文件。'
    }
  }
  return [pscustomobject]@{ Dump=$dump; Names=$names; Architecture='PE32 / mingw32' }
}

function Invoke-LauncherBuild {
  <# 固定输入、普通编译、导入审核和源码清单构成一份本机收据；从不安装或运行产物。 #>
  Assert-LauncherBuildLimited
  . (Join-Path $PSScriptRoot 'manage-background.ps1')
  $configuration = Get-BackgroundConfiguration
  Assert-BackgroundInputs $configuration
  $commonData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  if ($commonData -ine 'C:\ProgramData' -or $configuration.ProtectDirectory -ine 'C:\ProgramData\AWR_dashboard-a5cfe275da31') {
    throw '系统公共应用数据目录与固定保护位置不一致。'
  }
  $buildDirectory = [IO.Path]::GetFullPath($configuration.BuildDirectory)
  if ($buildDirectory -ine (Join-Path $configuration.ProjectRoot 'run\background-launcher-build')) { throw '构建目录不是本项目固定目录。' }
  Assert-BackgroundDirectoryChain $buildDirectory
  $source = Join-Path $PSScriptRoot 'native\background-launcher.c'
  Assert-BackgroundDirectoryChain (Split-Path -Parent $source)
  Assert-BackgroundPlainFile $source
  $gcc = 'C:\MinGW\bin\gcc.exe'
  $objdump = 'C:\MinGW\bin\objdump.exe'
  foreach ($tool in @($gcc,$objdump)) { Assert-BackgroundDirectoryChain (Split-Path -Parent $tool); Assert-BackgroundPlainFile $tool }
  $machine = @(& $gcc '-dumpmachine' 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($machine -join '').Trim() -cne 'mingw32') { throw '本机编译器不是已核对的mingw32工具。' }
  $null = [IO.Directory]::CreateDirectory($buildDirectory)
  Assert-BackgroundDirectoryChain $buildDirectory
  # 所有写入名称固定且必须是普通文件。目录有未知文件时拒绝，不删除或接管它们。
  $allowed = @('background-binding.h','background-launcher.exe','background-launcher.pending.exe','build-receipt.json','source-manifest.json','objdump-imports.txt')
  foreach ($item in @(Get-ChildItem -LiteralPath $buildDirectory -Force)) {
    if ($item.Name -notin $allowed) { throw '固定构建目录含未知文件，未覆盖或清理。' }
    Assert-BackgroundPlainFile $item.FullName
  }
  $header = Join-Path $buildDirectory 'background-binding.h'
  $artifact = Join-Path $buildDirectory 'background-launcher.exe'
  $pending = Join-Path $buildDirectory 'background-launcher.pending.exe'
  $receiptPath = Join-Path $buildDirectory 'build-receipt.json'
  $manifestPath = Join-Path $buildDirectory 'source-manifest.json'
  # 本账户已知本地应用数据目录由系统解析，不接受TEMP/TMP继承变量选择父进程环境。
  $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if (-not [IO.Path]::IsPathRooted($localData)) { throw '本账户本地应用数据目录无法核对。' }
  $temporary = Join-Path $localData 'Temp'
  Assert-BackgroundDirectoryChain $temporary
  $arguments = @('--no-warnings',$configuration.RunnerPath,'--port',[string]$configuration.Port,'--projects',$configuration.RegistryPath,'--state-directory',$configuration.StateDirectory)
  $bindings = [ordered]@{
    AWR_USER_SID=$configuration.UserSid
    AWR_PROJECT_ROOT=$configuration.ProjectRoot
    AWR_NODE_PATH=$configuration.NodePath
    AWR_RUNNER_PATH=$configuration.RunnerPath
    AWR_REGISTRY_PATH=$configuration.RegistryPath
    AWR_STATE_DIRECTORY=$configuration.StateDirectory
    AWR_LAUNCHER_PATH=$configuration.LauncherPath
    AWR_TEMP_DIRECTORY=$temporary
    AWR_COMMAND_LINE=('"' + $configuration.NodePath + '" ' + (Get-BackgroundArguments $configuration))
  }
  $headerLines = @('/* Generated ordinary-user fixed binding; not an elevated command/configuration interface. */','#ifndef AWR_BACKGROUND_BINDING_H','#define AWR_BACKGROUND_BINDING_H','#include <wchar.h>','#define AWR_PORT 4317')
  foreach ($entry in $bindings.GetEnumerator()) { $headerLines += ConvertTo-LauncherWideConstant $entry.Key ([string]$entry.Value) }
  $headerLines += '#endif'
  Write-LauncherBuildText $header (($headerLines -join "`n") + "`n") $buildDirectory
  $manifestFiles = @(
    [pscustomobject]@{path='ops/build-background-launcher.ps1'; absolute=$PSCommandPath},
    [pscustomobject]@{path='ops/manage-background.ps1'; absolute=(Join-Path $PSScriptRoot 'manage-background.ps1')},
    [pscustomobject]@{path='ops/native/background-launcher.c'; absolute=$source},
    [pscustomobject]@{path='run/background-launcher-build/background-binding.h'; absolute=$header}
  ) | Sort-Object path
  # 先冻结编译输入的四项散列，再运行编译器。编译后必须逐项重读；
  # 不能把恰好在编译期间修改过的后版本源码记成这份产物的编译依据。
  $manifest = @($manifestFiles | ForEach-Object {
    Assert-BackgroundPlainFile $_.absolute
    [ordered]@{ path=$_.path; sha256=(Get-FileHash -LiteralPath $_.absolute -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  # 编译仅产生暂存产物；不执行它。失败保留现场，旧收据不能证明失败的新构建成功。
  $compileArguments = @('-std=c11','-Wall','-Wextra','-Werror','-O2','-static-libgcc','-s','-I',$buildDirectory,$source,'-o',$pending,'-ladvapi32')
  $compileOutput = @(& $gcc @compileArguments 2>&1)
  if ($LASTEXITCODE -ne 0) { throw ('普通权限编译失败，未安装或运行产物：' + ($compileOutput -join "`n")) }
  Assert-BackgroundPlainFile $pending
  $imports = Assert-LauncherImports $pending $objdump
  for ($index=0; $index -lt $manifestFiles.Count; $index++) {
    Assert-BackgroundPlainFile $manifestFiles[$index].absolute
    $afterHash=(Get-FileHash -LiteralPath $manifestFiles[$index].absolute -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($afterHash -cne $manifest[$index].sha256) { throw '编译期间固定源码/绑定发生变化；保留暂存产物，不发布或冻结收据。' }
  }
  Write-LauncherBuildText $manifestPath (($manifest | ConvertTo-Json -Depth 4) + "`n") $buildDirectory
  Write-LauncherBuildText (Join-Path $buildDirectory 'objdump-imports.txt') ($imports.Dump + "`n") $buildDirectory
  $sha = (Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant()
  # Windows PowerShell会把普通$null传给字符串参数时转为空串；用真正空字符串引用
  # 表示“不另建备份”，保持Replace的同目录发布语义，不以先删除旧产物绕过错误。
  if (Test-Path -LiteralPath $artifact) { Assert-BackgroundPlainFile $artifact; [IO.File]::Replace($pending,$artifact,[NullString]::Value) }
  else { [IO.File]::Move($pending,$artifact) }
  if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw '最终构建产物散列不一致。' }
  $receipt = [ordered]@{
    version=1; owner=$configuration.Owner; projectRoot=$configuration.ProjectRoot; userSid=$configuration.UserSid
    nodePath=$configuration.NodePath; runnerPath=$configuration.RunnerPath; registryPath=$configuration.RegistryPath
    stateDirectory=$configuration.StateDirectory; port=$configuration.Port; nodeArguments=$arguments
    launcherPath=$configuration.LauncherPath; launcherSha256=$sha
    sourceManifestSha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    builtAt=[DateTimeOffset]::UtcNow.ToString('o'); compiler=$gcc; architecture=$imports.Architecture; imports=$imports.Names
  }
  Write-LauncherBuildText $receiptPath (($receipt | ConvertTo-Json -Depth 5) + "`n") $buildDirectory
  return [pscustomobject]$receipt
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-LauncherBuild | ConvertTo-Json -Depth 5 }
  catch { Write-Error $_.Exception.Message; exit 1 }
}
