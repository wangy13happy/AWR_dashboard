import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';

const execute = promisify(execFile);
const PREFIX = 'awr-dashboard-background-project-';

/** 仅调整测试子进程的模块发现；固定的Windows PowerShell5.1不能继承PowerShell7的模块搜索配置。 */
export function windowsPowerShellEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.toLowerCase() === 'psmodulepath') delete environment[name];
  return environment;
}

/** 逐层复制固定运行依赖的普通文件，拒绝符号链接及目录联接，不能让临时副本指回原node_modules。 */
async function copyDependencyTree(source, target) {
  const item = await lstat(source);
  assert.ok(item.isDirectory() && !item.isSymbolicLink());
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const child = await lstat(from);
    assert.ok(!child.isSymbolicLink());
    if (child.isDirectory()) await copyDependencyTree(from, to);
    else { assert.ok(child.isFile()); await copyFile(from, to); }
  }
}

/**
 * 原字节复制后台测试所需的固定产品文件，在自有临时根生成当前身份绑定。
 * 不读取源项目的个人绑定、登记清单、运行记录或AWR文件；实际加载器和身份门禁仍由产品代码执行。
 */
export async function createBackgroundProject(sourceRoot, powershellPath) {
  const created = await mkdtemp(path.join(os.tmpdir(), PREFIX));
  const root = await realpath(created);
  const identity = await lstat(root, { bigint: true });

  /** 只删除本次创建且目录身份未变化的临时根；调用者须先结束本测试拥有的子进程。 */
  async function cleanup() {
    const relative = path.relative(await realpath(os.tmpdir()), root);
    assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(root).startsWith(PREFIX));
    const remaining = await lstat(root, { bigint: true });
    assert.ok(remaining.isDirectory() && !remaining.isSymbolicLink());
    assert.equal(remaining.dev, identity.dev);
    assert.equal(remaining.ino, identity.ino);
    assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase());
    await rm(root, { recursive: true, force: true });
  }

  try {
    await Promise.all(['bin', 'ops', 'src', 'config', 'node_modules'].map(name => mkdir(path.join(root, name))));
    // 固定白名单保留产品入口和管理器的原始字节（包括UTF8 BOM），不复制整个工作区或任何被查看项目。
    for (const relative of ['bin/background-runner.mjs', 'ops/manage-background.ps1', 'ops/start-background-hidden.vbs',
      'src/server.js', 'src/registry.js', 'src/reader.js', 'src/agent-running.js', 'src/lanes.js', 'src/agent-observer.js', 'src/agent-process-windows.cs', 'src/safety.js', 'package.json']) {
      await copyFile(path.join(sourceRoot, relative), path.join(root, relative));
    }
    // reader的唯一运行依赖没有下游依赖；复制完整包保持其exports和dist内部模块解析，不用链接借用原目录。
    const dependency = path.join(sourceRoot, 'node_modules', 'smol-toml');
    await copyDependencyTree(dependency, path.join(root, 'node_modules', 'smol-toml'));
    const result = await execute(powershellPath, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      "$ErrorActionPreference='Stop'; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
    { windowsHide: true, env: windowsPowerShellEnvironment(), encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
    const userSid = result.stdout.trim();
    assert.match(userSid, /^S-\d(-\d+)+$/);
    const nodePath = await realpath(process.execPath);
    const settingsPath = path.join(root, 'ops', 'background-settings.json');
    // 示例是仓库契约：核对其结构，仅替换两个本机公开身份字段，不读取工作树中的真实安装绑定。
    const example = JSON.parse(await readFile(path.join(sourceRoot, 'ops', 'background-settings.example.json'), 'utf8'));
    assert.deepEqual(Object.keys(example).sort(), ['nodePath', 'userSid', 'version']);
    assert.equal(example.version, 1);
    assert.equal(typeof example.userSid, 'string');
    assert.equal(typeof example.nodePath, 'string');
    await writeFile(settingsPath, `${JSON.stringify({ ...example, userSid, nodePath })}\n`, { flag: 'wx' });
    await writeFile(path.join(root, 'config', 'projects.json'), '{"version":1,"defaultProjectId":null,"projects":[]}\n', { flag: 'wx' });
    return { root, managerPath: path.join(root, 'ops', 'manage-background.ps1'),
      runnerPath: path.join(root, 'bin', 'background-runner.mjs'), settingsPath, userSid, nodePath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
