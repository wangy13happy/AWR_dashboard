import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createVisualFixture } from './visual-fixture.mjs';
import { fixtureFileBaseline, updateFixtureWork } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
// 重验使用新的专项目录，保留前一轮实际成功或失败回执；输出不能越出本任务证据区。
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR
  ?? path.join('verification/dashboard-panel-ui', baseline ? 'before' : 'after'));
const relativeOutput = path.relative(path.join(root, 'verification/dashboard-panel-ui'), output);
assert.ok(!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), '专项输出必须位于本任务证据目录');
const storageKey = 'awrDashboardDetailWidth';
const summaryText = '拉宽后每行应显示更多文字，说明保持完整并自然重排，不裁剪内容。'.repeat(30);
const locatorText = `analysis/${'long-readable-fixture-'.repeat(35)}.md`;
const report = { passed: false, baseline, startedAt: Date.now(), checks: [], measurements: [], screenshots: [], pageErrors: [] };
let fixture, server, browser, page;

/** 每个隔离上下文的新页面都收集运行异常，包含重载、持久化及拒绝存储测试页。 */
async function testContext(options) {
  const context = await browser.newContext(options);
  context.on('page', createdPage => createdPage.on('pageerror', error => report.pageErrors.push(error.message)));
  return context;
}

/** 只读测试自建的临时项目，测试数据始终明确标记演示。 */
async function snapshot(projectRoot) {
  const result = await readSnapshot(projectRoot);
  result.mode = 'demo';
  return result;
}

/** 每项检查在断言实际成功后才加入回执。 */
function passed(name) {
  report.checks.push({ name, passed: true, verifiedAt: Date.now() });
  console.log(`通过：${name}`);
}

/** 实测阅读空间、文本行数、顶栏字体和溢出，不用样式常量代替布局。 */
async function measure(label) {
  const value = await page.evaluate(() => {
    const panel = document.querySelector('#detail-panel');
    const summary = Array.from(panel.querySelectorAll('.detail-section')).find(section => section.querySelector('h3')?.textContent === '摘要').querySelector('p');
    const code = panel.querySelector('.evidence-list code');
    const font = selector => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return { viewport: innerWidth, panelWidth: panel.getBoundingClientRect().width,
      graphWidth: document.querySelector('#graph-viewport').getBoundingClientRect().width,
      pageScrollWidth: document.documentElement.scrollWidth, panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
      summaryHeight: summary.getBoundingClientRect().height, summaryText: summary.textContent,
      evidenceLines: code.getClientRects().length, evidenceText: code.textContent,
      toolbarHeight: document.querySelector('.toolbar').getBoundingClientRect().height,
      filterFont: font('.filter'), refreshFont: font('#refresh-label'), titleFont: font('.detail-title'), sectionFont: font('.detail-section h3') };
  });
  report.measurements.push({ label, ...value });
  assert.equal(value.summaryText, summaryText);
  assert.equal(value.evidenceText, locatorText);
  assert.equal(value.pageScrollWidth, value.viewport);
  assert.ok(value.panelScrollWidth <= value.panelClientWidth);
  return value;
}

/** 保留全页面截图，基线和修改后使用相同夹具与视口。 */
async function capture(name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(output, filename) });
  report.screenshots.push(filename);
}

/** 真实鼠标从独立拖柄开始拖动；捕获必须支持指针越过面板边界。 */
async function dragToWidth(width) {
  const handle = page.getByTestId('detail-resizer');
  const box = await handle.boundingBox();
  const current = await page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (current - width) / 2, box.y + 80, { steps: 6 });
  await expect.poll(() => page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(Math.round((current + width) / 2), 0);
  await page.mouse.move(box.x + box.width / 2 + current - width, box.y + 80, { steps: 12 });
  // 此处仍保持鼠标按下，确保实现连续调宽，而非仅在松手时改变尺寸。
  await expect.poll(() => page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(width, 0);
  await page.mouse.up();
  await expect.poll(() => page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width)).toBeCloseTo(width, 0);
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createVisualFixture();
  updateFixtureWork(fixture, 'ND-007', { title: '景区商圈车辆到访分析：长标题与可拖动详情栏重排演示', summary: summaryText });
  fixture.db.prepare('UPDATE evidence SET locator=? WHERE work_item_id=?').run(locatorText, fixture.workIds.get('ND-007'));
  const filesBefore = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({ projectRoot: fixture.root, snapshotReader: snapshot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port;
  assert.notEqual(report.port, 4317);
  const base = `http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browserVersion = browser.version();
  const context = await testContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  await page.goto(`${base}/#view=graph`);
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await page.locator('[data-node-key="ND-007"]').click();
  await expect(page.getByTestId('detail-panel')).toContainText(summaryText);
  for (const width of [2300, 1366, 960]) {
    await page.setViewportSize({ width, height: 900 });
    await measure(`default-${width}`);
    await capture(`default-${width}`);
  }
  if (!baseline) {
    await page.setViewportSize({ width: 1366, height: 900 });
    const defaults = await measure('initial-fonts');
    assert.equal(defaults.toolbarHeight, 60);
    assert.equal(defaults.filterFont, 14);
    assert.equal(defaults.refreshFont, 14);
    assert.equal(defaults.titleFont, 22);
    assert.equal(defaults.sectionFont, 15);
    passed('顶栏和字体放大、任务及分段标题强化，默认布局仍完整');
    await page.getByTestId('actual-button').click();
    const transform = await page.getByTestId('graph-world').getAttribute('style');
    await dragToWidth(320);
    const narrow = await measure('drag-narrow');
    await capture('drag-narrow');
    await dragToWidth(650);
    const wide = await measure('drag-wide');
    assert.ok(wide.summaryHeight < narrow.summaryHeight);
    assert.ok(wide.evidenceLines < narrow.evidenceLines);
    assert.equal(await page.getByTestId('graph-world').getAttribute('style'), transform);
    await capture('drag-wide');
    passed('真实鼠标连续调宽，长正文和无空格定位符行数减少且全文不变，手动图视口保持');

    // 超界拖动必须由实际捕获链钳制，不用直接写样式模拟用户操作。
    const handle = page.getByTestId('detail-resizer');
    let box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 80); await page.mouse.down();
    await page.mouse.move(0, box.y + 80, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width)).toBe(720);
    box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 80); await page.mouse.down();
    await page.mouse.move(1500, box.y + 80, { steps: 12 }); await page.mouse.up();
    await expect.poll(() => page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width)).toBe(320);
    await handle.evaluate(node => node.addEventListener('pointerdown', event => { window.__resizePointerId = event.pointerId; }, { once: true }));
    box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 80); await page.mouse.down();
    await page.mouse.move(box.x - 80, box.y + 80, { steps: 4 });
    await handle.evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__resizePointerId })));
    const cancelledWidth = await page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width);
    await page.mouse.move(50, box.y + 80); await page.mouse.up();
    assert.equal(await page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width), cancelledWidth);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-resizing-detail')), false);
    passed('最小320/最大720像素、越界指针捕获与取消后停止调宽');
    await dragToWidth(650);
    await handle.focus(); await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '666');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '650');
    passed('分隔柄可键盘微调，数值和可访问范围一致');
    await page.setViewportSize({ width: 960, height: 900 });
    // 视口设置回执先于浏览器resize事件，等待真实边界与布局应用后再测重排。
    await expect(handle).toHaveAttribute('aria-valuenow', '480');
    const limited = await measure('narrow-window-clamped');
    assert.equal(limited.panelWidth, 480); assert.ok(limited.graphWidth >= 480);
    await page.setViewportSize({ width: 2300, height: 900 });
    await expect(handle).toHaveAttribute('aria-valuenow', '650');
    passed('窗口变窄保留至少半窗画布，扩大后恢复用户650像素偏好');
    await page.reload();
    await expect(page.locator('[data-node-key]')).toHaveCount(23);
    assert.equal(await page.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width), 650);
    const sameContextPage = await context.newPage(); await sameContextPage.goto(`${base}/#view=graph`);
    await expect(sameContextPage.locator('[data-node-key]')).toHaveCount(23);
    assert.equal(await sameContextPage.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width), 650);
    await sameContextPage.close();
    const freshContext = await testContext({ viewport: { width: 1366, height: 900 } });
    const freshPage = await freshContext.newPage(); await freshPage.goto(`${base}/#view=graph`);
    await expect(freshPage.locator('[data-node-key]')).toHaveCount(23);
    assert.equal(await freshPage.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width), 360);
    await freshContext.close();
    passed('本地存储在重载及同上下文新页恢复宽度，独立浏览器上下文保持默认');

    // 极窄窗口生成的合法偏好低于普通最小值，重载仍应恢复，并在宽窗由当前边界钳制。
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(handle).toHaveAttribute('aria-valuemax', '350');
    await dragToWidth(280);
    await page.reload();
    await expect(page.locator('[data-node-key]')).toHaveCount(23);
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await page.setViewportSize({ width: 2300, height: 900 });
    await expect(handle).toHaveAttribute('aria-valuenow', '320');
    await dragToWidth(650);
    passed('700像素窄窗的280像素偏好重载可恢复，宽窗按320像素下限钳制');

    for (const value of ['not-a-number', 'Infinity', '-1', '0', '', '99999']) {
      const invalidContext = await testContext({ viewport: { width: 1366, height: 900 } });
      // 新页面先经过无来源的about:blank；只在本测试实际HTTP来源注入，避免夹具自身抛存储权限异常。
      await invalidContext.addInitScript(({ key, value, origin }) => {
        if (location.origin === origin) localStorage.setItem(key, value);
      }, { key: storageKey, value, origin: base });
      const invalidPage = await invalidContext.newPage(); await invalidPage.goto(`${base}/#view=graph`);
      await expect(invalidPage.locator('[data-node-key]')).toHaveCount(23);
      assert.equal(await invalidPage.getByTestId('detail-panel').evaluate(node => node.getBoundingClientRect().width), 360);
      await invalidContext.close();
    }
    const blockedContext = await testContext({ viewport: { width: 1366, height: 900 } });
    await blockedContext.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Denied', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError'); };
    });
    const primaryPage = page;
    page = await blockedContext.newPage();
    await page.goto(`${base}/#view=graph`); await expect(page.locator('[data-node-key]')).toHaveCount(23);
    await dragToWidth(500);
    await blockedContext.close(); page = primaryPage;
    passed('无效宽度与存储拒绝不阻断只读页面或鼠标调宽');
    await page.locator('[data-node-key="ND-007"]').click();
    await page.getByTestId('detail-panel').locator('.detail-note').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('detail-panel').locator('.detail-note')).toBeVisible();
    await page.getByTestId('detail-panel').evaluate(node => { node.scrollTop = 0; });
    const responses = [];
    page.on('response', response => { if (response.url().includes('/api/snapshot')) responses.push({ at: Date.now(), status: response.status() }); });
    await page.evaluate(() => {
      const handle = document.querySelector('#detail-resizer');
      const panel = document.querySelector('#detail-panel');
      window.__panelFrames = { samples: 0, changes: 0 };
      const sample = () => {
        window.__panelFrames.samples += 1;
        if (panel.getBoundingClientRect().width !== 650 || document.querySelector('#detail-resizer') !== handle || !handle.isConnected) window.__panelFrames.changes += 1;
        window.__panelFrame = requestAnimationFrame(sample);
      };
      window.__panelFrame = requestAnimationFrame(sample);
    });
    await expect.poll(() => responses.length, { timeout: 23000 }).toBeGreaterThanOrEqual(3);
    report.refreshResponses = responses;
    report.refreshFrames = await page.evaluate(() => { cancelAnimationFrame(window.__panelFrame); return window.__panelFrames; });
    assert.ok(report.refreshFrames.samples > 100, '刷新验证必须实际采集绘制帧，不能空跑通过');
    assert.equal(report.refreshFrames.changes, 0); assert.ok(responses.every(item => item.status === 200));
    assert.equal(await page.getByTestId('detail-panel').locator('.detail-section').filter({ has: page.getByRole('heading', { name: '摘要', exact: true }) }).locator('p').textContent(), summaryText);
    passed('三次自然五秒刷新保持用户宽度、拖柄身份和选中详情，末尾文字可达');
  }
  assert.deepEqual(await fixtureFileBaseline(fixture.root), filesBefore);
  passed('产品读取没有修改专用临时项目文件或数据库');
  if (!baseline) {
    updateFixtureWork(fixture, 'ND-007', { summary: '调宽之后实时更新仍可见，仅修改本轮临时夹具。' });
    await expect(page.getByTestId('detail-panel')).toContainText('调宽之后实时更新仍可见', { timeout: 8000 });
    passed('调宽后真实自动读取仍显示后续夹具变化');
  }
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  console.error(error); process.exitCode = 1;
} finally {
  report.finishedAt = Date.now();
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixture) await fixture.dispose();
}
