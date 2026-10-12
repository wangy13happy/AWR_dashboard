import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../ops/start-background-hidden.vbs', import.meta.url));
const scriptHost = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

/** 隔离复刻固定目录结构；子入口只记录自身参数，不导入或读取真实看板与登记项目。 */
async function fixture(t, name = '项目 with spaces', { exitCode = 37 } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'awr-dashboard-hidden-'));
  const root = path.join(temporary, name);
  for (const directory of ['ops', 'bin', 'config']) await mkdir(path.join(root, directory), { recursive: true });
  const script = path.join(root, 'ops', 'start-background-hidden.vbs');
  await copyFile(wrapper, script);
  await writeFile(path.join(root, 'config', 'projects.json'), '{"version":1,"projects":[]}\n');
  await writeFile(path.join(root, 'bin', 'background-runner.mjs'), `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
setTimeout(() => process.exit(${exitCode}), 150);
`);
  t.after(async () => {
    // 删除范围仅为本测试刚创建的绝对临时根，不能依据外部输入扩大到真实项目。
    assert.equal(path.dirname(temporary), os.tmpdir());
    assert.ok(path.basename(temporary).startsWith('awr-dashboard-hidden-'));
    await rm(temporary, { recursive: true, force: true });
  });
  return { root, script, invocation: path.join(root, 'invocation.json') };
}

/** 实际调用系统脚本宿主；禁止终端窗口，等待包装自身退出并保留真实退出码。 */
async function invoke(script, args) {
  const child = spawn(scriptHost, ['//B', '//Nologo', script, ...args], { windowsHide: true, stdio: 'ignore' });
  const started = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, elapsed: Date.now() - started };
}

test('隐藏包装按自身位置固定参数、支持中文空格路径，等待Node退出并传回原退出码',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const sample = await fixture(t);
    const result = await invoke(sample.script, [process.execPath]);
    assert.equal(result.exitCode, 37);
    assert.ok(result.elapsed >= 140, '不能启动后就退出而丢失计划任务运行态');
    const actual = JSON.parse(await readFile(sample.invocation, 'utf8'));
    assert.deepEqual(actual.args, ['--port', '4317', '--projects', path.join(sample.root, 'config', 'projects.json'),
      '--state-directory', path.join(sample.root, 'run', 'background')]);
    assert.equal(actual.cwd, sample.root);
  });

test('隐藏包装拒绝额外参数、相对或不存在的Node与会触发环境展开的项目路径',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const sample = await fixture(t);
    for (const args of [[], [process.execPath, 'unexpected'], ['node.exe'], [path.join(sample.root, 'missing', 'node.exe')]]) {
      assert.equal((await invoke(sample.script, args)).exitCode, 1);
      await assert.rejects(access(sample.invocation));
    }
    const percent = await fixture(t, 'project%TEMP%');
    assert.equal((await invoke(percent.script, [process.execPath])).exitCode, 1);
    await assert.rejects(access(percent.invocation));
  });

test('隐藏包装使用无窗口等待式Run，不引入命令解释器或常驻监督循环', async () => {
  const source = await readFile(wrapper, 'utf8');
  assert.ok([...source].every(character => character.charCodeAt(0) <= 127), '传统脚本宿主不能可靠解析UTF-8非ASCII注释');
  assert.match(source, /shell\.Run\(command, 0, True\)/);
  assert.match(source, /WScript\.Quit result/);
  assert.doesNotMatch(source, /^\s*(?:Do\b|While\b|For\b)/im);
  assert.doesNotMatch(source, /\b(?:cmd\.exe|powershell\.exe|WScript\.Sleep)\b/i);
});

test('隐藏包装保留正常零退出，存在但无法执行的Node失败时返回1且不留下合成实例',
  { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const success = await fixture(t, 'zero exit', { exitCode: 0 });
    assert.equal((await invoke(success.script, [process.execPath])).exitCode, 0);
    await access(success.invocation);
    const failure = await fixture(t, 'failed launch');
    const invalidNode = path.join(failure.root, 'node.exe');
    await writeFile(invalidNode, 'Not a Windows executable.\n');
    assert.equal((await invoke(failure.script, [invalidNode])).exitCode, 1);
    await assert.rejects(access(failure.invocation));
  });
