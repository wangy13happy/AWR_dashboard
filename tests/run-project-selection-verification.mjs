import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
// 每次运行使用新的目录，失败尝试和DASH-001历史报告均不会被后一次覆盖。
const relativeOutput = `verification/project-selection/run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = path.join(workspace, relativeOutput);
await mkdir(output, { recursive: true });

/** 执行固定测试入口并保存真实日志、时间和退出码；不执行报告中携带的任意命令。 */
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
  return { command: `node ${args.join(' ')}`, startedAt, verifiedAt: Date.now(), exitCode, passed: exitCode === 0, log };
}

const unitFiles = (await readdir(path.join(workspace, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
const [unit, regression, selection] = await Promise.all([
  run('unit', ['--no-warnings', '--test', '--test-reporter=tap', ...unitFiles.map(name => `tests/${name}`)], ''),
  run('regression-browser', ['--no-warnings', 'tests/browser-check.mjs'], 'regression'),
  run('selection-browser', ['--no-warnings', 'tests/project-selection-browser.mjs'], 'browser'),
]);
const counts = {};
for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  const match = unit.log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  assert.ok(match, `缺少实际${key}测试计数`);
  counts[key] = Number(match[1]);
}
delete unit.log; delete regression.log; delete selection.log;
const regressionReport = JSON.parse(await readFile(path.join(output, 'regression/browser-results.json'), 'utf8'));
const selectionReport = JSON.parse(await readFile(path.join(output, 'browser/browser-results.json'), 'utf8'));
const report = { passed: unit.passed && regression.passed && selection.passed && counts.fail === 0
    && counts.skipped === 0 && regressionReport.passed && selectionReport.passed,
  verifiedAt: Date.now(), nodeVersion: process.version, evidenceDirectory: relativeOutput,
  unit: { ...unit, counts }, regression: { ...regression, checkCount: regressionReport.checks.length,
    pageErrors: regressionReport.pageErrors, observedRefreshMs: regressionReport.observedRefreshMs },
  selection: { ...selection, checkCount: selectionReport.checkCount, pageErrors: selectionReport.pageErrors },
  boundary: '本次单元与浏览器写入均限定在自有夹具和新证据目录；不认证真实业务项目完成或后台5秒硬时限。' };
await writeFile(path.join(output, 'test-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
