import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'verification');

/** 执行固定本地测试入口，保存实际输出、退出码和时间，不执行报告里声明的任意命令。 */
async function run(name, args) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk.toString(); });
  child.stderr.on('data', chunk => { log += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  await writeFile(path.join(output, `${name}.log`), log);
  return { command: `node ${args.join(' ')}`, startedAt, verifiedAt: Date.now(), exitCode, passed: exitCode === 0, log };
}

await mkdir(output, { recursive: true });
const [unit, browser] = await Promise.all([
  run('unit-tests', ['--no-warnings', '--test', '--test-reporter=tap', 'tests/reader.test.mjs', 'tests/server.test.mjs']),
  run('browser-tests', ['--no-warnings', 'tests/browser-check.mjs']),
]);
const unitCounts = {};
for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  const match = unit.log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  assert.ok(match, `缺少实际${key}测试计数`);
  unitCounts[key] = Number(match[1]);
}
delete unit.log;
delete browser.log;
const browserResults = JSON.parse(await readFile(path.join(output, 'browser-results.json'), 'utf8'));
const report = { passed: unit.passed && browser.passed && unitCounts.fail === 0 && browserResults.passed === true,
  verifiedAt: Date.now(), nodeVersion: process.version, unit: { ...unit, counts: unitCounts },
  browser: { ...browser, checkCount: browserResults.checks.length, pageErrors: browserResults.pageErrors,
    observedRefreshMs: browserResults.observedRefreshMs, browserVersion: browserResults.browserVersion } };
await writeFile(path.join(output, 'test-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
