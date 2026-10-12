# 安装与运行

本说明适用于克隆后的独立仓库。需要 Node.js 24 或更新版本；查看真实数据还需要已有的 AWR（Agent Work Runtime，智能体工作运行时）0.5.1 项目和数据库结构版本 7。看板不安装 AWR、不初始化业务项目、不自动重新索引来源。

以下命令均从仓库根目录执行。前台运行使用普通用户权限；可选后台管理固定使用 Windows PowerShell 5.1 的 `powershell.exe`，不要在 PowerShell 7 中直接导入管理器内部函数。

## 安装依赖和本地清单

```powershell
npm ci
if (Test-Path -LiteralPath '.\config\projects.json') {
    throw '本地项目清单已存在，请核对现有内容，不要覆盖。'
}
Copy-Item -LiteralPath '.\config\projects.example.json' -Destination '.\config\projects.json'
```

示例为空清单，可以直接启动服务，页面会等待项目选择。手动编辑本地 `config/projects.json`，填入已经存在的项目；下面的路径仅展示格式，应替换为本机项目的绝对根目录：

```json
{
  "version": 1,
  "defaultProjectId": "example",
  "projects": [
    { "id": "example", "name": "示例项目", "root": "C:/path/to/awr-project" }
  ]
}
```

| 字段 | 实际含义 |
| --- | --- |
| `version` | 固定为数字 `1`。 |
| `defaultProjectId` | 新页面的默认项目标识；设为 `null` 时等待选择。标识不在清单中时也等待选择。 |
| `projects` | 登记数组，空数组合法；只允许 `id`、`name`、`root` 三个字段。 |
| `id` | 唯一标识，1 至 64 个英文字母、数字、点、下划线或连字符；首字符为英文字母或数字。 |
| `name` | 非空展示名，最多 200 个字符。 |
| `root` | 已有项目的绝对根目录，最多 4096 个字符；不能填网页地址。 |

清单必须是普通文件，不含注释、额外字段、控制字符或凭据；采用 UTF-8（Unicode Transformation Format 8-bit，8 位统一码转换格式）保存，最多 64 二进制千字节和 1000 个条目。清单不做全盘发现；保持同一标识对应同一项目可减少误认。

网页每 5 秒检查清单。单项目暂时不可用不阻止其余名单启动；整份清单不可读取或无效时，停止新的项目读取和切换，旧图明确标记过期。成功清单移除当前条目后，页面清空选择等待重选，不会自动跳到另一个项目。

## 前台启动

```powershell
npm start -- --port 4317
```

打开 [本地看板](http://127.0.0.1:4317/)，按 `Ctrl+C` 停止。端口占用时可改为 `4318`；不要结束未知进程。

指定另一份本地清单：

```powershell
npm start -- --projects '.\config\projects.json' --port 4318
```

也可添加 `--project 'C:/path/to/awr-project'` 覆盖新页面默认目标，但该目录必须已登记在本轮清单中。这个参数不会新增读取权限。每个参数最多出现一次；查看现有用法可执行 `npm start -- --help`。

## 可选：Windows 登录后后台运行

该方案是**本账户登录 Windows 后约 15 秒启动**，使用交互登录令牌与有限权限，不是未登录也可运行的系统服务。后台只管理固定任务 `AWR_Dashboard_Background`、本仓库运行目录和端口 `4317`；不能按不同仓库副本自动分配任务名或端口。

若本机已有该名称的任务或正在运行的看板，不要在另一副本直接执行安装、启动、停用或卸载；先核对原安装目录、账户和所有权。本脚本拒绝外来同名任务，不以新名称绕过冲突。可继续使用独立前台端口查看。

### 生成本机绑定

仅需要前台运行时，无需此文件。后台管理以及完整后台测试需要本地 `ops/background-settings.json`。格式示例包含占位值，不能直接作为运行配置。

先在当前账户的**普通用户 Windows PowerShell 5.1** 中、仓库根目录生成配置。下面只写本地绑定，不安装任务、不启动看板；文件已存在时明确停止，避免覆盖旧绑定：

```powershell
if (Test-Path -LiteralPath '.\ops\background-settings.json') {
    throw '本机后台绑定已存在，请核对当前账户与 Node.js 路径，不要覆盖。'
}
$dashboardNodePath = (& node -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($dashboardNodePath) -or
    [IO.Path]::GetFileName($dashboardNodePath) -ine 'node.exe' -or
    -not (Test-Path -LiteralPath $dashboardNodePath -PathType Leaf)) {
    throw '无法确认当前 node.exe 的绝对路径。'
}
$dashboardBinding = [ordered]@{
    version = 1
    userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    nodePath = $dashboardNodePath
}
$dashboardBindingPath = Join-Path (Get-Location).Path 'ops\background-settings.json'
[IO.File]::WriteAllText($dashboardBindingPath,
    ($dashboardBinding | ConvertTo-Json) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false))
```

| 字段 | 实际含义 |
| --- | --- |
| `version` | 数字 `1`，当前绑定格式版本。 |
| `userSid` | 本机实际运行账户的安全标识符（Security Identifier）；必须与当前管理账户及服务运行账户一致。不是用户名，也不是密码。 |
| `nodePath` | 本机实际 `node.exe` 的绝对路径；后台校验实际进程路径，不能填 `node`、目录、示例占位值或另一套安装路径。 |

该文件使用无字节顺序标记的 UTF-8，必须是普通单链接文件，最多 4096 字节。配置已被版本控制忽略；不要提交本机账户标识和安装路径。更换机器或账户时按实际环境重新生成，不能复制他人的绑定。

### 查看计划与临时后台预览

以下固定系统入口调用 Windows PowerShell 5.1。在本说明的每个新终端中先设置入口：

```powershell
$dashboardPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $dashboardPowerShell -NoProfile -ExecutionPolicy Bypass -File '.\ops\manage-background.ps1' -Action Prepare
& $dashboardPowerShell -NoProfile -ExecutionPolicy Bypass -File '.\ops\manage-background.ps1' -Action Status
```

`Prepare` 只输出计划任务定义，`Status` 读取本副本的实际配置与状态。没有安装任务时，可在普通用户终端使用 `Start` 启动隐藏预览：

```powershell
& $dashboardPowerShell -NoProfile -ExecutionPolicy Bypass -File '.\ops\manage-background.ps1' -Action Start
```

`Installed=false` 表示没有登录启动和调度恢复保障。管理员直接启动普通预览会被拒绝；旧非交互定义也不能用于当前 `Start` 或 `Enable`。

### 安装登录任务

安装是可选的真实系统变更。关闭同副本前台服务，并先通过原归属环境安全停止预览；若已有本副本所属任务，应先停用并确认没有运行或排队实例。安装不自动结束未知端口占用者，也不自动转换正在运行的任务。

由绑定的**同一用户**手动打开管理员 Windows PowerShell 5.1，切换到此仓库根目录，再执行：

```powershell
$dashboardPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
& $dashboardPowerShell -NoProfile -ExecutionPolicy Bypass -File '.\ops\manage-background.ps1' -Action Install
& $dashboardPowerShell -NoProfile -ExecutionPolicy Bypass -File '.\ops\manage-background.ps1' -Action Status
```

未提升的 `Install` 在变更前拒绝；脚本不自动弹出提权窗口、不保存密码、不换账户。新任务先注册为停用，独立读回归属、配置和权限后才启用并立即启动。替换已有所属定义前保留原定义，已有备份不覆盖；失败尝试停用并报告实际收尾，不恢复旧动作。

当前登录方案使用系统脚本宿主 `wscript.exe` 和本项目固定隐藏入口，等待固定 Node.js 进程退出；不部署原生降权启动器，不新增常驻监督循环。计划任务配置登录延迟 15 秒、一分钟无限重复触发、忽略重复启动和无运行时限，允许电池运行及补运行。进程退出后恢复由任务重试和周期触发处理；恢复时间不是硬保证，也不保证修复未退出但无响应的进程。

普通用户可查看、启动和停止；任务定义写操作需要同一用户管理员权限。替换下列动作即可调用相同入口：

| 动作 | 作用 |
| --- | --- |
| `Prepare` | 只输出定义，不安装、不启动。 |
| `Status` | 读取任务、健康、实际有限令牌和交互会话状态。 |
| `Start` | 启动已安装且启用的登录任务；未安装时启动普通用户预览。 |
| `Stop` | 临时停止本看板；启用的周期任务可能再次启动它。 |
| `Disable` | 停用所属任务并停止本看板，供持久关闭。 |
| `Enable` | 重新启用并启动符合当前方案的所属任务。 |
| `Uninstall` | 停用、停止并删除所属任务，保留项目、运行记录和日志。 |

`TaskConfigurationValid=true` 只证明配置；运行还需核对 `Healthy=true`、`LimitedTokenVerified=true`、`InteractiveSessionVerified=true`。`NonInteractiveSessionVerified` 和 `BootRecoveryVerified` 在当前方案中为 `false`。一次安装或手动启动不证明后续真实登录触发，隐藏标志不证明全过程无窗口。

日志位于 `run/background/service.log`，采用有界轮转；最近启动失败另记 `run/background/startup-failure.json` 的时间、阶段和安全类别。失败快照不代表当前健康，不能用删除门禁、清空现场或反复重装掩盖身份失败。

### 迁移或卸载

注册后不要移动仓库目录或 Node.js 安装路径。迁移前在旧目录、原账户下使用同一管理入口执行 `Uninstall`，保留日志；确认旧任务已卸载后，在新目录核对本地清单、重新生成绑定，再按新环境安装。不要在另一账户或新副本中改写旧绑定来接管任务。

本工具不会自动注销用户或重启电脑。真实登录触发、退出恢复和长期常驻需分别取证；本仓库安装说明不声称目标机器已经完成这些验收。

## 验证条件与结果边界

现有命令：

```powershell
npm test
npm run test:projects
npm run test:background
```

| 入口 | 实际覆盖与条件 |
| --- | --- |
| `npm test` | 顶层全部单元测试，包含后台和历史原生专项；Windows 完整执行还需下列系统和工具条件。 |
| `npm run test:projects` | 全部单元、原功能浏览器回归及项目选择检查；新增时间目录保留报告。 |
| `npm run test:background` | 全部单元及原功能、项目选择、详情栏浏览器检查；新增时间目录保留报告。 |

完整 Windows 测试的现有条件：

- 使用普通用户权限和 64 位 Node.js 24；历史原生专项校验 32 位夹具创建 64 位 Node.js 的组合。
- Windows PowerShell 5.1、Windows 计划任务组件和脚本宿主可用。历史原生专项还固定使用 `C:\Windows` 下的系统入口，并核对该默认系统目录。后台测试会调用路径可发现的 `pwsh.exe` 做解析检查；这不表示后台管理支持 PowerShell 7 直接导入内部函数。
- 按上述步骤在测试副本生成 `ops/background-settings.json`，其中 Node.js 路径与本次测试进程一致；部分夹具读取或复制该本地文件。
- 安装 Chrome；浏览器脚本固定使用本机 Chrome 通道，并不自动改用下载的 Chromium。
- 历史原生专项固定读取 `C:\MinGW\bin\gcc.exe` 与 `C:\MinGW\bin\objdump.exe`，编译器目标须为 `mingw32`，并核对已知系统库。更换工具路径不在现有参数范围内。

缺少条件时应记录实际失败或跳过，不能报告完整通过。前台产品使用不需要 Chrome、PowerShell 7 或 MinGW；这些是现有测试工具链约束。`ops/native/` 和 `ops/build-background-launcher.ps1` 保留历史源码与回归，当前后台方案不需要构建或部署它们。

测试状态变更限专用夹具，正式管理动作不因运行这些测试而安装真实任务。报告和截图写入本副本 `verification/`，已被版本控制忽略。直接运行 `test:browser` 或 `test:record` 会使用原固定输出，可能覆盖同副本旧报告；扩展验收优先使用上表的新目录入口。

真实项目只读验收脚本和本机历史报告未随本仓库提供；夹具测试或空清单不产生任何真实项目只读验收结论。需要验证真实项目时，应在目标环境独立获得授权，先核对登记来源和读取边界，留存验收窗口前后的文件字节与治理元数据，并协调窗口内其他写入；并发变动不能单独证明看板写入。

测试结果、任务配置、实际运行权限、真实登录触发和长期可靠性应分别报告，不互相替代。
