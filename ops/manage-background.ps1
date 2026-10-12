<#!
.SYNOPSIS
仅管理本项目的Windows后台看板与当前用户登录计划任务，不保存凭据、不自行提升权限。
#>
[CmdletBinding()]
param(
  [ValidateSet('Prepare', 'Install', 'Start', 'Stop', 'Status', 'Disable', 'Enable', 'Uninstall')]
  [string]$Action = 'Status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-BackgroundAdministrator {
  <# 在安装的第一步验证当前进程确实已提升；未提升时不创建目录、启动进程或注册任务。 #>
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw '本看板专属任务安装需要当前用户管理员权限；当前未提升，未修改启动项。请由当前用户以管理员身份运行Install；本脚本不会自行提升。'
  }
}

function Get-BackgroundConfiguration {
  <# 固定项目根、安装期Node与原用户SID；输入缺失不能使Status/停用/卸载失去安全控制能力。 #>
  $projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
  $settingsPath = Join-Path $PSScriptRoot 'background-settings.json'
  Assert-BackgroundDirectoryChain (Split-Path -Parent $settingsPath)
  Assert-BackgroundPlainFile $settingsPath
  if ((Get-Item -LiteralPath $settingsPath).Length -gt 4096) { throw '后台身份绑定配置过大，拒绝操作。' }
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($settings.version -ne 1 -or $settings.userSid -ne $currentSid -or -not [IO.Path]::IsPathRooted($settings.nodePath)) {
    throw '实际用户与本机预检绑定的用户SID不一致或配置无效；不能用其他管理员账户替代运行身份。'
  }
  $configuration = [pscustomobject]@{
    TaskName = 'AWR_Dashboard_Background'
    TaskPath = '\'
    ProjectRoot = $projectRoot
    NodePath = [IO.Path]::GetFullPath($settings.nodePath)
    RunnerPath = Join-Path $projectRoot 'bin\background-runner.mjs'
    RegistryPath = Join-Path $projectRoot 'config\projects.json'
    ScriptHostPath = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe'
    HiddenRunnerPath = Join-Path $projectRoot 'ops\start-background-hidden.vbs'
    StateDirectory = Join-Path $projectRoot 'run\background'
    ProtectDirectory = 'C:\ProgramData\AWR_dashboard-a5cfe275da31'
    LauncherPath = 'C:\ProgramData\AWR_dashboard-a5cfe275da31\background-launcher.exe'
    BuildDirectory = Join-Path $projectRoot 'run\background-launcher-build'
    ReceiptPath = 'C:\ProgramData\AWR_dashboard-a5cfe275da31\install-receipt.json'
    Port = 4317
    UserSid = $settings.userSid
    Owner = 'awr-dashboard-background-v1'
  }
  return $configuration
}

function Assert-BackgroundInputs {
  <# 只在安装和启动核对固定输入存在；不影响失联环境中的状态查看、停止或卸载。 #>
  param([Parameter(Mandatory)]$Configuration)
  foreach ($filePath in @($Configuration.NodePath, $Configuration.RunnerPath, $Configuration.RegistryPath,$Configuration.ScriptHostPath,$Configuration.HiddenRunnerPath)) {
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw '本看板Node、入口或登记清单缺失，未启动或修改启动项。' }
  }
  Assert-BackgroundDirectoryChain (Split-Path -Parent $Configuration.HiddenRunnerPath)
  Assert-BackgroundPlainFile $Configuration.HiddenRunnerPath
  Assert-BackgroundDirectoryChain (Split-Path -Parent $Configuration.ScriptHostPath)
  # 固定Windows系统宿主通常是组件库硬链接；仅它允许系统硬链接，项目脚本及运行文件仍单链接。
  $fixedHost = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe'
  $hostItem = Get-Item -LiteralPath $Configuration.ScriptHostPath -Force
  if ($Configuration.ScriptHostPath -ine $fixedHost -or $hostItem.PSIsContainer -or
    ($hostItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '固定Windows脚本宿主无效，拒绝启动或注册。' }
}

function Assert-BackgroundRuntimePaths {
  <# 在读写/启动前拒绝运行目录各级父路径和固定运行文件的重解析链接，不能借run转写其他项目。 #>
  param([Parameter(Mandatory)]$Configuration)
  Assert-BackgroundDirectoryChain $Configuration.StateDirectory
  foreach ($name in @('service.log','service.log.1','instance.json','task-definition-before-login.xml')) {
    $filePath = Join-Path $Configuration.StateDirectory $name
    if (Test-Path -LiteralPath $filePath) { Assert-BackgroundPlainFile $filePath }
  }
}

function Assert-BackgroundDirectoryChain {
  <# 只核对已知目录链元数据，拒绝父目录链接；不遍历全盘、不读取任何外来文件正文。 #>
  param([Parameter(Mandatory)][string]$Directory)
  $pathToCheck = [IO.Path]::GetFullPath($Directory)
  while ($pathToCheck) {
    if (Test-Path -LiteralPath $pathToCheck) {
      $item = Get-Item -LiteralPath $pathToCheck -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '后台运行目录或父路径是链接/非目录，拒绝读写。' }
    }
    $parent = Split-Path -Parent $pathToCheck
    if ($parent -eq $pathToCheck) { break }
    $pathToCheck = $parent
  }
}

function Assert-BackgroundPlainFile {
  <# 固定配置/运行文件必须是普通单链接文件，不能跟随符号链接、目录或借硬链接读取其他项目。 #>
  param([Parameter(Mandatory)][string]$FilePath)
  $item = Get-Item -LiteralPath $FilePath -Force
  $linkProperty = $item.PSObject.Properties['LinkType']
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($linkProperty -and $linkProperty.Value -eq 'HardLink')) { throw '后台固定文件不是普通单链接文件，拒绝读写。' }
}

function Assert-BackgroundLimited {
  <# 没有计划任务时只能由有限权限账户启动预览；管理员不能直接运行用户可写服务。 #>
  if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw '隐藏预览必须以普通用户权限启动；管理员只执行Install，由有限权限计划任务运行服务。'
  }
}

function Get-BackgroundArguments {
  <# 所有路径均作为带引号的独立Node参数传递，不拼接可执行的shell命令。 #>
  param([Parameter(Mandatory)]$Configuration)
  return ('--no-warnings "{0}" --port {1} --projects "{2}" --state-directory "{3}"' -f
    $Configuration.RunnerPath, $Configuration.Port, $Configuration.RegistryPath, $Configuration.StateDirectory)
}

function Get-BackgroundHiddenArguments {
  <# 固定系统宿主只接收本项目隐藏包装及绑定Node；包装等待Node退出，不添加监督循环或覆盖参数。 #>
  param([Parameter(Mandatory)]$Configuration)
  return ('//B //Nologo "{0}" "{1}"' -f $Configuration.HiddenRunnerPath,$Configuration.NodePath)
}

function Get-BackgroundCommandPattern {
  <# 精确匹配相同有序参数的Windows原生命令行；仅容许无空格路径的等价有/无引号形式。 #>
  param([Parameter(Mandatory)]$Configuration)
  $pathToken = {
    param([string]$value)
    $escaped = [Regex]::Escape($value)
    if ($value -match '\s') { return ('"' + $escaped + '"') }
    return ('(?:"' + $escaped + '"|' + $escaped + ')')
  }
  return ('^' + (& $pathToken $Configuration.NodePath) + '\s+--no-warnings\s+' +
    (& $pathToken $Configuration.RunnerPath) + '\s+--port\s+' + $Configuration.Port + '\s+--projects\s+' +
    (& $pathToken $Configuration.RegistryPath) + '\s+--state-directory\s+' + (& $pathToken $Configuration.StateDirectory) + '\s*$')
}

function Get-BackgroundTaskXml {
  <# 仅生成原用户登录后15秒触发及无限一分钟恢复；注册初态停用，不含开机或高权限动作。 #>
  param([Parameter(Mandatory)]$Configuration)
  $escape = { param($value) [Security.SecurityElement]::Escape([string]$value) }
  $description = & $escape ($Configuration.Owner + '|root=' + $Configuration.ProjectRoot + '|sid=' + $Configuration.UserSid)
  $nodePath = & $escape $Configuration.ScriptHostPath
  $arguments = & $escape (Get-BackgroundHiddenArguments $Configuration)
  $root = & $escape $Configuration.ProjectRoot
  $sid = & $escape $Configuration.UserSid
  $startBoundary = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$description</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><Delay>PT15S</Delay><UserId>$sid</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$startBoundary</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>$nodePath</Command><Arguments>$arguments</Arguments><WorkingDirectory>$root</WorkingDirectory></Exec></Actions>
</Task>
"@
  # 仅在内存中让Windows任务定义解析器校验并规范化XML，不调用注册/运行方法。
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $definition = $scheduler.NewTask(0)
  $definition.XmlText = $xml
  return $definition.XmlText
}

function Get-BackgroundTaskDefinitionKind {
  <# 按完整动作及登录类型分类；原两种非交互定义仅保留安全控制，不能作为登录启动授权。 #>
  param([Parameter(Mandatory)]$Configuration, [Parameter(Mandatory)]$Task)
  $actions = @($Task.Actions)
  if ($actions.Count -eq 1) {
    $action = $actions[0]
    if ($action.Execute -ieq $Configuration.NodePath -and $action.Arguments -ceq (Get-BackgroundArguments $Configuration) -and
      $action.WorkingDirectory -ieq $Configuration.ProjectRoot) {
      if ([string]$Task.Principal.LogonType -eq 'S4U') { return 'Legacy' }
    }
    if ($action.Execute -ieq $Configuration.ScriptHostPath -and $action.Arguments -ceq (Get-BackgroundHiddenArguments $Configuration) -and
      $action.WorkingDirectory -ieq $Configuration.ProjectRoot -and [string]$Task.Principal.LogonType -eq 'Interactive') { return 'Login' }
    if ($action.Execute -ieq $Configuration.LauncherPath -and [string]$action.Arguments -ceq '' -and
      $action.WorkingDirectory -ieq $Configuration.ProtectDirectory -and [string]$Task.Principal.LogonType -eq 'S4U') { return 'Protected' }
  }
  throw '同名计划任务不是本项目固定登录定义或精确旧定义，拒绝覆盖、启动、停止或删除。'
}

function Assert-BackgroundLauncherProtection {
  <# 第一实施单元安全关闭新链；产物、收据和权限的真实核验由受保护安装单元补齐。 #>
  param([Parameter(Mandatory)]$Configuration)
  # 不读取尚未部署的保护目录，也不以文件存在、任务有限运行等级或可写记录代替保护证明。
  throw '受保护启动器安装及权限核验尚未完成；保持计划任务停用，不能安装、启动或启用新链。'
}

function Get-OwnedBackgroundTask {
  <# 同名任务只有在标记、用户、有限权限和完整动作全部吻合时才属于本项目，拒绝覆盖或停用外来任务。 #>
  param([Parameter(Mandatory)]$Configuration)
  try { $task = Get-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName -ErrorAction Stop }
  catch {
    # 本机5.1只读确认的精确空查询；权限/服务/其他来源故障不能变成“未安装”或预览授权。
    if ($_.FullyQualifiedErrorId -ceq 'CmdletizationQuery_NotFound,Get-ScheduledTask' -and
      $_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw
  }
  if (-not $task) { return $null }
  $expectedDescription = $Configuration.Owner + '|root=' + $Configuration.ProjectRoot + '|sid=' + $Configuration.UserSid
  $principalSid = [string]$task.Principal.UserId
  if ($principalSid -notmatch '^S-\d(-\d+)+$') {
    try { $principalSid = ([Security.Principal.NTAccount]::new($principalSid)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw '同名任务运行账户无法核对，拒绝操作。' }
  }
  if ($task.Description -ne $expectedDescription -or $principalSid -ne $Configuration.UserSid -or
    [string]$task.Principal.LogonType -notin @('S4U','Interactive') -or [string]$task.Principal.RunLevel -ne 'Limited') {
    throw '同名计划任务不符合本项目身份或运行边界，拒绝覆盖、启动、停止或删除。'
  }
  $null = Get-BackgroundTaskDefinitionKind $Configuration $task
  return $task
}

function Assert-BackgroundTaskConfiguration {
  <# 核对实际部署语义而非序列化字面存在性；只允许已知默认省略，权限仍须核对真实任务。 #>
  param([Parameter(Mandatory)]$Configuration)
  [xml]$xml = Export-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName
  $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
  $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $checks = @{
    '/t:Task/t:RegistrationInfo/t:Description' = ($Configuration.Owner + '|root=' + $Configuration.ProjectRoot + '|sid=' + $Configuration.UserSid)
    '/t:Task/t:Principals/t:Principal/t:UserId' = $Configuration.UserSid
    '/t:Task/t:Principals/t:Principal/t:LogonType' = 'InteractiveToken'
    '/t:Task/t:Principals/t:Principal/t:RunLevel' = 'LeastPrivilege'
    '/t:Task/t:Triggers/t:LogonTrigger/t:Enabled' = 'true'
    '/t:Task/t:Triggers/t:LogonTrigger/t:Delay' = 'PT15S'
    '/t:Task/t:Triggers/t:LogonTrigger/t:UserId' = $Configuration.UserSid
    '/t:Task/t:Triggers/t:TimeTrigger/t:Enabled' = 'true'
    '/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Interval' = 'PT1M'
    '/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:StopAtDurationEnd' = 'false'
    '/t:Task/t:Settings/t:MultipleInstancesPolicy' = 'IgnoreNew'
    '/t:Task/t:Settings/t:ExecutionTimeLimit' = 'PT0S'
    '/t:Task/t:Settings/t:DisallowStartIfOnBatteries' = 'false'
    '/t:Task/t:Settings/t:StopIfGoingOnBatteries' = 'false'
    '/t:Task/t:Settings/t:StartWhenAvailable' = 'true'
    '/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable' = 'false'
    '/t:Task/t:Settings/t:RunOnlyIfIdle' = 'false'
    '/t:Task/t:Settings/t:IdleSettings/t:StopOnIdleEnd' = 'false'
    '/t:Task/t:Settings/t:IdleSettings/t:RestartOnIdle' = 'false'
    '/t:Task/t:Settings/t:AllowStartOnDemand' = 'true'
    '/t:Task/t:Settings/t:AllowHardTerminate' = 'true'
    '/t:Task/t:Settings/t:RestartOnFailure/t:Interval' = 'PT1M'
    '/t:Task/t:Settings/t:RestartOnFailure/t:Count' = '3'
    '/t:Task/t:Settings/t:Hidden' = 'true'
    '/t:Task/t:Settings/t:WakeToRun' = 'false'
    '/t:Task/t:Settings/t:Priority' = '7'
    '/t:Task/t:Actions/t:Exec/t:Command' = $Configuration.ScriptHostPath
    '/t:Task/t:Actions/t:Exec/t:Arguments' = (Get-BackgroundHiddenArguments $Configuration)
    '/t:Task/t:Actions/t:Exec/t:WorkingDirectory' = $Configuration.ProjectRoot
  }
  # Windows注册后可能省略等于架构默认值的节点。只将这些精确路径视为默认；
  # 电池策略、无时限、StopOnIdleEnd等默认值不等于目标，缺失仍须拒绝。
  # 官方架构：https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema
  $schemaDefaults = @{
    '/t:Task/t:Triggers/t:LogonTrigger/t:Enabled' = 'true'
    '/t:Task/t:Triggers/t:TimeTrigger/t:Enabled' = 'true'
    '/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:StopAtDurationEnd' = 'false'
    '/t:Task/t:Settings/t:MultipleInstancesPolicy' = 'IgnoreNew'
    '/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable' = 'false'
    '/t:Task/t:Settings/t:RunOnlyIfIdle' = 'false'
    '/t:Task/t:Settings/t:IdleSettings/t:RestartOnIdle' = 'false'
    '/t:Task/t:Settings/t:AllowStartOnDemand' = 'true'
    '/t:Task/t:Settings/t:AllowHardTerminate' = 'true'
    '/t:Task/t:Settings/t:WakeToRun' = 'false'
    '/t:Task/t:Settings/t:Priority' = '7'
  }
  foreach ($key in $checks.Keys) {
    if ($xml.SelectNodes($key,$ns).Count -gt 1) { throw '本项目任务核心字段重复，拒绝核验。' }
    $node = $xml.SelectSingleNode($key,$ns)
    $value = $null
    if ($node) {
      # 显式错误或空白不能被默认值覆盖，即使系统最终可能有其他解释。
      $value = $node.InnerText
      if ($key -in @('/t:Task/t:Principals/t:Principal/t:UserId','/t:Task/t:Triggers/t:LogonTrigger/t:UserId')) {
        # Windows可把同一用户导出为安全标识或账户名；两处都必须解析为原绑定标识。
        # 不删除空白、不套用当前用户默认值，也不能因翻译失败放行陌生账户或任意用户登录。
        if ([string]::IsNullOrWhiteSpace($value)) { throw '本项目任务主体或登录账户为空白，拒绝核验。' }
        try {
          if ($value -match '^S-\d(-\d+)+$') { $value = [Security.Principal.SecurityIdentifier]::new($value).Value }
          else { $value = ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value }
        } catch { throw '本项目任务主体或登录账户无法转换为安全标识，拒绝核验。' }
      }
    } elseif ($key -eq '/t:Task/t:Principals/t:Principal/t:RunLevel') {
      # RunLevel在XML架构没有声明默认值，不能凭节点缺失推定有限权限。
      # 重新核对实际任务的完整归属与有效Principal；查询失败/缺失/提升均不放行。
      $effectiveTask = Get-OwnedBackgroundTask $Configuration
      if ($effectiveTask -and [string]$effectiveTask.Principal.RunLevel -eq 'Limited') { $value = 'LeastPrivilege' }
    } elseif ($schemaDefaults.ContainsKey($key)) {
      $value = $schemaDefaults[$key]
    }
    if ($value -cne $checks[$key]) {
      $actual = if ($null -eq $value) { '缺失且未核验' } else { $value }
      throw ('本项目任务核心配置不匹配（{0}；期望{1}，实际{2}）；不能确认登录自启配置有效，请核对任务。' -f $key,$checks[$key],$actual)
    }
  }
  if ($xml.SelectNodes('/t:Task/t:Triggers/*',$ns).Count -ne 2 -or
    $xml.SelectNodes('/t:Task/t:Triggers/t:LogonTrigger',$ns).Count -ne 1 -or
    $xml.SelectNodes('/t:Task/t:Triggers/t:TimeTrigger',$ns).Count -ne 1 -or
    $xml.SelectNodes('/t:Task/t:Principals/t:Principal',$ns).Count -ne 1 -or
    $xml.SelectNodes('/t:Task/t:Actions/*',$ns).Count -ne 1 -or
    $xml.SelectNodes('/t:Task/t:Triggers/t:TimeTrigger/t:Repetition/t:Duration',$ns).Count -ne 0 -or
    $xml.SelectNodes('/t:Task/t:Triggers/*/t:EndBoundary',$ns).Count -ne 0) {
    throw '本项目任务触发定义不符合唯一用户登录/无限一分钟恢复配置。'
  }
  # 系统规范化会省略唯一主体的id和动作Context；存在引用时必须指向唯一主体，不能套用任意缺省身份。
  $principalNode = $xml.SelectSingleNode('/t:Task/t:Principals/t:Principal',$ns)
  $actionsNode = $xml.SelectSingleNode('/t:Task/t:Actions',$ns)
  $context = $actionsNode.GetAttribute('Context')
  if (($principalNode.HasAttribute('id') -and -not $principalNode.GetAttribute('id').Trim()) -or
    ($actionsNode.HasAttribute('Context') -and (-not $context.Trim() -or $context -cne $principalNode.GetAttribute('id')))) {
    throw '登录动作主体引用不匹配，拒绝核验。'
  }
  $boundary = $xml.SelectSingleNode('/t:Task/t:Triggers/t:TimeTrigger/t:StartBoundary',$ns)
  $boundaryDate = [DateTimeOffset]::MinValue
  if (-not $boundary -or -not [DateTimeOffset]::TryParse($boundary.InnerText,[ref]$boundaryDate) -or
    $boundaryDate -gt [DateTimeOffset]::Now.AddMinutes(2)) { throw '本项目周期恢复触发缺失或起点过远，不能视为可用。' }
}

function Get-BackgroundRecord {
  <# 有界读取自有运行记录；失败不猜PID，不扫描/结束未知进程。 #>
  param([Parameter(Mandatory)]$Configuration)
  Assert-BackgroundRuntimePaths $Configuration
  $recordPath = Join-Path $Configuration.StateDirectory 'instance.json'
  if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return $null }
  $file = Get-Item -LiteralPath $recordPath -Force
  if ($file.Length -gt 16384) { throw '看板运行身份记录过大，拒绝操作进程。' }
  try { $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw '看板运行身份记录损坏，拒绝操作进程。' }
  $required = @('version','owner','projectRoot','runnerPath','nodePath','registryPath','port','pid','processCreatedAt','userSid','instanceId','elevated','sessionId')
  foreach ($field in $required) {
    if (-not ($record.PSObject.Properties.Name -contains $field)) { throw '看板运行身份记录不完整，拒绝操作进程。' }
  }
  if ($record.version -ne 1 -or $record.owner -ne $Configuration.Owner -or $record.projectRoot -ine $Configuration.ProjectRoot -or
    $record.runnerPath -ine $Configuration.RunnerPath -or $record.nodePath -ine $Configuration.NodePath -or
    $record.registryPath -ine $Configuration.RegistryPath -or $record.port -ne $Configuration.Port -or
    $record.userSid -ne $Configuration.UserSid -or $record.pid -lt 1 -or $record.instanceId -notmatch '^[a-f0-9-]{36}$' -or $record.elevated -isnot [bool]) {
    throw '运行身份记录不属于当前看板配置，拒绝操作进程。'
  }
  return $record
}

function Get-VerifiedBackgroundProcess {
  <# 核对PID、创建时刻、用户SID、Node可执行路径及完整入口参数；返回稳定句柄以避免编号复用误杀。 #>
  param([Parameter(Mandatory)]$Configuration)
  $record = Get-BackgroundRecord $Configuration
  if (-not $record) { return $null }
  $native = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid) -ErrorAction Stop
  if (-not $native) { return $null }
  $ownerSid = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid -ErrorAction Stop
  if ($native.ExecutablePath -ine $Configuration.NodePath -or
    $native.CommandLine -cnotmatch (Get-BackgroundCommandPattern $Configuration) -or
    $native.CreationDate.ToUniversalTime().ToString('o') -cne $record.processCreatedAt -or
    $ownerSid.ReturnValue -ne 0 -or $ownerSid.Sid -ne $Configuration.UserSid) {
    # 编号已复用或身份不吻合只算失效记录，不结束现在占有该编号的进程。
    return $null
  }
  $handle = [Diagnostics.Process]::GetProcessById([int]$record.pid)
  try {
    $null = $handle.Handle
    $handleTicks = $handle.StartTime.ToUniversalTime().Ticks
    $recordTicks = ([DateTimeOffset]::Parse($record.processCreatedAt)).UtcDateTime.Ticks
    # CIM只保留微秒（10个100ns刻度）；按该原生来源精度核对句柄，不能用毫秒/秒级容差。
    if (($handleTicks - ($handleTicks % 10)) -ne $recordTicks) { $handle.Dispose(); return $null }
    return $handle
  } catch { $handle.Dispose(); return $null }
}

function Test-BackgroundHealth {
  <# 只检查回环健康接口，不读取任意登记项目数据库；HTTP成功不等于业务项目已验收。 #>
  param([Parameter(Mandatory)]$Configuration)
  try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Configuration.Port + '/api/health') -TimeoutSec 2
    return ($health.version -eq 1 -and $health.service -eq 'ok')
  } catch { return $false }
}

function Initialize-BackgroundTokenNative {
  <# 只在内存生成固定系统查询接口；不编译源码、不落动态库，也不调用提权或令牌修改接口。 #>
  if (Get-Variable -Name BackgroundTokenNativeType -Scope Script -ErrorAction SilentlyContinue) { return $script:BackgroundTokenNativeType }
  $assemblyName = [Reflection.AssemblyName]::new('AwrDashboardTokenQuery_' + [Guid]::NewGuid().ToString('N'))
  if ([AppDomain]::CurrentDomain.GetType().GetMethods().Name -contains 'DefineDynamicAssembly') {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
  } else { $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run) }
  $module = $assembly.DefineDynamicModule($assemblyName.Name)
  $type = $module.DefineType('AwrDashboardTokenQuery',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
  $pointerReference = [IntPtr].MakeByRefType()
  $uintReference = [uint32].MakeByRefType()
  $errorReference = [int].MakeByRefType()
  $specifications = @(
    [pscustomobject]@{Name='OpenProcessToken';Library='advapi32.dll';Return=[int];Arguments=[type[]]@([IntPtr],[uint32],$pointerReference)},
    [pscustomobject]@{Name='GetTokenInformation';Library='advapi32.dll';Return=[int];Arguments=[type[]]@([IntPtr],[int],[IntPtr],[uint32],$uintReference)},
    [pscustomobject]@{Name='CloseHandle';Library='kernel32.dll';Return=[int];Arguments=[type[]]@([IntPtr])},
    [pscustomobject]@{Name='WTSQuerySessionInformationW';Library='wtsapi32.dll';Return=[int];Arguments=[type[]]@([IntPtr],[uint32],[int],$pointerReference,$uintReference)},
    [pscustomobject]@{Name='WTSFreeMemory';Library='wtsapi32.dll';Return=[void];Arguments=[type[]]@([IntPtr])}
  )
  $attributeType = [Runtime.InteropServices.DllImportAttribute]
  $constructor = $attributeType.GetConstructor([type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@($attributeType.GetField('EntryPoint'),$attributeType.GetField('ExactSpelling'),$attributeType.GetField('SetLastError'),$attributeType.GetField('CallingConvention'),$attributeType.GetField('CharSet'))
  foreach ($specification in $specifications) {
    # DefineMethod加完整导入属性才能在两个PowerShell运行时正确缓存系统错误；错误在中间语言内部立即取出。
    $raw = $type.DefineMethod('Native_' + $specification.Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$specification.Return,$specification.Arguments)
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($constructor,[object[]]@($specification.Library),$fields,[object[]]@($specification.Name,$true,$true,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode))
    $raw.SetCustomAttribute($attribute)
    $raw.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    if ($specification.Return -eq [void]) { continue }
    $wrapperArguments = [type[]]@($specification.Arguments + $errorReference)
    $wrapper = $type.DefineMethod($specification.Name,[Reflection.MethodAttributes]'Public,Static',[int],$wrapperArguments)
    $il = $wrapper.GetILGenerator()
    $result = $il.DeclareLocal([int])
    for ($index=0; $index -lt $specification.Arguments.Count; $index++) { $il.Emit([Reflection.Emit.OpCodes]::Ldarg,[int16]$index) }
    $il.Emit([Reflection.Emit.OpCodes]::Call,$raw)
    $il.Emit([Reflection.Emit.OpCodes]::Stloc,$result)
    $il.Emit([Reflection.Emit.OpCodes]::Ldarg,[int16]$specification.Arguments.Count)
    $il.Emit([Reflection.Emit.OpCodes]::Call,[Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'))
    $il.Emit([Reflection.Emit.OpCodes]::Stind_I4)
    $il.Emit([Reflection.Emit.OpCodes]::Ldloc,$result)
    $il.Emit([Reflection.Emit.OpCodes]::Ret)
  }
  $script:BackgroundTokenNativeType = $type.CreateType()
  return $script:BackgroundTokenNativeType
}

function Get-BackgroundNativeTokenEvidence {
  <# 从调用者已有稳定进程句柄读取真实主令牌；所有原生资源在finally关闭，绝不按PID重新打开。 #>
  param([Parameter(Mandatory)][IntPtr]$ProcessHandle)
  $native = Initialize-BackgroundTokenNative
  $token = [IntPtr]::Zero
  $buffers = [Collections.Generic.List[IntPtr]]::new()
  try {
    $arguments = [object[]]@($ProcessHandle,[uint32]8,[IntPtr]::Zero,[int]0)
    $opened = $native.GetMethod('OpenProcessToken').Invoke($null,$arguments)
    $token = [IntPtr]$arguments[2]
    if ($opened -eq 0 -or $token -eq [IntPtr]::Zero) { throw '目标进程令牌查询失败。' }
    $values = @{}
    foreach ($kind in @(1,2,8,12,20,25)) {
      $length = [uint32]4
      # 三项DWORD使用系统定义的固定尺寸；TokenElevation的空探针返回ERROR_BAD_LENGTH，不是可变结构的122。
      if ($kind -notin @(8,12,20)) {
        $arguments = [object[]]@($token,[int]$kind,[IntPtr]::Zero,[uint32]0,[uint32]0,[int]0)
        $probe = $native.GetMethod('GetTokenInformation').Invoke($null,$arguments)
        $length = [uint32]$arguments[4]
        if ($probe -ne 0 -or [int]$arguments[5] -ne 122 -or $length -lt 4 -or $length -gt 65536) { throw '目标令牌信息大小无法安全核对。' }
      }
      $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$length)
      $buffers.Add($buffer)
      $arguments = [object[]]@($token,[int]$kind,$buffer,$length,[uint32]0,[int]0)
      $queried = $native.GetMethod('GetTokenInformation').Invoke($null,$arguments)
      if ($queried -eq 0 -or [uint32]$arguments[4] -gt $length -or [uint32]$arguments[4] -lt 4) { throw '目标令牌信息读取失败。' }
      $values[$kind] = [pscustomobject]@{Pointer=$buffer;Length=[uint32]$arguments[4]}
    }
    $userSid = [Security.Principal.SecurityIdentifier]::new([Runtime.InteropServices.Marshal]::ReadIntPtr($values[1].Pointer)).Value
    $integritySid = [Security.Principal.SecurityIdentifier]::new([Runtime.InteropServices.Marshal]::ReadIntPtr($values[25].Pointer)).Value
    $integrityRid = [uint32]($integritySid.Split('-')[-1])
    $groups = $values[2]
    $count = [Runtime.InteropServices.Marshal]::ReadInt32($groups.Pointer)
    $offset = if ([IntPtr]::Size -eq 8) { 8 } else { 4 }
    $entrySize = [IntPtr]::Size * 2
    if ($count -lt 0 -or $count -gt 2048 -or ($offset + $count * $entrySize) -gt $groups.Length) { throw '目标令牌组信息无效。' }
    $administrator = $false
    for ($index=0; $index -lt $count; $index++) {
      $entry = [IntPtr]::Add($groups.Pointer,$offset + $index * $entrySize)
      $sid = [Security.Principal.SecurityIdentifier]::new([Runtime.InteropServices.Marshal]::ReadIntPtr($entry)).Value
      $attributes = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Runtime.InteropServices.Marshal]::ReadInt32($entry,[IntPtr]::Size)),0)
      # 查询目标令牌自己的组；启用且非仅拒绝的管理员组才是实际有效角色，不读取查询者的角色。
      if ($sid -eq 'S-1-5-32-544' -and ($attributes -band 4) -ne 0 -and ($attributes -band 16) -eq 0) { $administrator = $true }
    }
    return [pscustomobject]@{
      UserSid=$userSid
      Primary=([Runtime.InteropServices.Marshal]::ReadInt32($values[8].Pointer) -eq 1)
      TokenSessionId=[Runtime.InteropServices.Marshal]::ReadInt32($values[12].Pointer)
      Elevated=([Runtime.InteropServices.Marshal]::ReadInt32($values[20].Pointer) -ne 0)
      IntegrityRid=$integrityRid
      EffectiveAdministrator=$administrator
    }
  } finally {
    foreach ($buffer in $buffers) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    if ($token -ne [IntPtr]::Zero) { $arguments=[object[]]@($token,[int]0); $null=$native.GetMethod('CloseHandle').Invoke($null,$arguments) }
  }
}

function Get-BackgroundInteractiveSessionEvidence {
  <# 只核对本管理进程所在登录会话及其已登录账户；会话0、其他用户或查询失败均不能作交互证明。 #>
  param([Parameter(Mandatory)][int]$SessionId)
  $current = [Diagnostics.Process]::GetCurrentProcess()
  try { $currentSession = $current.SessionId } finally { $current.Dispose() }
  if ($SessionId -le 0 -or $SessionId -ne $currentSession) { throw '目标不是当前用户登录会话。' }
  $native = Initialize-BackgroundTokenNative
  $values = @{}
  foreach ($kind in @(5,7,8)) {
    $buffer = [IntPtr]::Zero
    try {
      $arguments = [object[]]@([IntPtr]::Zero,[uint32]$SessionId,[int]$kind,[IntPtr]::Zero,[uint32]0,[int]0)
      $queried = $native.GetMethod('WTSQuerySessionInformationW').Invoke($null,$arguments)
      $buffer = [IntPtr]$arguments[3]
      $length = [uint32]$arguments[4]
      if ($queried -eq 0 -or $buffer -eq [IntPtr]::Zero -or $length -lt 2 -or $length -gt 4096) { throw '登录会话查询失败。' }
      if ($kind -eq 8) {
        if ($length -ne 4) { throw '登录会话状态无效。' }
        $values[$kind] = [Runtime.InteropServices.Marshal]::ReadInt32($buffer)
      } else { $values[$kind] = [Runtime.InteropServices.Marshal]::PtrToStringUni($buffer) }
    } finally { if ($buffer -ne [IntPtr]::Zero) { $null=$native.GetMethod('Native_WTSFreeMemory').Invoke($null,[object[]]@($buffer)) } }
  }
  if (-not $values[5] -or $values[8] -notin @(0,4)) { throw '会话未登录或不是可核对的交互会话。' }
  $account = if ($values[7]) { $values[7] + '\' + $values[5] } else { $values[5] }
  $sid = ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value
  return [pscustomobject]@{SessionId=$currentSession;UserSid=$sid;LoggedOn=$true}
}

function Get-BackgroundTokenVerification {
  <# 独立判定标准登录有限令牌，查询前后复核同一句柄身份；不采信运行记录内的elevated或sessionId。 #>
  param([Parameter(Mandatory)]$Configuration,[Parameter(Mandatory)]$Process)
  $limited = $false
  $interactive = $false
  try {
    if ($Process.HasExited) { throw '目标已退出。' }
    $processId = $Process.Id
    $createdTicks = $Process.StartTime.ToUniversalTime().Ticks
    $sessionId = $Process.SessionId
    $evidence = Get-BackgroundNativeTokenEvidence -ProcessHandle $Process.Handle
    $session = Get-BackgroundInteractiveSessionEvidence -SessionId $sessionId
    $Process.Refresh()
    $stable = (-not $Process.HasExited -and $Process.Id -eq $processId -and
      $Process.StartTime.ToUniversalTime().Ticks -eq $createdTicks -and $Process.SessionId -eq $sessionId)
    $limited = ($stable -and $evidence.Primary -eq $true -and $evidence.UserSid -eq $Configuration.UserSid -and
      $evidence.EffectiveAdministrator -eq $false -and $evidence.Elevated -eq $false -and
      $evidence.IntegrityRid -ge 0 -and $evidence.IntegrityRid -le 8192)
    $interactive = ($stable -and $evidence.UserSid -eq $Configuration.UserSid -and $session.LoggedOn -eq $true -and $session.UserSid -eq $Configuration.UserSid -and
      $sessionId -gt 0 -and $session.SessionId -eq $sessionId -and $evidence.TokenSessionId -eq $sessionId)
  } catch { $limited=$false; $interactive=$false }
  return [pscustomobject]@{LimitedTokenVerified=[bool]$limited;InteractiveSessionVerified=[bool]$interactive}
}

function Get-BackgroundStatus {
  <# 分开报告登录任务、稳定实例、健康和真实令牌；登录自启不等于非交互或开机验证。 #>
  param([Parameter(Mandatory)]$Configuration)
  $task = Get-OwnedBackgroundTask $Configuration
  $definitionKind = if ($task) { Get-BackgroundTaskDefinitionKind $Configuration $task } else { 'None' }
  $lastTaskResult = $null
  if ($task) {
    # 退出码来自调度器的只读实际查询；失败时保留未知null，不从运行记录推断成功。
    try { $taskInfo = Get-ScheduledTaskInfo -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName -ErrorAction Stop; $lastTaskResult = $taskInfo.LastTaskResult }
    catch { $lastTaskResult = $null }
  }
  $process = $null
  $record = $null
  $runtimeRecordError = $false
  try { $record = Get-BackgroundRecord $Configuration; $process = Get-VerifiedBackgroundProcess $Configuration }
  catch { $runtimeRecordError = $true }
  $configurationValid = $false
  if ($definitionKind -eq 'Login') {
    try {
      Assert-BackgroundTaskConfiguration $Configuration
      $configurationValid = $true
    } catch { $configurationValid = $false }
  }
  try {
    $tokenVerification = [pscustomobject]@{LimitedTokenVerified=$false;InteractiveSessionVerified=$false}
    if ($process) { $tokenVerification = Get-BackgroundTokenVerification $Configuration $process }
    return [pscustomobject]@{
      TaskName = $Configuration.TaskName
      StartupMode = 'UserLogon'
      Installed = ($null -ne $task)
      Enabled = if ($task) { [bool]$task.Settings.Enabled } else { $false }
      TaskState = if ($task) { [string]$task.State } else { 'NotInstalled' }
      TaskDefinitionKind = $definitionKind
      LauncherProtectionVerified = $false
      LastTaskResult = $lastTaskResult
      TaskConfigurationValid = $configurationValid
      RuntimeRecordError = $runtimeRecordError
      ManagedProcessId = if ($process) { $process.Id } else { $null }
      Healthy = ($null -ne $process -and (Test-BackgroundHealth $Configuration))
      LimitedTokenVerified = $tokenVerification.LimitedTokenVerified
      InteractiveSessionVerified = $tokenVerification.InteractiveSessionVerified
      NonInteractiveSessionVerified = $false
      Url = 'http://127.0.0.1:' + $Configuration.Port + '/'
      BootRecoveryVerified = $false
    }
  } finally { if ($process) { $process.Dispose() } }
}

function Assert-BackgroundPortAvailable {
  <# 拒绝未知监听者且让查询失败显式阻断；只允许已核对稳定实例本身持有固定端口。 #>
  param([Parameter(Mandatory)]$Configuration,$Process)
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Configuration.Port })
  foreach ($listener in $listeners) {
    if (-not $Process -or $listener.OwningProcess -ne $Process.Id) { throw '看板端口被其他或未核对进程占用，未结束它，也未启动重复实例。' }
  }
}

function Get-BackgroundTaskInstanceCount {
  <# 只读精确所属任务的实际实例列表；停用标志不能代替无运行/排队实例的事实。 #>
  param([Parameter(Mandatory)]$Configuration)
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $registeredTask = $scheduler.GetFolder($Configuration.TaskPath).GetTask($Configuration.TaskName)
  return $registeredTask.GetInstances(0).Count
}

function Get-BackgroundTaskSecurityDescriptor {
  <# 只读本看板精确任务的所有者、主组及自由访问控制表；隔离测试必须替换此组件对象边界。 #>
  param([Parameter(Mandatory)]$Configuration)
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  return $scheduler.GetFolder($Configuration.TaskPath).GetTask($Configuration.TaskName).GetSecurityDescriptor(7)
}

function Set-BackgroundTaskSecurityDescriptor {
  <# 仅写已核对本任务的访问控制表，不写所有者/主组；禁止系统自动追加更宽的主体允许权限。 #>
  param([Parameter(Mandatory)]$Configuration,[Parameter(Mandatory)][string]$Dacl)
  $task = Get-OwnedBackgroundTask $Configuration
  if (-not $task -or (Get-BackgroundTaskDefinitionKind $Configuration $task) -ne 'Login' -or
    $task.Settings.Enabled -or [string]$task.State -ne 'Disabled' -or (Get-BackgroundTaskInstanceCount $Configuration) -ne 0) {
    throw '任务访问权限仅可在精确登录定义停用无实例时设置。'
  }
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $scheduler.GetFolder($Configuration.TaskPath).GetTask($Configuration.TaskName).SetSecurityDescriptor($Dacl,16)
}

function Set-BackgroundTaskReadExecutePermission {
  <# 仅收窄原SID显式允许项为通用读取/执行，保留拒绝项和所有其他主体；独立读回保持性后才可启用。 #>
  param([Parameter(Mandatory)]$Configuration,[string]$OriginalDescriptor)
  $originalText = if ($OriginalDescriptor) { $OriginalDescriptor } else { Get-BackgroundTaskSecurityDescriptor $Configuration }
  $original = [Security.AccessControl.RawSecurityDescriptor]::new($originalText)
  if (-not $original.DiscretionaryAcl -or -not $original.Owner -or -not $original.Group) { throw '任务访问控制信息缺失，保持停用。' }
  $candidate = [Security.AccessControl.RawSecurityDescriptor]::new($originalText)
  $sid = [Security.Principal.SecurityIdentifier]::new($Configuration.UserSid)
  $mask = [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]2684354560),0)
  $newAcl = [Security.AccessControl.RawAcl]::new($original.DiscretionaryAcl.Revision,$original.DiscretionaryAcl.Count + 1)
  $preserved = [Collections.Generic.List[string]]::new()
  foreach ($ace in $original.DiscretionaryAcl) {
    $owned = ($ace -is [Security.AccessControl.KnownAce] -and $ace.SecurityIdentifier -eq $sid)
    if ($owned) {
      if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::Inherited)) { throw '原用户权限项不是可安全收窄的显式普通项，保持停用。' }
      if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
      # 不删除拒绝项，也不能把对读取/执行的拒绝项装成成功；低位为系统通用映射的读取/执行权。
      if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied -and
        ($ace.AccessMask -band [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]::Parse('F01200A9',[Globalization.NumberStyles]::HexNumber)),0)) -ne 0) {
        throw '原用户有阻断读取/执行的拒绝权限，保持原拒绝项与任务停用。'
      }
    }
    $bytes = [byte[]]::new($ace.BinaryLength)
    $ace.GetBinaryForm($bytes,0)
    $preserved.Add([Convert]::ToBase64String($bytes))
    $newAcl.InsertAce($newAcl.Count,[Security.AccessControl.GenericAce]::CreateFromBinaryForm($bytes,0))
  }
  $newAcl.InsertAce($newAcl.Count,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,$mask,$sid,$false,$null))
  $candidate.DiscretionaryAcl = $newAcl
  Set-BackgroundTaskSecurityDescriptor $Configuration ($candidate.GetSddlForm([Security.AccessControl.AccessControlSections]::Access))
  $readback = [Security.AccessControl.RawSecurityDescriptor]::new((Get-BackgroundTaskSecurityDescriptor $Configuration))
  if ($readback.Owner -ne $original.Owner -or $readback.Group -ne $original.Group -or $readback.ControlFlags -ne $original.ControlFlags) { throw '任务权限读回改变所有者、主组或控制位，保持停用。' }
  $remaining = [Collections.Generic.List[string]]::new()
  $allowedCount = 0
  foreach ($ace in $readback.DiscretionaryAcl) {
    if ($ace -is [Security.AccessControl.CommonAce] -and $ace.SecurityIdentifier -eq $sid -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) {
      # 调度器可将通用GR/GX映射为文件仅读取/执行与同步；只接受这两种精确等价值，不能多一位修改权限。
      if ($ace.AccessMask -notin @($mask,0x001200A9) -or $ace.AceFlags -ne [Security.AccessControl.AceFlags]::None -or $ace.IsCallback) { throw '原用户权限读回不是唯一仅读取/执行项，保持停用。' }
      $allowedCount++
    } else {
      $bytes = [byte[]]::new($ace.BinaryLength)
      $ace.GetBinaryForm($bytes,0)
      $remaining.Add([Convert]::ToBase64String($bytes))
    }
  }
  if ($allowedCount -ne 1 -or ($remaining -join '|') -cne ($preserved -join '|')) { throw '任务权限独立读回不匹配或其他主体权限被改动，保持停用。' }
}

function Stop-BackgroundFailedRun {
  <# 失败后仅停用/停止仍归属明确的登录任务并独立读回，不重装旧链、不猜测或结束外来进程。 #>
  param([Parameter(Mandatory)]$Configuration)
  $errors = [Collections.Generic.List[string]]::new()
  $task = $null
  try { $task = Get-OwnedBackgroundTask $Configuration } catch { $errors.Add('任务归属读回失败，未处理同名未知任务') }
  if ($task) {
    if ((Get-BackgroundTaskDefinitionKind $Configuration $task) -ne 'Login') { $errors.Add('任务已不是登录定义，未处理旧链') }
    else {
      try { $null=Disable-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName -ErrorAction Stop }
      catch { $errors.Add('停用失败') }
      try { Stop-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName -ErrorAction Stop }
      catch { $errors.Add('调度停止失败') }
      try { Stop-BackgroundInstance $Configuration $null } catch { $errors.Add('稳定实例停止失败') }
    }
  } elseif ($errors.Count -eq 0) {
    try { Stop-BackgroundInstance $Configuration $null } catch { $errors.Add('预览实例停止失败') }
  }
  $disabled = $false
  $stopped = $false
  try {
    $status = Get-BackgroundStatus $Configuration
    $disabled = (-not $status.Installed -or -not $status.Enabled)
    $instances = if ($status.Installed) { Get-BackgroundTaskInstanceCount $Configuration } else { 0 }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Configuration.Port })
    $stopped = ($status.TaskState -notin @('Running','Queued') -and $instances -eq 0 -and $listeners.Count -eq 0 -and
      $null -eq $status.ManagedProcessId -and -not $status.RuntimeRecordError)
  } catch { $errors.Add('状态读回失败') }
  return ('失败安全收尾：停用读回={0}；无实例读回={1}；问题={2}。' -f $disabled,$stopped,($errors -join '、'))
}

function Assert-BackgroundLoginEnableReady {
  <# 权限读回后紧邻启用重新核对完整登录归属/定义，安装还须保持停用且无实例与监听，拒绝中途替换。 #>
  param([Parameter(Mandatory)]$Configuration,[switch]$Installation)
  $task = Get-OwnedBackgroundTask $Configuration
  if (-not $task -or (Get-BackgroundTaskDefinitionKind $Configuration $task) -ne 'Login') { throw '启用前已不是精确登录任务，拒绝启用。' }
  Assert-BackgroundTaskConfiguration $Configuration
  if ($Installation) {
    if ($task.Settings.Enabled -or [string]$task.State -ne 'Disabled' -or (Get-BackgroundTaskInstanceCount $Configuration) -ne 0) {
      throw '启用前任务已不是停用无实例状态，拒绝启用。'
    }
    $process = Get-VerifiedBackgroundProcess $Configuration
    if ($process) { $process.Dispose(); throw '启用前出现实例，拒绝启用。' }
    Assert-BackgroundPortAvailable $Configuration $null
  }
}

function Start-BackgroundInstance {
  <# 只启动完整登录定义或有限用户预览；成功须健康、真实有限令牌及当前登录会话，失败安全停用。 #>
  param([Parameter(Mandatory)]$Configuration, [switch]$RequireScheduledRun)
  $task = Get-OwnedBackgroundTask $Configuration
  # 旧定义必须在已有实例快速返回或任何写入之前拒绝，不能回退取消的非交互链。
  if ($task) {
    if ((Get-BackgroundTaskDefinitionKind $Configuration $task) -ne 'Login') { throw '旧非交互任务定义不能启动；请保持停用并安装已确认的当前用户登录定义。' }
  } else { Assert-BackgroundLimited }
  try {
    if ($task) { Assert-BackgroundTaskConfiguration $Configuration }
    Assert-BackgroundInputs $Configuration
    Assert-BackgroundRuntimePaths $Configuration
    $existing = Get-VerifiedBackgroundProcess $Configuration
    try {
      Assert-BackgroundPortAvailable $Configuration $existing
      if ($existing -and -not $RequireScheduledRun) {
        $status = Get-BackgroundStatus $Configuration
        if ($status.Healthy -and $status.LimitedTokenVerified -and $status.InteractiveSessionVerified -and
          (-not $task -or ($status.Enabled -and $status.TaskConfigurationValid))) { return $status }
        throw '已有实例未通过健康、真实有限令牌及当前登录会话核验。'
      }
      if ($existing) { throw '要求任务启动时已有实例，未自动转换预览或重复启动。' }
    } finally { if ($existing) { $existing.Dispose() } }
    if ($task) {
      if (-not $task.Settings.Enabled) { throw '看板登录任务已停用；请先Enable，再Start。' }
      Start-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName -ErrorAction Stop
    } else {
      if ($RequireScheduledRun) { throw '安装后未找到可归属任务，不能退回普通隐藏预览。' }
      $spawned = Start-Process -FilePath $Configuration.NodePath -ArgumentList (Get-BackgroundArguments $Configuration) -WorkingDirectory $Configuration.ProjectRoot -WindowStyle Hidden -PassThru
      $spawned.Dispose()
    }
    # 有限等待只查询本服务健康及身份，不能把配置成功或健康200当成真实登录启动通过。
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $status = Get-BackgroundStatus $Configuration
      if ($status.RuntimeRecordError) { throw '启动运行记录异常，不能确认实例身份。' }
      if ($null -ne $status.ManagedProcessId) {
        if (-not $status.LimitedTokenVerified -or -not $status.InteractiveSessionVerified) { throw '启动实例未通过真实有限令牌及当前用户登录会话核验。' }
        if ($status.Healthy -and (-not $task -or ($status.TaskState -eq 'Running' -and $status.Enabled -and $status.TaskConfigurationValid))) { return $status }
      }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw '看板未在15秒内成为可核对的健康登录实例；请查看run/background/startup-failure.json及service.log。'
  } catch {
    $failure = $_.Exception.Message
    $cleanup = Stop-BackgroundFailedRun $Configuration
    throw ($failure + ' ' + $cleanup)
  }
}

function Stop-BackgroundInstance {
  <# 仅停止有稳定创建身份的自有实例；保持任务时一分钟触发可重启，持久关闭应使用Disable。 #>
  param([Parameter(Mandatory)]$Configuration, $Task)
  # 任务已按完整动作/主体归属时可由调度器安全停止，覆盖尚未写记录或记录损坏的启动阶段。
  if ($Task -and [string]$Task.State -in @('Running','Queued')) {
    Stop-ScheduledTask -TaskPath $Configuration.TaskPath -TaskName $Configuration.TaskName
  }
  try { $process = Get-VerifiedBackgroundProcess $Configuration }
  catch {
    if ($Task) { Write-Warning '已停止归属明确的计划任务；运行记录异常，未按记录结束其他进程。'; return }
    throw
  }
  if (-not $process) { return }
  try {
    if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
    if (-not $process.HasExited) { throw '已核对实例未在5秒内结束，未处理其他进程。' }
  } finally { $process.Dispose() }
}

function Save-BackgroundTaskDefinition {
  <# 在注册前排他保留原导出的精确正文；只写本项目固定证据文件，冲突或链接一律拒绝覆盖。 #>
  param([Parameter(Mandatory)]$Configuration,[Parameter(Mandatory)][string]$Xml)
  if ($Xml.Length -gt 1048576) { throw '原任务导出超过有界备份上限，未注册。' }
  $null = [xml]$Xml
  Assert-BackgroundRuntimePaths $Configuration
  $backupPath = Join-Path $Configuration.StateDirectory 'task-definition-before-login.xml'
  if (Test-Path -LiteralPath $backupPath) { throw '登录转换原任务备份已存在，拒绝覆盖旧证据，未注册。' }
  $null = [IO.Directory]::CreateDirectory($Configuration.StateDirectory)
  Assert-BackgroundRuntimePaths $Configuration
  $stream = [IO.File]::Open($backupPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $encoding = [Text.UTF8Encoding]::new($true)
    $preamble = $encoding.GetPreamble()
    $bytes = $encoding.GetBytes($Xml)
    $stream.Write($preamble,0,$preamble.Length)
    $stream.Write($bytes,0,$bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  Assert-BackgroundPlainFile $backupPath
  if ((Get-Content -LiteralPath $backupPath -Raw -Encoding UTF8) -cne $Xml) { throw '原任务备份独立读回不匹配，未注册。' }
}

function Invoke-BackgroundManagement {
  <# 只执行本看板动作；登录任务先停用注册并独立核验，失败安全停用，不回退旧链或自动提权。 #>
  param([Parameter(Mandatory)][string]$RequestedAction)
  if ($RequestedAction -eq 'Install') { Assert-BackgroundAdministrator }
  $configuration = Get-BackgroundConfiguration
  if ($RequestedAction -eq 'Prepare') { return Get-BackgroundTaskXml $configuration }
  $task = Get-OwnedBackgroundTask $configuration
  switch ($RequestedAction) {
    'Install' {
      Assert-BackgroundInputs $configuration
      Assert-BackgroundRuntimePaths $configuration
      if ($task -and ($task.Settings.Enabled -or [string]$task.State -ne 'Disabled' -or (Get-BackgroundTaskInstanceCount $configuration) -ne 0)) {
        throw '安装只接受已停用且无任务实例的精确所属定义；请先停用，不自动转换正在运行的实例。'
      }
      $existing = Get-VerifiedBackgroundProcess $configuration
      if ($existing) {
        $existing.Dispose()
        throw '已有核对实例，安装不会自动停止或转换普通预览；请先自行安全停止。'
      }
      Assert-BackgroundPortAvailable $configuration $null
      $oldXml = $null
      $oldSecurity = $null
      if ($task) {
        $oldXml = Export-ScheduledTask -TaskPath $configuration.TaskPath -TaskName $configuration.TaskName -ErrorAction Stop
        $oldSecurity = Get-BackgroundTaskSecurityDescriptor $configuration
        Save-BackgroundTaskDefinition $configuration $oldXml
      }
      $newXml = Get-BackgroundTaskXml $configuration
      # 备份和生成期间若任务、运行记录、实例或端口发生变化，不能再强制覆盖；仅此精确任务可注册。
      $latest = Get-OwnedBackgroundTask $configuration
      if (($null -eq $latest) -ne ($null -eq $task)) { throw '注册前任务存在性发生变化，未注册。' }
      if ($latest -and ($latest.Settings.Enabled -or [string]$latest.State -ne 'Disabled' -or
        (Get-BackgroundTaskInstanceCount $configuration) -ne 0 -or
        (Export-ScheduledTask -TaskPath $configuration.TaskPath -TaskName $configuration.TaskName -ErrorAction Stop) -cne $oldXml -or
        (Get-BackgroundTaskSecurityDescriptor $configuration) -cne $oldSecurity)) {
        throw '注册前任务状态或导出发生变化，未注册。'
      }
      Assert-BackgroundRuntimePaths $configuration
      $existing = Get-VerifiedBackgroundProcess $configuration
      if ($existing) { $existing.Dispose(); throw '注册前出现核对实例，未注册或停止它。' }
      Assert-BackgroundPortAvailable $configuration $null
      try {
        $null = Register-ScheduledTask -TaskPath $configuration.TaskPath -TaskName $configuration.TaskName -Xml $newXml -Force:($null -ne $task) -ErrorAction Stop
        $registered = Get-OwnedBackgroundTask $configuration
        if (-not $registered -or (Get-BackgroundTaskDefinitionKind $configuration $registered) -ne 'Login' -or
          $registered.Settings.Enabled -or [string]$registered.State -ne 'Disabled' -or (Get-BackgroundTaskInstanceCount $configuration) -ne 0) {
          throw '登录任务注册后未独立读回为停用无实例，拒绝启用。'
        }
        Assert-BackgroundTaskConfiguration $configuration
        Set-BackgroundTaskReadExecutePermission $configuration -OriginalDescriptor $oldSecurity
        Assert-BackgroundLoginEnableReady $configuration -Installation
        $null = Enable-ScheduledTask -TaskPath $configuration.TaskPath -TaskName $configuration.TaskName -ErrorAction Stop
        return Start-BackgroundInstance $configuration -RequireScheduledRun
      } catch {
        $failure=$_.Exception.Message
        $cleanup=Stop-BackgroundFailedRun $configuration
        throw ($failure + ' ' + $cleanup)
      }
    }
    'Start' { return Start-BackgroundInstance $configuration }
    'Stop' {
      Stop-BackgroundInstance $configuration $task
      return Get-BackgroundStatus $configuration
    }
    'Status' { return Get-BackgroundStatus $configuration }
    'Disable' {
      if (-not $task) { throw '尚未安装本看板计划任务，未修改其他启动项。' }
      $null = Disable-ScheduledTask -TaskName $configuration.TaskName -TaskPath $configuration.TaskPath
      Stop-BackgroundInstance $configuration $task
      return Get-BackgroundStatus $configuration
    }
    'Enable' {
      if (-not $task) { throw '尚未安装本看板计划任务。' }
      if ((Get-BackgroundTaskDefinitionKind $configuration $task) -ne 'Login') { throw '旧非交互任务定义不能启用；请保持停用并安装已确认的当前用户登录定义。' }
      try {
        Assert-BackgroundLoginEnableReady $configuration
        $null = Enable-ScheduledTask -TaskName $configuration.TaskName -TaskPath $configuration.TaskPath -ErrorAction Stop
        return Start-BackgroundInstance $configuration
      } catch {
        $failure=$_.Exception.Message
        $cleanup=Stop-BackgroundFailedRun $configuration
        throw ($failure + ' ' + $cleanup)
      }
    }
    'Uninstall' {
      if ($task) {
        $null = Disable-ScheduledTask -TaskName $configuration.TaskName -TaskPath $configuration.TaskPath
        Stop-BackgroundInstance $configuration $task
        Unregister-ScheduledTask -TaskName $configuration.TaskName -TaskPath $configuration.TaskPath -Confirm:$false
      } else { Stop-BackgroundInstance $configuration $null }
      # 运行日志和记录保留，可调查和重新安装；不删除目录或项目数据。
      return Get-BackgroundStatus $configuration
    }
  }
}

# 允许测试只导入函数并替换有界专用配置；正常入口输出真实XML或机器可读状态，不打开UAC窗口。
if ($MyInvocation.InvocationName -ne '.') {
  try {
    $result = Invoke-BackgroundManagement $Action
    if ($Action -eq 'Prepare') { Write-Output $result } else { $result | ConvertTo-Json -Depth 4 }
  } catch { Write-Error $_.Exception.Message; exit 1 }
}
