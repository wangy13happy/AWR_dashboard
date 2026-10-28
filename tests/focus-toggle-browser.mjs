// 详情与关联高亮的交互核对（2026-10-28 需求）：三种视图单击只显示详情，双击高亮关联任务，再次双击取消高亮；
// 依赖图与旧版看板点空白同时清除详情与高亮、拖动不清除；时间线泳道空白与 Esc 照旧。
// 只用临时演示夹具与随机回环端口，不读写真实项目，不碰 4317 服务。
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createVisualFixture } from './visual-fixture.mjs';
import { fixtureFileBaseline } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, process.env.AWR_FOCUS_BROWSER_DIR ?? 'verification/focus-dblclick/browser');
const report = { passed: false, startedAt: Date.now(), checks: [], pageErrors: [] };
let fixture, server, browser, page;

// 夹具关系：ND-014 的直接上下游是 ND-010 与 ND-019；ND-000 与 ND-014 无直接关系；ND-012 是另一组关系的中心。
const ROOT = 'ND-014';
const ROOT_RELATED = ['ND-010', 'ND-019'];
const OTHER = 'ND-000';
const SECOND_ROOT = 'ND-012';

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

/**
 * 当前视图内的状态：详情选中键、是否处于高亮、带关联光圈的键、被渐隐的键，以及详情栏是否回到提示。
 * 隐藏视图的旧元素不计。
 */
async function viewState(container) {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    const keyOf = (item) => item.dataset.nodeKey ?? item.dataset.timelineKey;
    return {
      selected: [...scope.querySelectorAll('.is-selected')].map(keyOf),
      hasFocus: scope.classList.contains('has-focus'),
      related: [...scope.querySelectorAll('.is-related')].map(keyOf).sort(),
      faded: [...scope.querySelectorAll('.is-faded')].map(keyOf).filter(Boolean),
      detailEmpty: Boolean(document.querySelector('#detail-content .detail-empty')),
    };
  }, container);
}

/** 断言只显示指定任务详情，没有任何高亮。 */
async function expectDetailOnly(container, key) {
  await expect.poll(() => viewState(container)).toMatchObject({ selected: [key], hasFocus: false, related: [], faded: [], detailEmpty: false });
}

/** 断言高亮 root：related 为带关联光圈的键（详情卡本身不计），详情卡为 selected。 */
async function expectFocus(container, selected, related) {
  await expect.poll(() => viewState(container)).toMatchObject({ selected: [selected], hasFocus: true, related: [...related].sort(), detailEmpty: false });
}

/** 断言详情与高亮都已清除，详情栏回到提示。 */
async function expectCleared(container) {
  await expect.poll(() => viewState(container)).toMatchObject({ selected: [], hasFocus: false, related: [], faded: [], detailEmpty: true });
}

/**
 * 在画布可见范围内找一个空白点：不落在按钮上且仍属于指定画布，避开浮在上面的视图切换和提示条。
 * within 给出时还须落在该类元素内，例如时间线的泳道轨道。
 */
async function blankPoint(selector, within = selector) {
  return page.evaluate(([container, inner]) => {
    const box = document.querySelector(container).getBoundingClientRect();
    for (let y = box.top + 30; y < box.bottom - 30; y += 11) for (let x = box.left + 30; x < box.right - 30; x += 13) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('button') && hit.closest(container) && hit.closest(inner)) return { x, y };
    }
    return null;
  }, [selector, within]);
}

/**
 * 三种视图共用的单击/双击核对。item 按工作键取当前视图的卡片或任务条，container 为该视图的聚焦容器。
 */
async function checkClicks(view, item, container) {
  await item(ROOT).click();
  await expectDetailOnly(container, ROOT);
  await item(ROOT).click();
  await expectDetailOnly(container, ROOT);
  passed(`${view}：单击只显示详情，不高亮；再次单击不取消详情`);

  await item(ROOT).dblclick();
  await expectFocus(container, ROOT, ROOT_RELATED);
  passed(`${view}：双击高亮关联任务并显示其详情`);

  await item(OTHER).click();
  const afterClick = await viewState(container);
  assert.deepEqual(afterClick.selected, [OTHER]);
  assert.equal(afterClick.hasFocus, true);
  assert.deepEqual(afterClick.related, [ROOT, ...ROOT_RELATED].sort());
  assert.ok(!afterClick.faded.includes(OTHER), JSON.stringify(afterClick));
  passed(`${view}：高亮时单击其他任务只换详情，高亮不变，被单击任务不渐隐`);

  await item(SECOND_ROOT).dblclick();
  const moved = await viewState(container);
  assert.deepEqual(moved.selected, [SECOND_ROOT]);
  assert.equal(moved.hasFocus, true);
  assert.ok(!moved.related.includes(ROOT) && moved.related.length > 0, JSON.stringify(moved));
  passed(`${view}：双击另一任务改为高亮它`);

  await item(SECOND_ROOT).dblclick();
  await expectDetailOnly(container, SECOND_ROOT);
  passed(`${view}：再次双击取消高亮，详情保留`);
}

/** 依赖图与旧版看板：单击/双击核对后，再核对拖动不清除、点空白同时清除。 */
async function checkGraphView(view) {
  await page.getByTestId('view-switch').locator(`[data-view="${view}"]`).click();
  await expect(page.locator('#canvas-area')).toHaveAttribute('data-view', view);
  const card = (key) => page.locator(`#graph-cards [data-node-key="${key}"]`);
  await checkClicks(view, card, '#graph-world');

  await card(ROOT).dblclick();
  await expectFocus('#graph-world', ROOT, ROOT_RELATED);
  const start = await blankPoint('#graph-viewport');
  assert.ok(start, `${view} 画布内应能找到空白点`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 25, { steps: 5 });
  await page.mouse.up();
  await expectFocus('#graph-world', ROOT, ROOT_RELATED);
  passed(`${view}：拖动平移画布不清除详情与高亮`);

  await page.screenshot({ path: path.join(output, `${view}-focused.png`) });
  const blank = await blankPoint('#graph-viewport');
  await page.mouse.click(blank.x, blank.y);
  await expectCleared('#graph-world');
  passed(`${view}：点画布空白同时清除详情与高亮`);
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createVisualFixture();
  const filesBefore = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({ projectRoot: fixture.root, snapshotReader: snapshot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  await page.goto(`${base}/#view=timeline`);
  await expect(page.locator('#timeline-canvas [data-timeline-key]').first()).toBeVisible({ timeout: 10000 });

  const item = (key) => page.locator(`#timeline-canvas [data-timeline-key="${key}"]`);
  await checkClicks('timeline', item, '#timeline-canvas');
  const lines = await page.locator('#timeline-canvas .timeline-relations path').count();
  assert.equal(lines, 0, '取消高亮后时间线不应再画关系线');

  await item(ROOT).dblclick();
  await expectFocus('#timeline-canvas', ROOT, ROOT_RELATED);
  assert.ok(await page.locator('#timeline-canvas .timeline-relations path').count() > 0, '高亮时应画出关系线');
  const track = await blankPoint('#timeline-scroll', '.lane-track');
  assert.ok(track, '时间线应能找到泳道空白点');
  await page.mouse.click(track.x, track.y);
  await expectCleared('#timeline-canvas');
  passed('timeline：点泳道空白同时清除详情与高亮');
  await item(ROOT).dblclick();
  await page.keyboard.press('Escape');
  await expectCleared('#timeline-canvas');
  passed('timeline：Esc 同时清除详情与高亮');

  await checkGraphView('graph');
  await checkGraphView('classic');

  await page.locator(`#graph-cards [data-node-key="${ROOT}"]`).dblclick();
  await page.locator('#detail-content .dependency-chip').first().click();
  const chip = await viewState('#graph-world');
  assert.equal(chip.selected.length, 1);
  assert.notEqual(chip.selected[0], ROOT);
  assert.equal(chip.hasFocus, true);
  passed('详情邻接按钮只换详情，不改变高亮');

  assert.deepEqual(await fixtureFileBaseline(fixture.root), filesBefore);
  passed('产品读取没有修改专用临时项目文件或数据库');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  console.error(error); process.exitCode = 1;
} finally {
  report.finishedAt = Date.now();
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (fixture) await fixture.dispose();
}
