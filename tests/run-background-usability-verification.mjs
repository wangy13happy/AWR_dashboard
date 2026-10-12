import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const relativeOutput = `verification/background-startup/run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = path.join(workspace, relativeOutput);
await mkdir(output, { recursive: true });

/** 执行固定测试入口并记录实际退出码；每次新目录保留旧验收和失败尝试。 */
async function run(name, args, directory) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: workspace, windowsHide: true,
    env: { ...process.env, AWR_DASHBOARD_VERIFICATION_DIR: path.join(relativeOutput, directory) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', bytes => { log += bytes.toString(); });
  child.stderr.on('data', bytes => { log += bytes.toString(); });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await writeFile(path.join(output, `${name}.log`), log);
  console.log(`${name}：退出${exitCode}`);
  return { command: `node ${args.join(' ')}`, startedAt, verifiedAt: Date.now(), exitCode,
    passed: exitCode === 0, log };
}

/** 缺少报告也作为失败留档，不因读取失败丢失其他已执行测试的结果。 */
async function browserResult(directory) {
  try { return JSON.parse(await readFile(path.join(output, directory, 'browser-results.json'), 'utf8')); }
  catch { return { passed: false, checks: [], pageErrors: ['报告缺失或无效，见对应命令日志。'] }; }
}

const unitFiles = (await readdir(path.join(workspace, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
const [unit, regression, selection, sidebar] = await Promise.all([
  run('unit', ['--no-warnings', '--test', '--test-reporter=tap', ...unitFiles.map(name => `tests/${name}`)], ''),
  run('regression-browser', ['--no-warnings', 'tests/browser-check.mjs'], 'regression'),
  run('selection-browser', ['--no-warnings', 'tests/project-selection-browser.mjs'], 'selection'),
  run('sidebar-browser', ['--no-warnings', 'tests/sidebar-browser.mjs'], 'sidebar'),
]);
const counts = {};
for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  const match = unit.log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  counts[key] = match ? Number(match[1]) : null;
}
delete unit.log; delete regression.log; delete selection.log; delete sidebar.log;
const [regressionReport, selectionReport, sidebarReport] = await Promise.all([
  browserResult('regression'), browserResult('selection'), browserResult('sidebar'),
]);

/** 汇总已执行命令及报告，缺失计数和页面异常不能被当成通过。 */
function browserSummary(command, report) {
  return { ...command, passed: command.passed && report.passed === true
    && Array.isArray(report.pageErrors) && report.pageErrors.length === 0,
  checkCount: report.checkCount ?? report.checks?.length ?? 0, pageErrors: report.pageErrors ?? ['缺少异常统计'],
  observedRefreshMs: report.observedRefreshMs ?? null };
}

const report = { passed: false, verifiedAt: Date.now(), nodeVersion: process.version,
  evidenceDirectory: relativeOutput, unit: { ...unit, counts },
  regression: browserSummary(regression, regressionReport), selection: browserSummary(selection, selectionReport),
  sidebar: browserSummary(sidebar, sidebarReport),
  boundary: '测试只改专用临时夹具与新证据目录；不证明管理员启动任务已安装、真实重启或长期常驻可靠性。' };
report.passed = report.unit.passed && counts.fail === 0 && counts.skipped === 0 && counts.cancelled === 0
  && counts.pass === counts.tests && report.regression.passed && report.selection.passed && report.sidebar.passed;
await writeFile(path.join(output, 'test-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
assert.equal(report.passed, true, '存在测试失败、跳过、缺失报告或页面异常；请查看本轮保留日志。');
