import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { DashboardError } from '../src/safety.js';
import { updateFixtureWork, fixtureId } from './reader-fixture.mjs';
import { createVisualFixture } from './visual-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// 扩展验收可把原功能回归写入独立目录，保留已经交付的历史截图和回执。
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR ?? 'verification');
assert.ok(path.relative(path.join(root, 'verification'), output) === ''
  || (!path.relative(path.join(root, 'verification'), output).startsWith('..')
    && !path.isAbsolute(path.relative(path.join(root, 'verification'), output))), '验收输出必须位于本项目verification内');
const checks = [];
let server;
let browser;
let fixture;
let readCalls = 0;
let failReads = false;

/** 测试专用数据提供者明确标记演示；正式服务不接受此模式切换或故障参数。 */
async function fixtureSnapshot(projectRoot) {
  readCalls += 1;
  if (failReads) throw new DashboardError('SNAPSHOT_UNAVAILABLE', '', true);
  const snapshot = await readSnapshot(projectRoot);
  snapshot.mode = 'demo';
  return snapshot;
}

/** 仅启动专用夹具的随机本地端口；也用于验证服务停止后在同端口恢复。 */
async function listenFixture(port = 0) {
  const next = createDashboardServer({ projectRoot: fixture.root, snapshotReader: fixtureSnapshot });
  await new Promise((resolve, reject) => { next.once('error', reject); next.listen(port, '127.0.0.1', resolve); });
  return next;
}

/** 关闭本测试拥有的服务及连接，不触碰真实项目预览进程。 */
async function closeFixtureServer(value) {
  if (!value?.listening) return;
  value.closeAllConnections();
  await new Promise(resolve => value.close(resolve));
}

/** 将已经实际完成的检查记入有界测试结果，不输出夹具或业务正文。 */
function passed(name) {
  checks.push({ name, passed: true });
  console.log(`通过：${name}`);
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createVisualFixture();
  server = await listenFixture();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 2300, height: 1308 }, timezoneId: 'Asia/Shanghai' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await expect(page.getByTestId('demo-badge')).toBeVisible();
  await expect(page.getByTestId('completion-label')).toContainText('6 / 22');
  assert.equal(await page.locator('[data-count="continuable"]').textContent(), '7');
  assert.equal(await page.locator('[data-count="ready"]').textContent(), '5');
  assert.equal(await page.locator('[data-count="waiting"]').textContent(), '4');
  passed('参考规模23节点、来源完成6/22、分类7/5/4和常驻演示标记');

  const scene = page.getByTestId('graph-world');
  const selected = page.locator('[data-node-key="ND-007"]');
  await selected.click();
  await expect(page.getByTestId('detail-panel')).toContainText('景区商圈车辆到访分析');
  await expect(page.getByTestId('detail-panel')).toContainText('outputs/07_scenic_vehicles/素材分析.md');
  assert.doesNotMatch(await page.locator('body').innerText(), /undefined/);
  const sidebar = await page.getByTestId('detail-panel').boundingBox();
  assert.ok(sidebar.width >= 459 && sidebar.width <= 460);
  await page.screenshot({ path: path.join(output, 'reference-layout-2300.png') });
  passed('2300×1308结构、固定右栏、选择详情、证据纯文本和截图');

  await page.locator('[data-filter="ready"]').click();
  await expect(page.locator('[data-node-key="ND-002"]')).toHaveClass(/is-dimmed/);
  await expect(page.getByTestId('completion-label')).toContainText('6 / 22');
  await page.locator('[data-filter="ready"]').click();
  await expect(page.locator('[data-node-key="ND-002"]')).not.toHaveClass(/is-dimmed/);
  await page.locator('[data-testid="adjacent-node"][data-select-key="ND-012"]').first().click();
  await expect(page.getByTestId('detail-panel')).toContainText('报告指标口径表');
  await selected.click();
  passed('筛选保留拓扑与总进度，邻接点击定位和详情联动');

  await page.getByTestId('actual-button').click();
  assert.equal(Number(await scene.getAttribute('data-scale')), 1);
  await page.mouse.move(500, 200);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => Number(await scene.getAttribute('data-scale'))).toBeGreaterThan(1);
  const beforePan = await scene.getAttribute('style');
  await page.mouse.move(50, 160);
  await page.mouse.down();
  await page.mouse.move(100, 210, { steps: 5 });
  await page.mouse.up();
  assert.notEqual(await scene.getAttribute('style'), beforePan);
  await page.getByTestId('fit-button').click();
  passed('滚轮缩放、拖动平移、适应宽度和1:1');

  const transform = await scene.getAttribute('style');
  const updateStarted = Date.now();
  updateFixtureWork(fixture, 'ND-002', { status: 'completed', raw_status: 'completed' });
  await expect(page.locator('[data-node-key="ND-002"]')).toHaveClass(/status-completed/, { timeout: 7500 });
  const observedRefreshMs = Date.now() - updateStarted;
  assert.equal(await scene.getAttribute('style'), transform);
  await expect(page.getByTestId('detail-panel')).toContainText('ND-007');
  passed('实际日志提交在下一轮询显示新状态，视口和所选任务不跳动');

  const edge = fixture.db.prepare('SELECT * FROM edges LIMIT 1').get();
  const oldEdges = await page.locator('.dependency-edge').count();
  fixture.db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    fixtureId(9900), fixture.projectId, 'work_item', 'ND-014', 'depends_on', 'work_item', 'ND-009', 0,
    edge.source_id, edge.source_ref_json, edge.source_revision, 1, 1);
  fixture.db.prepare('UPDATE projects SET project_revision=project_revision+1').run();
  await expect(page.locator('.dependency-edge')).toHaveCount(oldEdges + 1, { timeout: 7500 });
  passed('新增依赖下一轮显示，可选连线不会改变必要就绪闭包');

  // 认领到期不增加项目修订；页面必须重新评估，不能只根据revision跳过更新。
  const revisionBeforeExpiry = fixture.db.prepare('SELECT project_revision FROM projects').get().project_revision;
  fixture.db.prepare('UPDATE claims SET expires_at=? WHERE work_item_id=?').run(Date.now() + 500, fixture.workIds.get('ND-006'));
  await expect(page.locator('[data-node-key="ND-006"]')).toHaveClass(/is-ready/, { timeout: 7500 });
  assert.equal(fixture.db.prepare('SELECT project_revision FROM projects').get().project_revision, revisionBeforeExpiry);
  passed('修订未变时认领到期仍刷新派生就绪状态');

  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  const pausedReads = readCalls;
  updateFixtureWork(fixture, 'ND-003', { status: 'completed', raw_status: 'completed' });
  await page.waitForTimeout(5350);
  assert.equal(readCalls, pausedReads);
  await expect(page.locator('[data-node-key="ND-003"]')).toHaveClass(/status-in_progress/);
  await page.getByTestId('pause-button').click();
  await expect(page.locator('[data-node-key="ND-003"]')).toHaveClass(/status-completed/, { timeout: 2500 });
  passed('暂停期间不读取且画面不变，恢复立即显示夹具新状态');

  failReads = true;
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toBeVisible();
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await expect(page.getByTestId('failure-banner')).toContainText('旧数据');
  failReads = false;
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0, { timeout: 2500 });
  passed('503保留旧图并标示旧数据，恢复后清除连接错误');

  const invalidResponse = 'unparseable fixture response which must not be echoed';
  await page.route('**/api/snapshot', route => route.fulfill({ status: 200, contentType: 'application/json', body: invalidResponse }));
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toContainText('服务响应格式无效');
  assert.ok(!(await page.locator('body').innerText()).includes(invalidResponse));
  await page.unroute('**/api/snapshot');
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0, { timeout: 2500 });
  passed('非JSON响应不回显解析正文，不替换最后成功图');

  // 真实浏览器挂起网络请求，检验产品自己的5秒超时，而非测试主动制造错误提示。
  const heldRoutes = [];
  await page.route('**/api/snapshot', route => { heldRoutes.push(route); });
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect.poll(() => heldRoutes.length).toBe(1);
  await page.waitForTimeout(750);
  assert.equal(heldRoutes.length, 1);
  await expect(page.getByTestId('failure-banner')).toContainText('读取超时', { timeout: 6500 });
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await expect(page.getByTestId('failure-banner')).toContainText('旧数据');
  await page.getByTestId('pause-button').click();
  await page.unroute('**/api/snapshot');
  await Promise.all(heldRoutes.map(route => route.abort().catch(() => {})));
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0, { timeout: 2500 });
  passed('真实挂起请求5秒超时，单飞读取保留旧图并可立即恢复');

  // 专用夹具故意让一次fetch忽略AbortSignal，使序号门禁必须真正拒绝迟到成功响应。
  const oldSnapshot = await fixtureSnapshot(fixture.root);
  oldSnapshot.nodes.find(node => node.key === 'ND-007').title = '暂停前迟到快照';
  await page.evaluate(snapshot => {
    const original = window.fetch;
    let holdNext = true;
    window.__restoreFixtureFetch = () => { window.fetch = original; };
    window.fetch = function heldFixtureFetch(...args) {
      if (holdNext && args[0] === '/api/snapshot') {
        holdNext = false;
        window.__heldFixtureStarted = true;
        return new Promise(resolve => {
          window.__releaseFixtureResponse = () => resolve(new Response(JSON.stringify(snapshot), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        });
      }
      return original.apply(window, args);
    };
  }, oldSnapshot);
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect.poll(() => page.evaluate(() => window.__heldFixtureStarted === true)).toBe(true);
  await page.getByTestId('pause-button').click();
  updateFixtureWork(fixture, 'ND-007', { title: '恢复后的最新夹具状态' });
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('恢复后的最新夹具状态', { timeout: 2500 });
  await page.evaluate(() => { window.__releaseFixtureResponse(); window.__restoreFixtureFetch(); });
  await page.waitForTimeout(350);
  await expect(page.getByTestId('detail-panel')).toContainText('恢复后的最新夹具状态');
  assert.ok(!(await page.locator('body').innerText()).includes('暂停前迟到快照'));
  updateFixtureWork(fixture, 'ND-007', { title: '景区商圈车辆到访分析' });
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('景区商圈车辆到访分析');
  passed('忽略取消的暂停前迟到成功响应不能覆盖恢复后的新快照');

  // 在真实浏览器分派缓存恢复生命周期事件；不把受控事件称为缓存命中率验收。
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const hiddenReads = readCalls;
  updateFixtureWork(fixture, 'ND-007', { title: '缓存恢复后立即更新' });
  await page.waitForTimeout(5350);
  assert.equal(readCalls, hiddenReads);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByTestId('detail-panel')).toContainText('缓存恢复后立即更新', { timeout: 2500 });
  updateFixtureWork(fixture, 'ND-007', { title: '缓存恢复后继续轮询' });
  await expect(page.getByTestId('detail-panel')).toContainText('缓存恢复后继续轮询', { timeout: 7500 });
  await page.getByTestId('pause-button').click();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const restoredPausedReads = readCalls;
  await page.waitForTimeout(750);
  assert.equal(readCalls, restoredPausedReads);
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  await page.getByTestId('fit-button').click();
  const scaleBeforeResize = await scene.getAttribute('data-scale');
  await page.setViewportSize({ width: 2100, height: 1308 });
  await expect.poll(() => scene.getAttribute('data-scale')).not.toBe(scaleBeforeResize);
  await page.setViewportSize({ width: 2300, height: 1308 });
  updateFixtureWork(fixture, 'ND-007', { title: '景区商圈车辆到访分析' });
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('景区商圈车辆到访分析');
  passed('受控缓存恢复重启即时读取与轮询，保留暂停选择并恢复尺寸观察');

  // 只有测试夹具中的纯文本含HTML；浏览器不能执行这些来源字符。
  updateFixtureWork(fixture, 'ND-007', { title: '<img src=x onerror="window.__unsafeExecuted=1">纯文本样本' });
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('<img src=x');
  assert.equal(await page.evaluate(() => window.__unsafeExecuted), undefined);
  assert.equal(await page.getByTestId('detail-panel').locator('img').count(), 0);
  updateFixtureWork(fixture, 'ND-007', { title: '景区商圈车辆到访分析' });
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('景区商圈车辆到访分析');
  passed('来源HTML纯文本显示，没有执行或创建来源图片元素');

  await closeFixtureServer(server);
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toContainText('连接', { timeout: 2500 });
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  server = await listenFixture(port);
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('failure-banner')).toHaveCount(0, { timeout: 2500 });
  passed('服务实际停止显示失联和旧图，同端口恢复可继续读取');

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByTestId('fit-button').scrollIntoViewIfNeeded();
  await page.getByTestId('fit-button').click();
  await expect(page.getByTestId('detail-panel')).toBeVisible();
  assert.ok((await page.getByTestId('detail-panel').boundingBox()).width >= 360);
  assert.ok((await page.getByTestId('graph-viewport').boundingBox()).width > 900);
  await page.screenshot({ path: path.join(output, 'reference-layout-1366.png') });
  passed('1366×768保留右栏与画布，窄工具条可横向查看操作');

  assert.deepEqual(pageErrors, []);
  const report = { passed: true, checks, observedRefreshMs, browserVersion: browser.version(), pageErrors,
    note: '所有实时写入只在专用临时夹具；视觉截图常驻演示标记，不代表实际国庆项目状态。缓存恢复为真实浏览器受控生命周期事件，不声称实际前进后退缓存命中。' };
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, checkCount: checks.length, observedRefreshMs, unexpectedPageErrors: pageErrors.length }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await closeFixtureServer(server);
  if (fixture) await fixture.dispose();
}
