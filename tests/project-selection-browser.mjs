import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, updateFixtureWork, fixtureFileBaseline } from './reader-fixture.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(workspace, process.env.AWR_DASHBOARD_VERIFICATION_DIR ?? 'verification/project-selection/browser');
// 后续局部改动的回归沿用同一行为检查，但证据可保存到对应的新交付目录；旧报告不覆盖。
const relativeOutput = path.relative(path.join(workspace, 'verification'), output);
assert.ok(!path.isAbsolute(relativeOutput) && /^(project-selection|background-startup)[\\/]/.test(relativeOutput)
  && !relativeOutput.split(/[\\/]/).includes('..'), '专项证据仅写本项目独立验收目录');
const checks = [];
const reads = { a: 0, b: 0, other: 0 };
let fixtureA, fixtureB, registryDirectory, registryPath, server, browser, page, config;
let listResponses = 0;
let failure = null;
const pageErrors = [];

/** 仅改写本测试创建的登记清单；真实四项目登记文件不参与故障注入。 */
async function saveRegistry(value = config) {
  await writeFile(registryPath, `${JSON.stringify(value, null, 2)}\n`);
}

/** 专用夹具读取者记录按根隔离的次数，仍使用产品的稳定副本只读链路。 */
async function fixtureSnapshot(projectRoot) {
  const key = path.normalize(projectRoot) === path.normalize(fixtureA.root) ? 'a'
    : path.normalize(projectRoot) === path.normalize(fixtureB.root) ? 'b' : 'other';
  reads[key] += 1;
  const snapshot = await readSnapshot(projectRoot);
  snapshot.mode = 'demo';
  return snapshot;
}

/** 保存已完成检查的名称与真实时刻；不把未执行步骤当成通过。 */
function passed(name) {
  checks.push({ name, passed: true, verifiedAt: Date.now() });
  console.log(`通过：${name}`);
}

/** 取得当前合法的A快照，供故意忽略网络取消的迟到响应测试。 */
async function snapshotA(base) {
  const list = await (await fetch(`${base}/api/projects`)).json();
  const query = new URLSearchParams({ project: 'a', registry: list.registryRevision });
  const response = await fetch(`${base}/api/snapshot?${query}`);
  assert.equal(response.status, 200);
  return response.json();
}

/** 在真实浏览器中挂起一次指定项目读取，刻意不遵守AbortSignal以验证代次门禁。 */
async function holdNextProject(projectId, snapshot, rejectInstead = false) {
  await page.evaluate(({ projectId, snapshot, rejectInstead }) => {
    const original = window.fetch;
    window.__projectHeldStarted = false;
    let holdNext = true;
    window.__restoreProjectFetch = () => { window.fetch = original; };
    window.fetch = function heldProjectFetch(...args) {
      const url = typeof args[0] === 'string' ? new URL(args[0], location.href) : null;
      if (holdNext && url?.pathname === '/api/snapshot' && url.searchParams.get('project') === projectId) {
        holdNext = false;
        window.__projectHeldStarted = true;
        return new Promise((resolve, reject) => {
          window.__releaseProjectResponse = () => rejectInstead
            ? reject(new TypeError('dedicated late failure fixture'))
            : resolve(new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });
      }
      return original.apply(window, args);
    };
  }, { projectId, snapshot, rejectInstead });
}

/** 释放自有迟到响应并恢复原生fetch；不修改产品脚本或真实项目。 */
async function releaseProjectResponse() {
  await page.evaluate(() => { window.__releaseProjectResponse(); window.__restoreProjectFetch(); });
  await page.waitForTimeout(250);
}

try {
  await mkdir(output, { recursive: true });
  fixtureA = await createReaderFixture({ name: '项目A', wal: true, works: [
    { key: 'SHARED', title: 'A的共享任务', status: 'completed' },
    { key: 'A-ONLY', title: '仅A任务', status: 'ready' },
  ] });
  fixtureB = await createReaderFixture({ name: '项目B', wal: true, works: [
    { key: 'SHARED', title: 'B的共享任务', status: 'in_progress' },
  ] });
  registryDirectory = await mkdtemp(path.join(os.tmpdir(), 'awr-project-selection-browser-'));
  registryPath = path.join(registryDirectory, 'projects.json');
  config = { version: 1, defaultProjectId: 'a', projects: [
    { id: 'a', name: '项目A', root: fixtureA.root },
    { id: 'b', name: '项目B', root: fixtureB.root },
    { id: 'broken', name: '不可用项目', root: path.join(registryDirectory, 'missing-project') },
  ] };
  await saveRegistry();
  server = createDashboardServer({ registryPath, snapshotReader: fixtureSnapshot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 2300, height: 1308 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/projects') listResponses += 1; });
  await page.goto(`${base}/#view=graph`);
  const select = page.getByTestId('project-select');
  await expect(select).toHaveValue('a');
  await expect(page.locator('[data-node-key]')).toHaveCount(2);
  await expect(page.getByTestId('project-name')).toHaveText('项目A');
  await expect(select.locator('option[value="broken"]')).toHaveCount(1);
  assert.equal(reads.b, 0);
  assert.equal(reads.other, 0);
  passed('启动显示全部登记条目，默认A，未选择项目不读数据库或假报可用');

  await page.locator('[data-node-key="SHARED"]').click();
  await page.locator('[data-filter="completed"]').click();
  await page.mouse.move(500, 200);
  await page.mouse.wheel(0, -200);
  await select.selectOption('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  await expect(page.locator('[data-node-key]')).toHaveCount(1);
  await expect(page.getByTestId('detail-panel')).not.toContainText('A的共享任务');
  await expect(page.locator('[data-node-key="SHARED"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-filter="completed"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('completion-label')).toContainText('0 / 1');
  await expect(page.getByTestId('graph-world')).toHaveAttribute('data-scale', '1');
  passed('同名任务不串详情、筛选、计数与视口，切换后重新适应宽度');

  await page.reload();
  await expect(select).toHaveValue('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  const otherPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  otherPage.on('pageerror', error => pageErrors.push(error.message));
  await otherPage.goto(`${base}/#view=graph`);
  await expect(otherPage.getByTestId('project-select')).toHaveValue('a');
  await expect(otherPage.getByTestId('project-name')).toHaveText('项目A');
  await expect(select).toHaveValue('b');
  await otherPage.close();
  passed('刷新保留本页B，新页面默认A，标签页选择互不影响');

  await page.getByTestId('pause-button').click();
  const beforeManualSwitch = reads.a;
  await select.selectOption('a');
  await expect(page.getByTestId('project-name')).toHaveText('项目A');
  await expect(page.locator('[data-node-key]')).toHaveCount(2);
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  assert.equal(reads.a, beforeManualSwitch + 1);
  const pausedReads = { ...reads };
  const oldListResponses = listResponses;
  await page.waitForTimeout(5400);
  assert.deepEqual(reads, pausedReads);
  assert.ok(listResponses > oldListResponses);
  passed('暂停手动切换只读取一次，随后不读图但项目名单继续更新');

  const c = { id: 'c', name: '项目C', root: path.join(registryDirectory, 'another-missing-project') };
  config.projects.push(c);
  config.projects.find(project => project.id === 'b').name = '项目B更名';
  await saveRegistry();
  await expect(select.locator('option[value="c"]')).toHaveCount(1, { timeout: 7500 });
  await expect(select.locator('option[value="b"]')).toContainText('项目B更名');
  assert.deepEqual(reads, pausedReads);
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  passed('暂停期间新增与改名热更新，无需重启且不读取任何项目数据');

  config.projects = config.projects.filter(project => project.id !== 'a');
  await saveRegistry();
  await expect(select).toHaveValue('', { timeout: 7500 });
  await expect(page.locator('[data-node-key]')).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).toContainText(/移除|取消登记|选择/);
  await page.reload();
  await expect(select).toHaveValue('');
  await expect(page.locator('[data-node-key]')).toHaveCount(0);
  config.projects.unshift({ id: 'a', name: '项目A', root: fixtureA.root });
  await saveRegistry();
  await expect(select.locator('option[value="a"]')).toHaveCount(1, { timeout: 7500 });
  await expect(select).toHaveValue('');
  await expect(page.locator('[data-node-key]')).toHaveCount(0);
  passed('当前项目移除清空画面，刷新保留空选择，条目重现不自动选回');

  await select.selectOption('broken');
  await expect(page.getByTestId('failure-banner')).toBeVisible();
  await expect(page.locator('[data-node-key]')).toHaveCount(0);
  await expect(select.locator('option[value="broken"]')).toContainText(/失败|不可用/);
  await select.selectOption('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  await expect(page.locator('[data-node-key]')).toHaveCount(1);
  await expect(page.getByTestId('failure-banner')).toHaveCount(0);
  passed('坏项目仍登记，切换失败显示自己的空态，不影响B正常读取');

  const oldA = await snapshotA(base);
  oldA.nodes.find(node => node.key === 'SHARED').title = '第一次A迟到旧内容';
  await holdNextProject('a', oldA);
  await select.selectOption('a');
  await expect.poll(() => page.evaluate(() => window.__projectHeldStarted)).toBe(true);
  await select.selectOption('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  updateFixtureWork(fixtureA, 'SHARED', { title: '第二次A最新内容' });
  await select.selectOption('a');
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('第二次A最新内容');
  await releaseProjectResponse();
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('第二次A最新内容');
  assert.ok(!(await page.locator('body').innerText()).includes('第一次A迟到旧内容'));
  passed('A至B至A时忽略取消的第一次A迟到成功不能覆盖最新A');

  await holdNextProject('b', oldA, true);
  await select.selectOption('b');
  await expect.poll(() => page.evaluate(() => window.__projectHeldStarted)).toBe(true);
  await select.selectOption('a');
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('第二次A最新内容');
  await releaseProjectResponse();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveText('项目A');
  passed('迟到失败与结束清理不能污染新项目或清除新读取状态');

  const beforeRegistryFailure = await snapshotA(base);
  beforeRegistryFailure.nodes.find(node => node.key === 'SHARED').title = '清单损坏前迟到响应';
  await holdNextProject('a', beforeRegistryFailure);
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect.poll(() => page.evaluate(() => window.__projectHeldStarted)).toBe(true);
  await writeFile(registryPath, '{dedicated malformed registry');
  await expect(page.getByTestId('project-list-banner')).toContainText(/失败|无效|无法|过期/, { timeout: 7500 });
  await expect(select).toBeDisabled();
  const readsWhileInvalid = { ...reads };
  await page.waitForTimeout(5300);
  assert.deepEqual(reads, readsWhileInvalid);
  const denied = await fetch(`${base}/api/snapshot?${new URLSearchParams({
    project: 'a', registry: beforeRegistryFailure.registryRevision,
  })}`);
  assert.equal(denied.status, 503);
  updateFixtureWork(fixtureA, 'SHARED', { title: '清单恢复后新内容' });
  await saveRegistry();
  await expect(select).toBeEnabled({ timeout: 7500 });
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('清单恢复后新内容', { timeout: 7500 });
  await releaseProjectResponse();
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('清单恢复后新内容');
  await expect(select).toHaveValue('a');
  passed('清单损坏全服务停读且旧画面标过期，同字节修复后旧响应仍无效');

  await page.getByTestId('pause-button').click();
  await writeFile(registryPath, '{dedicated malformed registry');
  await expect(select).toBeDisabled({ timeout: 7500 });
  const recoveryPausedReads = { ...reads };
  await saveRegistry();
  await expect(select).toBeEnabled({ timeout: 7500 });
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  assert.deepEqual(reads, recoveryPausedReads);
  await page.getByTestId('pause-button').click();
  await expect(page.locator('[data-node-key="SHARED"]')).toContainText('清单恢复后新内容');
  passed('清单修复保留暂停状态，不偷偷恢复项目读取');

  const mismatched = await snapshotA(base);
  mismatched.selectedProjectId = 'b';
  await page.route('**/api/snapshot?*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(mismatched),
  }));
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toBeVisible();
  await expect(page.getByTestId('project-name')).toHaveText('项目A');
  await page.unroute('**/api/snapshot?*');
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0);
  passed('响应登记身份不匹配时拒绝提交，不冒充所选项目');

  config.projects.find(project => project.id === 'c').name = '<img src=x onerror="window.__registryUnsafe=1">项目C';
  await saveRegistry();
  await expect(select.locator('option[value="c"]')).toContainText('项目C', { timeout: 7500 });
  assert.equal(await page.locator('.toolbar img').count(), 0);
  assert.equal(await page.evaluate(() => window.__registryUnsafe), undefined);
  passed('登记名称只以纯文本显示，不创建或执行来源标签');

  await page.locator('[data-node-key="SHARED"]').click();
  await page.locator('[data-filter="completed"]').click();
  await page.getByTestId('actual-button').click();
  await page.mouse.move(500, 200);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => Number(await page.getByTestId('graph-world').getAttribute('data-scale'))).toBeGreaterThan(1);
  const manualTransform = await page.getByTestId('graph-world').getAttribute('style');
  config.projects.find(project => project.id === 'c').name = '项目C改名';
  await saveRegistry();
  await expect(select.locator('option[value="c"]')).toContainText('项目C改名', { timeout: 7500 });
  await expect(page.getByTestId('project-list-banner')).toBeHidden({ timeout: 7500 });
  await expect(page.locator('[data-node-key="SHARED"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-filter="completed"]')).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await page.getByTestId('graph-world').getAttribute('style'), manualTransform);
  passed('同一真实项目的普通名单改名不额外重置任务选择、筛选与手工视口');

  await page.getByTestId('pause-button').click();
  const rootChangePausedReads = { ...reads };
  const remapped = config.projects.find(project => project.id === 'a');
  remapped.root = fixtureB.root;
  remapped.name = '同一标识改为项目B';
  await saveRegistry();
  await expect(select.locator('option[value="a"]')).toContainText('同一标识改为项目B', { timeout: 7500 });
  await expect(page.getByTestId('project-list-banner')).toContainText('过期');
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  assert.deepEqual(reads, rootChangePausedReads);
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  await expect(page.locator('[data-node-key]')).toHaveCount(1);
  await expect(page.locator('[data-node-key="SHARED"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-filter="completed"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('graph-world')).toHaveAttribute('data-scale', '1');
  await expect(page.getByTestId('detail-panel')).not.toContainText('清单恢复后新内容');
  passed('同登记标识与相同数据库标识改真实根后重置全部项目视图，关闭PS-001');

  config = { version: 1, defaultProjectId: null, projects: [] };
  await saveRegistry();
  await expect(select).toHaveValue('', { timeout: 7500 });
  await expect(page.locator('[data-node-key]')).toHaveCount(0);
  await expect(page.getByTestId('empty-state')).toContainText(/登记|选择/);
  config = { version: 1, defaultProjectId: 'a', projects: [
    { id: 'a', name: '项目A', root: fixtureA.root },
    { id: 'b', name: '项目B', root: fixtureB.root },
  ] };
  await saveRegistry();
  await expect(select.locator('option[value="b"]')).toHaveCount(1, { timeout: 7500 });
  await expect(select).toHaveValue('');
  await select.selectOption('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B');
  passed('空清单显示真实空态，重新登记不会自动改变本页空选择');

  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(select).toBeVisible();
  await page.screenshot({ path: path.join(output, 'project-selection-1366.png') });
  await page.setViewportSize({ width: 2300, height: 1308 });
  await page.screenshot({ path: path.join(output, 'project-selection-2300.png') });
  passed('两种视口项目选择与依赖图可用，保存独立演示截图');

  // 停止浏览器轮询后，再核对产品读取没有改变两个夹具的任何源或数据库文件。
  await browser.close();
  browser = null;
  const beforeA = await fixtureFileBaseline(fixtureA.root);
  const beforeB = await fixtureFileBaseline(fixtureB.root);
  await snapshotA(base);
  const list = await (await fetch(`${base}/api/projects`)).json();
  const query = new URLSearchParams({ project: 'b', registry: list.registryRevision });
  assert.equal((await fetch(`${base}/api/snapshot?${query}`)).status, 200);
  assert.deepEqual(await fixtureFileBaseline(fixtureA.root), beforeA);
  assert.deepEqual(await fixtureFileBaseline(fixtureB.root), beforeB);
  passed('双项目稳定副本读取前后全部文件字节和元数据不变');
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failure = { name: error.name, message: String(error.message).slice(0, 1000) };
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (fixtureA) await fixtureA.dispose();
  if (fixtureB) await fixtureB.dispose();
  if (registryDirectory) {
    // 清理只接受本脚本mkdtemp创建的完整绝对目标，不用登记root或请求参数。
    assert.equal(path.dirname(registryDirectory), os.tmpdir());
    assert.ok(path.basename(registryDirectory).startsWith('awr-project-selection-browser-'));
    await rm(registryDirectory, { recursive: true, force: true });
  }
  await mkdir(output, { recursive: true });
  const report = { passed: failure === null, verifiedAt: Date.now(), checks, checkCount: checks.length,
    reads, listResponses, pageErrors, failure,
    boundary: '所有写入与故障注入只发生在专用临时夹具；不读取真实项目数据库连接，不覆盖DASH-001历史证据。' };
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: report.passed, checkCount: checks.length, pageErrors: pageErrors.length }));
}
