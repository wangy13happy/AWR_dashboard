import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, updateFixtureWork, fixtureFileBaseline } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR ?? 'verification/title-work-id/browser');
const relative = path.relative(path.join(root, 'verification'), output);
assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), '证据必须在本工作树的verification内');
const firstKey = 'WORK-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const secondKey = 'WORK-aaaaaaaa111111111111111111111111';
const longTitle = 'LONG-TITLE-001：中文和英文Mixed长名称连续换行，仅为专用夹具。'.repeat(14);
const started = performance.now();
const report = { checks: [], measurements: [], pageErrors: [], passed: false };
let fixture;
let server;
let browser;

/** 只记录实际通过的检查，不将未执行项、历史结果或截图存在视为通过。 */
function passed(name) {
  report.checks.push({ name, passed: true });
  console.log(`通过：${name}`);
}

/** 按完整工作键寻找卡片，绝不以名称或缩短前缀充当身份。 */
function card(page, key) {
  return page.locator(`[data-node-key="${key}"]`);
}

/** 读取真实浏览器矩形；名称裁切区与固定页脚、页脚各叶子都必须互不遮盖。 */
async function measureCards(page, label) {
  const measurements = await page.locator('.task-card').evaluateAll(cards => cards.map(button => {
    const title = button.querySelector('.card-title');
    const footer = button.querySelector('.card-state');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const style = getComputedStyle(title);
    return { key: button.dataset.nodeKey, card: box(button), title: box(title), footer: box(footer),
      clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      clientHeight: button.clientHeight, scrollHeight: button.scrollHeight,
      lineHeight: Number.parseFloat(style.lineHeight), clamp: style.webkitLineClamp,
      titleClientHeight: title.clientHeight, titleScrollHeight: title.scrollHeight,
      overflow: style.overflow, fontWeight: style.fontWeight,
      leaves: [...footer.children].map(element => ({ className: element.className, ...box(element) })) };
  }));
  for (const value of measurements) {
    assert.equal(value.card.width, 198, `${label}/${value.key}卡片宽度`);
    assert.equal(value.card.height, 72, `${label}/${value.key}卡片高度`);
    assert.equal(value.clamp, '2');
    assert.equal(value.overflow, 'hidden');
    assert.equal(value.fontWeight, '700');
    assert.ok(value.title.height <= value.lineHeight * 2 + .1);
    assert.ok(value.title.bottom <= value.footer.top, `${label}/${value.key}名称与状态行重叠`);
    assert.ok(value.scrollWidth <= value.clientWidth, `${label}/${value.key}横向溢出`);
    assert.ok(value.scrollHeight <= value.clientHeight, `${label}/${value.key}纵向溢出`);
    for (const [index, leaf] of value.leaves.entries()) {
      assert.ok(leaf.left >= value.footer.left - .1 && leaf.right <= value.footer.right + .1);
      assert.ok(leaf.top >= value.footer.top - .1 && leaf.bottom <= value.footer.bottom + .1);
      if (index) assert.ok(value.leaves[index - 1].right <= leaf.left + .1, `${label}/${value.key}页脚文字或图标重叠`);
    }
  }
  report.measurements.push({ label, cards: measurements });
  return measurements;
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createReaderFixture({ works: [
    { key: firstKey, title: '同名任务', status: 'completed' },
    { key: secondKey, title: '同名任务', status: 'in_progress' },
    { key: 'ND-007', title: '普通编号也名称优先', status: 'ready' },
    { key: 'EMPTY', title: '', status: 'ready' },
    { key: 'WHITE', title: ' \t\n\u3000 ', status: 'ready' },
    { key: 'LONG', title: longTitle, status: 'in_progress', payload: { kind: 'documentation-'.repeat(12) } },
    { key: 'HIDDEN', title: '专用敏感夹具名称', status: 'ready', payload: { extra: { private_prompt: 'dedicated-test-marker' } } },
    { key: 'MARKUP', title: '<img src=x onerror="window.__titleUnsafe=1">纯文本夹具', status: 'ready' },
    { key: 'WARN', title: longTitle, status: 'blocked', payload: { kind: 'implementation-'.repeat(12) } },
  ], edges: [{ from: secondKey, to: firstKey }, { from: 'WARN', to: 'MISSING' }],
  claims: [{ key: 'LONG', branch: false }] });
  const sourceBefore = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({ projectRoot: fixture.root });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port;
  assert.notEqual(report.port, 4317, '仅允许自有随机回环端口');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${report.port}/#view=graph`);
  await expect(page.locator('.task-card')).toHaveCount(10);

  await expect(card(page, firstKey).locator('.card-title')).toHaveText('同名任务');
  await expect(card(page, 'ND-007').locator('.card-title')).toHaveText('普通编号也名称优先');
  assert.equal(await page.locator('.card-key, .card-heading').count(), 0);
  assert.ok(!(await card(page, firstKey).innerText()).includes(firstKey));
  assert.ok(!(await card(page, 'ND-007').innerText()).includes('ND-007'));
  await expect(card(page, firstKey).locator('.card-state .card-meta')).toHaveText('P1 · implementation');
  passed('所有卡片名称为主标签，编号不进入卡片正文，元数据在页脚右侧');

  for (const key of ['EMPTY', 'WHITE']) {
    await expect(card(page, key).locator('.card-title')).toHaveText(key);
    await card(page, key).click();
    await expect(page.locator('.detail-title')).toHaveText(key);
    await expect(page.locator('.detail-id code')).toHaveText(key);
  }
  await expect(card(page, 'HIDDEN').locator('.card-title')).toHaveText('敏感内容已隐藏');
  await expect(card(page, 'MISSING').locator('.card-title')).toHaveText('缺失工作项');
  passed('空字符串和纯空白回退完整编号，安全与缺项占位保持');

  await expect(card(page, firstKey)).toHaveAttribute('title', `${firstKey} 同名任务`);
  await expect(card(page, firstKey)).toHaveAttribute('aria-label', `${firstKey} 同名任务 已完成`);
  await expect(card(page, secondKey)).toHaveAttribute('aria-label', `${secondKey} 同名任务 进行中`);
  await expect(card(page, 'MARKUP').locator('.card-title')).toHaveText('<img src=x onerror="window.__titleUnsafe=1">纯文本夹具');
  assert.equal(await page.locator('.task-card img').count(), 0);
  assert.equal(await page.evaluate(() => window.__titleUnsafe), undefined);
  passed('完整编号、原始标题及状态保留在悬停/辅助阅读，标题只以纯文本渲染');

  await card(page, secondKey).click();
  await expect(page.locator('.detail-title')).toHaveText('同名任务');
  await expect(page.locator('.detail-id')).toHaveText(`工作项编号：${secondKey}`);
  const code = page.locator('.detail-id code');
  assert.ok((await code.evaluate(element => getComputedStyle(element).fontFamily)).includes('Consolas'));
  assert.equal(await code.evaluate(element => getComputedStyle(element).userSelect), 'all');
  await code.click();
  assert.equal(await page.evaluate(() => getSelection().toString()), secondKey);
  passed('详情只以名称为大标题，完整编号独立等宽显示并可单击全选');

  const upstream = page.locator(`[data-select-key="${firstKey}"]`);
  await expect(upstream.locator('.dependency-title')).toHaveText('同名任务');
  await expect(upstream.locator('.dep-id')).toHaveText(firstKey);
  const dependencyLayout = await upstream.evaluate(button => {
    const title = button.querySelector('.dependency-title').getBoundingClientRect();
    const id = button.querySelector('.dep-id').getBoundingClientRect();
    return { titleBottom: title.bottom, idTop: id.top, idColor: getComputedStyle(button.querySelector('.dep-id')).color };
  });
  assert.ok(dependencyLayout.titleBottom <= dependencyLayout.idTop);
  assert.equal(dependencyLayout.idColor, 'rgb(128, 149, 173)');
  await upstream.click();
  await expect(card(page, firstKey)).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, secondKey)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.detail-id code')).toHaveText(firstKey);
  const downstream = page.locator(`[data-select-key="${secondKey}"]`);
  await expect(downstream.locator('.dependency-title')).toHaveText('同名任务');
  await expect(downstream.locator('.dep-id')).toHaveText(secondKey);
  await downstream.click();
  await expect(page.locator('.detail-id code')).toHaveText(secondKey);
  await expect(card(page, secondKey)).toHaveAttribute('aria-pressed', 'true');
  passed('上游/下游先名称后灰色完整编号，同名且同短前缀任务按完整键分别定位');

  await page.getByTestId('actual-button').click();
  for (const width of [1920, 1366, 960]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.getByTestId('actual-button').click();
    // 只通过真实卡片点击选中；矩形检查也包括画布范围外的固定尺寸卡片。
    await card(page, 'LONG').evaluate(button => button.click());
    const values = await measureCards(page, `${width}-selected`);
    const long = values.find(value => value.key === 'LONG');
    assert.equal(long.title.height, 30);
    assert.ok(long.titleScrollHeight > long.titleClientHeight, '长名称必须真的溢出两行裁切区，不能用短夹具假测截断');
    assert.ok(await card(page, 'LONG').locator('.claim-icon').count());
    assert.ok(await card(page, 'WARN').locator('.card-warning').count());
    assert.equal(await page.locator('.detail-panel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  }
  await page.screenshot({ path: path.join(output, 'title-layout-960.png') });
  passed('1920/1366/960长标题实际两行裁切，固定198×72，名称/页脚/图标/元数据不重叠溢出');

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByTestId('actual-button').click();
  await page.getByTestId('pause-button').click();
  assert.deepEqual(await fixtureFileBaseline(fixture.root), sourceBefore, '首次展示与交互不能改动夹具来源或数据库');
  const stablePositions = await page.locator('.task-card').evaluateAll(cards => cards.map(button => [button.dataset.nodeKey, button.style.left, button.style.top]));
  const stableTransform = await page.getByTestId('graph-world').getAttribute('style');
  for (const [index, title] of ['短标题', longTitle].entries()) {
    updateFixtureWork(fixture, 'LONG', { title });
    const startedAt = performance.now();
    await page.getByTestId('pause-button').click();
    await expect(card(page, 'LONG').locator('.card-title')).toHaveText(title, { timeout: 7500 });
    await expect(page.locator('.detail-title')).toHaveText(title);
    await page.getByTestId('pause-button').click();
    assert.deepEqual(await page.locator('.task-card').evaluateAll(cards => cards.map(button => [button.dataset.nodeKey, button.style.left, button.style.top])), stablePositions);
    assert.equal(await page.getByTestId('graph-world').getAttribute('style'), stableTransform);
    await measureCards(page, `title-update-${index}`);
    report.measurements.push({ label: `title-update-${index}`, observedMs: performance.now() - startedAt });
  }
  passed('短长标题更新到卡片和详情，不改变完整键、排序、坐标和画布变换');
  // 上一步有意更新仅属于自有夹具；其后再设只读基线验证后续轮询。
  await page.getByTestId('pause-button').click();
  // 先等待恢复触发的读取结束，再更新夹具；否则可能只测到恢复请求，而非下一次自然轮询。
  await expect(page.locator('#refresh-label')).toContainText('每 5s 刷新');
  const naturalStarted = performance.now();
  updateFixtureWork(fixture, 'LONG', { title: '自然轮询后的完整任务名' });
  const updatedSourceBefore = await fixtureFileBaseline(fixture.root);
  await expect(card(page, 'LONG').locator('.card-title')).toHaveText('自然轮询后的完整任务名', { timeout: 7500 });
  assert.deepEqual(await fixtureFileBaseline(fixture.root), updatedSourceBefore);
  await page.getByTestId('pause-button').click();
  await expect(card(page, 'LONG')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.detail-id code')).toHaveText('LONG');
  report.measurements.push({ label: 'natural-refresh', observedMs: performance.now() - naturalStarted });
  passed('真实自然轮询更新名称并保留选择，纯读取窗口不改自有夹具字节/元数据');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  // 按所有权依次关闭页面/浏览器、随机端口服务和夹具；不调用任何真实后台管理入口。
  if (browser) await browser.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (fixture) await fixture.dispose();
  report.durationMs = performance.now() - started;
  report.cleanup = { browserClosed: Boolean(browser), serverListening: server?.listening ?? false, fixtureDisposed: Boolean(fixture) };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.failure) console.error(report.failure);
}
