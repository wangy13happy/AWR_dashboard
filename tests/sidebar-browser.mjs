import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createVisualFixture } from './visual-fixture.mjs';
import { createReaderFixture, updateFixtureWork, fixtureFileBaseline } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = path.join(root, 'verification/background-startup');
// 专项默认每次新建带毫秒的目录；全量验收也可指定本项目下的独立子目录。
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR
  ?? `verification/background-startup/ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const relativeOutput = path.relative(evidenceRoot, output);
assert.ok(relativeOutput !== '' && !relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), '侧栏证据仅写本项目独立目录');
const checks = [];
const measurements = [];
const pageErrors = [];
const screenshots = [];
const reads = { a: 0, b: 0 };
let fixtureA, fixtureB, registryDirectory, server, browser, page;

/** 专用夹具仍经过真实只读数据链路；演示标记明确区分测试与业务状态。 */
async function fixtureSnapshot(projectRoot) {
  const id = path.normalize(projectRoot) === path.normalize(fixtureA.root) ? 'a' : 'b';
  reads[id] += 1;
  const snapshot = await readSnapshot(projectRoot);
  snapshot.mode = 'demo';
  return snapshot;
}

/** 仅将实际完成的浏览器检查记入回执，不把未执行项计为通过。 */
function passed(name) {
  checks.push({ name, passed: true, verifiedAt: Date.now() });
  console.log(`通过：${name}`);
}

/** 捕捉真实计算样式、画布宽度与滚动尺寸，避免只检查样式源码常量。 */
async function measureLayout(label) {
  const value = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="detail-panel"]');
    const graph = document.querySelector('[data-testid="graph-viewport"]');
    const font = selector => Number.parseFloat(getComputedStyle(panel.querySelector(selector)).fontSize);
    return {
      viewportWidth: window.innerWidth, sidebarWidth: panel.getBoundingClientRect().width,
      graphWidth: graph.getBoundingClientRect().width, bodyWidth: document.body.getBoundingClientRect().width,
      documentScrollWidth: document.documentElement.scrollWidth,
      sidebarClientWidth: panel.clientWidth, sidebarScrollWidth: panel.scrollWidth,
      sidebarClientHeight: panel.clientHeight, sidebarScrollHeight: panel.scrollHeight,
      bodyFont: Number.parseFloat(getComputedStyle(panel).fontSize),
      bodyLineHeight: Number.parseFloat(getComputedStyle(panel).lineHeight),
      titleFont: font('.detail-title'), sectionFont: font('.detail-section h3'),
      dependencyFont: font('.dependency-chip'), evidenceFont: font('.evidence-list code'),
      metadataFont: font('.evidence-meta'), auxiliaryFont: font('.detail-note'), claimFont: font('.claim-details'),
    };
  });
  measurements.push({ label, ...value });
  return value;
}

/** 将正常参考和长文本布局截图写入本轮独立证据目录，保留全部历史验收。 */
async function capture(name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(output, filename) });
  screenshots.push(filename);
}

try {
  await mkdir(output, { recursive: true });
  fixtureA = await createVisualFixture();
  fixtureB = await createReaderFixture({ name: '项目B · 演示', wal: true,
    works: [{ key: 'ND-007', title: 'B的同名任务', status: 'completed' }] });
  registryDirectory = await mkdtemp(path.join(os.tmpdir(), 'awr-sidebar-browser-'));
  const registryPath = path.join(registryDirectory, 'projects.json');
  await writeFile(registryPath, JSON.stringify({ version: 1, defaultProjectId: 'a', projects: [
    { id: 'a', name: '视觉项目A', root: fixtureA.root }, { id: 'b', name: '项目B', root: fixtureB.root },
  ] }));
  server = createDashboardServer({ registryPath, snapshotReader: fixtureSnapshot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 2300, height: 1308 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base);
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await page.locator('[data-node-key="ND-007"]').click();
  await expect(page.getByTestId('detail-panel')).toContainText('景区商圈车辆到访分析');
  await expect(page.getByTestId('demo-badge')).toBeVisible();

  for (const viewport of [{ width: 2300, height: 1308 }, { width: 1366, height: 768 },
    { width: 1024, height: 768 }, { width: 960, height: 720 }]) {
    await page.setViewportSize(viewport);
    // 待尺寸观察完成后测量；图仍由原适应宽度逻辑调整，不改拓扑或交互。
    await page.getByTestId('fit-button').click();
    const value = await measureLayout(`${viewport.width}x${viewport.height}`);
    const expectedSidebar = viewport.width > 1000 ? Math.min(460, Math.max(360, viewport.width * .26)) : Math.min(320, viewport.width * .4);
    assert.ok(Math.abs(value.sidebarWidth - expectedSidebar) < 1);
    assert.equal(value.documentScrollWidth, viewport.width);
    assert.equal(value.bodyWidth, viewport.width);
    assert.ok(value.sidebarScrollWidth <= value.sidebarClientWidth);
    assert.ok(value.graphWidth >= (viewport.width === 2300 ? 1840 : viewport.width === 1366 ? 1000 : 640));
    assert.deepEqual([value.bodyFont, value.bodyLineHeight, value.titleFont, value.sectionFont,
      value.dependencyFont, value.evidenceFont, value.metadataFont, value.auxiliaryFont, value.claimFont],
    [14, 24, 18, 13, 13, 13, 12, 12, 12]);
    await capture(`sidebar-layout-${viewport.width}`);
    passed(`${viewport.width}×${viewport.height}实测侧栏${value.sidebarWidth}px、正文14px/24px且画布和页面无横向溢出`);
  }

  const longLocator = `analysis/演示专用/${'long-readable-fixture-filename-'.repeat(35)}.md`;
  updateFixtureWork(fixtureA, 'ND-007', {
    title: '景区商圈车辆到访分析：长标题和详情换行专用演示',
    summary: `${'长说明应保持完整可读，不隐藏正文，不影响左侧依赖图。'.repeat(18)}\n仅为临时测试夹具，不代表真实项目状态。`,
    next_action: `${'说明正文可以连续换行阅读，长文字不能扩大侧栏或产生横向滚动。'.repeat(12)}\n下一步：滚动查看末尾登记证据和只读提示。`,
    acceptance: Array.from({ length: 10 }, (_, index) => `验收${index + 1}：${'长验收文字仅用于可读性测试。'.repeat(8)}`),
  });
  fixtureA.db.prepare('UPDATE evidence SET locator=?,summary=?,sha256=? WHERE work_item_id=?').run(
    longLocator, '登记元数据应以12像素展示并可完整换行。'.repeat(8), `sha256:${'a'.repeat(64)}`, fixtureA.workIds.get('ND-007'));
  await page.getByTestId('pause-button').click();
  await page.getByTestId('pause-button').click();
  await expect(page.getByTestId('detail-panel')).toContainText('长标题和详情换行专用演示');
  await page.getByTestId('pause-button').click();
  // 完成夹具注入后再取基线；之后所有产品读取均不得改变任一夹具数据库和权威文件。
  const baselineA = await fixtureFileBaseline(fixtureA.root);
  const baselineB = await fixtureFileBaseline(fixtureB.root);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 960, height: 720 }]) {
    await page.setViewportSize(viewport);
    const panel = page.getByTestId('detail-panel');
    await panel.evaluate(element => { element.scrollTop = 0; });
    const value = await measureLayout(`long-text-${viewport.width}`);
    assert.equal(value.documentScrollWidth, viewport.width);
    assert.ok(value.sidebarScrollWidth <= value.sidebarClientWidth);
    assert.ok(value.sidebarScrollHeight > value.sidebarClientHeight * 2);
    const summary = panel.locator('.detail-section').filter({ has: page.getByRole('heading', { name: '摘要', exact: true }) }).locator('p');
    assert.ok(await summary.evaluate(element => element.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(element).lineHeight) * 2));
    const evidence = panel.locator('.evidence-list code').first();
    assert.equal(await evidence.textContent(), longLocator);
    assert.ok(await evidence.evaluate(element => element.getClientRects().length > 2));
    await capture(`sidebar-long-text-${viewport.width}-top`);
    const graphTransform = await page.getByTestId('graph-world').getAttribute('style');
    const bounds = await panel.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60);
    await page.mouse.wheel(0, 3000);
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    assert.equal(await page.getByTestId('graph-world').getAttribute('style'), graphTransform);
    await panel.locator('.detail-note').scrollIntoViewIfNeeded();
    await expect(panel.locator('.detail-note')).toBeVisible();
    const finalScroll = await panel.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }));
    assert.ok(finalScroll.top + finalScroll.height >= finalScroll.total - 2);
    await capture(`sidebar-long-text-${viewport.width}-bottom`);
    passed(`${viewport.width}宽长说明和不间断证据定位符换行完整，侧栏滚轮不动图且末尾提示可达`);
  }

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.locator('[data-filter="completed"]').click();
  await page.getByTestId('actual-button').click();
  await page.mouse.move(400, 200);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => Number(await page.getByTestId('graph-world').getAttribute('data-scale'))).toBeGreaterThan(1);
  const beforeSwitch = reads.b;
  await page.getByTestId('project-select').selectOption('b');
  await expect(page.getByTestId('project-name')).toHaveText('项目B · 演示');
  await expect(page.locator('[data-node-key]')).toHaveCount(1);
  await expect(page.getByTestId('detail-panel')).toContainText('点击任务查看详情');
  await expect(page.getByTestId('detail-panel')).not.toContainText('长标题和详情换行专用演示');
  await expect(page.locator('[data-filter="completed"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('graph-world')).toHaveAttribute('data-scale', '1');
  await expect(page.getByTestId('pause-banner')).toBeVisible();
  assert.equal(reads.b, beforeSwitch + 1);
  await page.locator('[data-node-key="ND-007"]').click();
  await expect(page.getByTestId('detail-panel')).toContainText('B的同名任务');
  passed('扩大侧栏仍保留暂停切换只读一次，同名项目任务不串详情并清空筛选与手动视口');

  await page.reload();
  await expect(page.getByTestId('project-select')).toHaveValue('b');
  await expect(page.getByTestId('detail-panel')).toContainText('点击任务查看详情');
  const otherPage = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  otherPage.on('pageerror', error => pageErrors.push(error.message));
  await otherPage.goto(base);
  await expect(otherPage.getByTestId('project-select')).toHaveValue('a');
  await expect(otherPage.locator('[data-node-key]')).toHaveCount(23);
  await expect(page.getByTestId('project-select')).toHaveValue('b');
  await otherPage.close();
  passed('刷新保留当前标签页所选项目，新标签页仍独立使用默认项目');

  assert.deepEqual(await fixtureFileBaseline(fixtureA.root), baselineA);
  assert.deepEqual(await fixtureFileBaseline(fixtureB.root), baselineB);
  assert.deepEqual(pageErrors, []);
  passed('页面所有读取未修改夹具数据库或权威文件，浏览器无未处理错误');
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify({
    passed: true, checks, checkCount: checks.length, measurements, pageErrors, screenshots,
    browserVersion: browser.version(), note: '真实本机Chrome无头浏览器检查；所有数据注入仅发生在专用临时夹具，不修改任何已登记真实项目。',
  }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, checkCount: checks.length, pageErrors, output }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify({ passed: false, checks, pageErrors,
    measurements, screenshots, error: { name: error.name, message: error.message } }, null, 2)}\n`).catch(() => {});
} finally {
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixtureA) await fixtureA.dispose();
  if (fixtureB) await fixtureB.dispose();
  // 只删除本轮自建的登记夹具；路径和前缀必须匹配临时目录，不能接收外部项目路径。
  if (registryDirectory) {
    assert.equal(path.dirname(registryDirectory), os.tmpdir());
    assert.ok(path.basename(registryDirectory).startsWith('awr-sidebar-browser-'));
    await rm(registryDirectory, { recursive: true, force: true });
  }
}
