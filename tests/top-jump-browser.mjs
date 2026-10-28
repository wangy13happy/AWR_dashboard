import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createVisualFixture } from './visual-fixture.mjs';
import { fixtureFileBaseline, updateFixtureWork } from './reader-fixture.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const observeOnly = process.argv.includes('--observe');
const output = path.resolve(workspace, process.env.AWR_DASHBOARD_VERIFICATION_DIR
  ?? `verification/top-jump-on-refresh/${observeOnly ? 'baseline' : 'fixed'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const relativeOutput = path.relative(path.join(workspace, 'verification/top-jump-on-refresh'), output);
assert.ok(!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput), '专项证据必须位于本工作树独立验收目录');
const report = { passed: false, observeOnly, startedAt: Date.now(), scenarios: [], pageErrors: [], checks: [] };
let fixture, server, browser;

/** 只读取本测试创建的临时项目，沿用产品稳定副本链路并明确标记演示。 */
async function fixtureSnapshot(projectRoot) {
  const snapshot = await readSnapshot(projectRoot);
  snapshot.mode = 'demo';
  return snapshot;
}

/** 真实浏览器每个绘制帧测量顶部结构、可见性和各滚动容器；仅压缩重复样本。 */
async function beginMeasurement(page, scrollPosition) {
  await page.evaluate(scrollPosition => {
    const toolbar = document.querySelector('.toolbar');
    toolbar.scrollLeft = scrollPosition === 'end' ? toolbar.scrollWidth : 0;
    const selectors = ['.toolbar', '.project-picker', '.project-picker label', '#project-select', '#project-list-count',
      '.project-heading', '#project-name', '#project-revision', '.readonly-badge', '#demo-badge',
      '.completion', '.completion-label', '.completion-label > span:first-child', '#completion-label',
      '#completion-progress', '.filters', ...Array.from(document.querySelectorAll('[data-filter]'),
        node => `[data-filter="${node.dataset.filter}"]`), ...Array.from(document.querySelectorAll('[data-count]'),
        node => `[data-count="${node.dataset.count}"]`), ...Array.from(document.querySelectorAll('[data-filter]'),
        node => `[data-filter="${node.dataset.filter}"] .filter-icon`), '.refresh-state', '#sync-dot', '#refresh-label',
      '.view-actions', '#pause-button', '#fit-button', '#actual-button'];
    const nodes = selectors.map(selector => document.querySelector(selector));
    // 文案和状态点允许实时变化；它们的占位、可见性和节点身份不能随轮询变化。
    const capture = () => ({
      rectangles: Object.fromEntries(selectors.map((selector, index) => {
        const node = nodes[index];
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          display: style.display, visibility: style.visibility, opacity: style.opacity,
          connected: node.isConnected, sameNode: node === document.querySelector(selector) }];
      })),
      scroll: { windowX: scrollX, windowY: scrollY, toolbarLeft: toolbar.scrollLeft, toolbarTop: toolbar.scrollTop,
        toolbarWidth: toolbar.scrollWidth, toolbarClientWidth: toolbar.clientWidth,
        detailTop: document.querySelector('#detail-panel').scrollTop },
    });
    const baseline = capture();
    const baselineKey = JSON.stringify(baseline);
    const measurement = { baseline, samples: 0, changedFrames: 0, changes: [], labels: [], removedNodes: 0 };
    const seenChanges = new Set();
    const seenLabels = new Set();
    const observer = new MutationObserver(records => {
      measurement.removedNodes += records.reduce((count, record) => count
        + Array.from(record.removedNodes).filter(node => node.nodeType === Node.ELEMENT_NODE).length, 0);
    });
    observer.observe(toolbar, { childList: true, subtree: true });
    let frame;
    const sample = () => {
      const geometry = capture();
      const key = JSON.stringify(geometry);
      const label = document.querySelector('#refresh-label').textContent;
      measurement.samples += 1;
      if (!seenLabels.has(label)) { seenLabels.add(label); measurement.labels.push(label); }
      if (key !== baselineKey) {
        measurement.changedFrames += 1;
        if (!seenChanges.has(key)) {
          seenChanges.add(key);
          // 保留首次出现的不同布局及文案，避免逐帧重复数据撑大证据文件。
          if (measurement.changes.length < 20) measurement.changes.push({ elapsedMs: performance.now() - started, label, geometry });
        }
      }
      frame = requestAnimationFrame(sample);
    };
    const started = performance.now();
    window.__topMeasurementStarted = started;
    frame = requestAnimationFrame(sample);
    window.__finishTopMeasurement = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      measurement.elapsedMs = performance.now() - started;
      measurement.final = capture();
      return measurement;
    };
  }, scrollPosition);
}

/** 为一个视口建立正常五秒轮询；延迟响应以确保读取状态也被多个绘制帧覆盖。 */
async function openScenario(base, width, scrollPosition) {
  const name = `${width}-${scrollPosition}`;
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Shanghai' });
  const scenario = { name, width, scrollPosition, requests: [], responses: [] };
  page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
  await page.route('**/api/snapshot', async route => {
    scenario.requests.push(Date.now());
    // 延迟只属于专用测试路由，不改变应用计时器、数据或实际后台服务。
    await new Promise(resolve => setTimeout(resolve, 650));
    await route.continue();
  });
  page.on('response', response => {
    if (response.url().includes('/api/snapshot')) scenario.responses.push({ at: Date.now(), status: response.status() });
  });
  await page.goto(`${base}/#view=graph`);
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  await expect(page.locator('#refresh-label')).toContainText('每 5s 刷新');
  await beginMeasurement(page, scrollPosition);
  // 页面建立与首次读回可能已跨过一个轮询点；只把开始逐帧测量后的响应计入三次周期。
  scenario.responsesAtMeasurement = scenario.responses.length;
  // 顶栏高度可随已授权可读性样式调整；截图覆盖真实完整顶栏，几何断言不变。
  const toolbarHeight = await page.locator('.toolbar').evaluate(node => node.getBoundingClientRect().height);
  await page.screenshot({ path: path.join(output, `${name}-idle.png`), clip: { x: 0, y: 0, width, height: toolbarHeight } });
  return { page, scenario };
}

/** 记录确已完成的检查；断言失败由总报告保留，不冒充完成或业务项目验收。 */
function passed(name) {
  report.checks.push({ name, passed: true, verifiedAt: Date.now() });
  console.log(`通过：${name}`);
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createVisualFixture();
  report.fixtureRoot = fixture.root;
  server = createDashboardServer({ projectRoot: fixture.root, snapshotReader: fixtureSnapshot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port;
  assert.notEqual(report.port, 4317, '不得占用已有后台端口');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browserVersion = browser.version();
  const baselineFiles = await fixtureFileBaseline(fixture.root);
  const scenarios = await Promise.all([[2300, 'start'], [1366, 'start'], [1366, 'end'], [1024, 'end'], [960, 'end']]
    .map(([width, scrollPosition]) => openScenario(`http://127.0.0.1:${report.port}`, width, scrollPosition)));
  // 不加速应用时钟：每页等待三次实际自动轮询，包含读取中与成功后的布局。
  await Promise.all(scenarios.map(async ({ page, scenario }) => {
    await expect.poll(() => scenario.requests.length, { timeout: 18000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#refresh-label')).toHaveText('正在读取');
    const toolbarHeight = await page.locator('.toolbar').evaluate(node => node.getBoundingClientRect().height);
    await page.screenshot({ path: path.join(output, `${scenario.name}-loading.png`), clip: { x: 0, y: 0, width: scenario.width, height: toolbarHeight } });
    await expect.poll(() => scenario.responses.length, { timeout: 23000 })
      .toBeGreaterThanOrEqual(scenario.responsesAtMeasurement + 3);
    await expect(page.locator('#refresh-label')).toContainText('每 5s 刷新');
    // 保留原14秒下限，以真实浏览器单调时钟确认窗口；不靠重试偶然撞上较长起点。
    await page.waitForFunction(() => performance.now() - window.__topMeasurementStarted >= 14000);
    scenario.measurement = await page.evaluate(() => window.__finishTopMeasurement());
  }));
  report.scenarios = scenarios.map(({ scenario }) => scenario);
  assert.deepEqual(await fixtureFileBaseline(fixture.root), baselineFiles, '纯轮询测量期间夹具源、数据库及侧文件必须保持不变');
  passed('五个视口/滚动场景跨三次真实五秒轮询，临时项目文件与元数据保持不变');
  for (const { scenario } of scenarios) {
    assert.ok(scenario.measurement.samples > 100, '必须实际覆盖绘制帧');
    assert.ok(scenario.measurement.elapsedMs >= 14000, '至少跨三次真实五秒轮询');
    assert.ok(scenario.measurement.labels.includes('正在读取'), '必须捕获读取状态');
    assert.ok(scenario.measurement.labels.some(label => label.startsWith('每 5s 刷新')), '必须捕获倒计时状态');
    const intervals = scenario.requests.slice(1).map((time, index) => time - scenario.requests[index]);
    assert.ok(intervals.every(interval => interval >= 4500 && interval <= 6500), '请求保持原五秒节拍');
    assert.ok(scenario.responses.every(response => response.status === 200), '所有轮询真实成功');
    if (!observeOnly) {
      assert.equal(scenario.measurement.changedFrames, 0, `${scenario.name}顶部矩形、可见性或滚动位置变化`);
      assert.equal(scenario.measurement.removedNodes, 0, `${scenario.name}顶部元素被拆除`);
      assert.deepEqual(scenario.measurement.final, scenario.measurement.baseline);
    }
  }
  passed(observeOnly ? '基线观察完成，变化保留原始矩形与对应状态文案' : '每个绘制帧顶部元素矩形/可见性/身份及滚动位置完全不变');

  if (!observeOnly) {
    // 在同一字体与真实布局中核对所有现有状态文案的空间，固定占位不能以截断换稳定。
    report.labelSizing = await scenarios[0].page.evaluate(() => {
      const label = document.querySelector('#refresh-label');
      const original = label.textContent;
      const labels = ['正在读取', '正在读取项目名单', '等待选择项目', '读取失败 · 保留旧数据',
        '读取失败', '已暂停', '名单不可用 · 已停止读取', '每 5s 刷新 · 23:59:59 后 5s',
        '每 5s 刷新 · 尚无成功读取 后 5s'];
      const sizes = labels.map(text => {
        label.textContent = text;
        const range = document.createRange();
        range.selectNodeContents(label);
        return { text, textWidth: range.getBoundingClientRect().width, availableWidth: label.clientWidth };
      });
      label.textContent = original;
      return sizes;
    });
    assert.ok(report.labelSizing.every(size => size.textWidth <= size.availableWidth), '现有刷新文案必须完整显示');
    passed('所有现有状态及最长首次读取文案完整容纳，无截断');
  }

  // 纯只读观察完成后才有意修改自有夹具，单独证明修复没有冻结实际数据刷新。
  const updatedAt = Date.now();
  updateFixtureWork(fixture, 'ND-007', { title: '顶部稳定性回归：自动刷新已更新' });
  await Promise.all(scenarios.map(async ({ page, scenario }) => {
    await expect(page.locator('[data-node-key="ND-007"] .card-title')).toContainText('自动刷新已更新', { timeout: 7000 });
    scenario.updateObservedMs = Date.now() - updatedAt;
  }));
  passed('五个页面在后续自动轮询显示夹具更新，未冻结实时刷新');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  report.verifiedAt = Date.now();
  report.boundary = '仅专用临时夹具、随机回环端口及本工作树产物；逐绘制帧测量不等于所有浏览器/未采样时刻证明，不部署或认证现有后台。';
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixture) await fixture.dispose();
  console.log(JSON.stringify({ passed: report.passed, observeOnly, output, scenarios: report.scenarios.map(scenario => ({
    name: scenario.name, frames: scenario.measurement?.samples, changedFrames: scenario.measurement?.changedFrames,
    scrollBefore: scenario.measurement?.baseline.scroll.toolbarLeft, scrollAfter: scenario.measurement?.final.scroll.toolbarLeft,
  })) }));
}
