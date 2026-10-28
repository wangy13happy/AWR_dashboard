import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, fixtureFileBaseline } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const observe = process.argv.includes('--observe');
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR
  ?? `verification/dashboard-panel-ui/rework-1/${observe ? 'before-scale' : 'scale'}`);
const relative = path.relative(path.join(root, 'verification/dashboard-panel-ui/rework-1'), output);
assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), '输出只能位于本轮返工证据目录');
const longName = 'AWR_dashboard · 本地只读依赖进度看板 · 长项目名与真实规模计数验证';
const report = { passed: false, observe, startedAt: Date.now(), checks: [], measurements: [], pageErrors: [], screenshots: [] };
let fixture, directory, tempRoot, server, browser, showDemo = false;

/** 演示变体仍读相同的专用临时项目，只切换显示徽标，不改变源文件或业务语义。 */
async function snapshot(projectRoot) {
  const result = await readSnapshot(projectRoot);
  if (showDemo) result.mode = 'demo';
  return result;
}

/** 断言成功后记录检查；观察模式保留同样的实际测量而不声明修复通过。 */
function passed(name) { report.checks.push({ name, passed: true }); console.log(`通过：${name}`); }

/** 采集真实元素与文字矩形，防止“visible”仅表示DOM存在却被滚动容器裁掉。 */
async function measure(page, label) {
  const result = await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const bounds = toolbar.getBoundingClientRect();
    const selectors = ['#project-select', '.project-picker label', '#project-list-count', '#project-name',
      '#project-revision', '.readonly-badge', '.completion', '.completion-label > span:first-child', '#completion-label', '#completion-progress',
      '.refresh-state', '#refresh-label', '#pause-button', '#fit-button', '#actual-button',
      ...Array.from(document.querySelectorAll('[data-filter]'), node => `[data-filter="${node.dataset.filter}"]`),
      ...Array.from(document.querySelectorAll('[data-count]'), node => `[data-count="${node.dataset.count}"]`)];
    if (!document.querySelector('#demo-badge').hidden) selectors.push('#demo-badge');
    const controls = selectors.map(selector => {
      const node = document.querySelector(selector), rect = node.getBoundingClientRect();
      const group = node.closest('.filter, .project-picker, .project-heading, .completion, .refresh-state, .view-actions');
      const groupRect = group.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(node);
      const textRects = Array.from(range.getClientRects(), item => ({ left: item.left, right: item.right, top: item.top, bottom: item.bottom }));
      return { selector, text: node.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height, font: getComputedStyle(node).fontSize,
        contained: rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right
          && rect.top >= bounds.top && rect.bottom <= bounds.bottom,
        insideGroup: rect.left >= groupRect.left - 0.1 && rect.right <= groupRect.right + 0.1
          && rect.top >= groupRect.top - 0.1 && rect.bottom <= groupRect.bottom + 0.1, textRects };
    });
    return { viewport: innerWidth, toolbarHeight: bounds.height, clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth, scrollLeft: toolbar.scrollLeft, pageWidth: document.documentElement.scrollWidth,
      completionWidth: document.querySelector('.completion').getBoundingClientRect().width,
      refreshWidth: document.querySelector('.refresh-state').getBoundingClientRect().width, controls };
  });
  report.measurements.push({ label, ...result });
  await page.screenshot({ path: path.join(output, `${label}.png`) }); report.screenshots.push(`${label}.png`);
  if (!observe) {
    assert.equal(result.scrollWidth, result.clientWidth, `${label}顶栏不得横向溢出`);
    assert.equal(result.scrollLeft, 0); assert.equal(result.pageWidth, result.viewport);
    assert.equal(result.toolbarHeight, 60); assert.equal(result.refreshWidth, 250);
    assert.ok(result.completionWidth >= (result.viewport >= 1920 ? 320 : 200), `${label}进度阅读空间`);
    assert.ok(result.controls.every(item => item.contained), `${label}所有原控件必须完整落在顶栏内`);
    assert.ok(result.controls.every(item => item.insideGroup), `${label}控件不得越出自身分组覆盖相邻区域`);
    // 项目名沿用既有省略号；筛选标签、计数、刷新和操作文案必须完整落在各自矩形内。
    for (const item of result.controls.filter(item => /^\[data-filter|^\[data-count|^#refresh-label|^#pause|^#fit|^#actual|^#completion-label|^\.completion-label|^#project-list-count/.test(item.selector))) {
      assert.ok(item.textRects.every(rect => rect.left >= item.left - 0.1 && rect.right <= item.right + 0.1
        && rect.top >= item.top - 0.1 && rect.bottom <= item.bottom + 0.1), `${label} ${item.selector}文字不得裁切`);
    }
  }
  return result;
}

try {
  await mkdir(output, { recursive: true });
  // 主持人发现问题的项目规模是13项、8个筛选按钮。本夹具复现该规模并加入各类状态，
  // 计数由真实读取/归一化链路生成；它不冒充当前业务项目的实时进度。
  fixture = await createReaderFixture({ name: longName, works: Array.from({ length: 13 }, (_, index) => ({
    key: `SCALE-${index}`, status: index < 7 ? 'completed' : index < 10 ? 'in_progress'
      : index === 10 ? 'blocked' : index === 11 ? 'planned' : 'cancelled',
  })), claims: [{ key: 'SCALE-7', agent: '专用演示代理' }] });
  fixture.db.prepare('UPDATE projects SET project_revision=527').run();
  tempRoot = await realpath(os.tmpdir());
  directory = await mkdtemp(path.join(tempRoot, 'awr-dashboard-toolbar-registry-'));
  const registryPath = path.join(directory, 'projects.json');
  await writeFile(registryPath, JSON.stringify({ version: 1, defaultProjectId: 'scale', projects: [{ id: 'scale', name: longName, root: fixture.root }] }));
  const before = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({ projectRoot: fixture.root, registryPath, snapshotReader: snapshot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port;
  assert.ok(![4317, 8765].includes(report.port), '不占用既有服务端口');
  const base = `http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true }); report.browserVersion = browser.version();
  const pages = [];
  for (const width of [1920, 1366]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); pages.push(page);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`${base}/#view=graph`); await expect(page.locator('[data-node-key]')).toHaveCount(13);
    await expect(page.locator('[data-filter]')).toHaveCount(8);
    await expect(page.getByTestId('project-select')).toBeEnabled();
    await expect(page.getByTestId('project-name')).toHaveText(longName);
    await measure(page, `scale-${width}`);
    passed(observe ? `${width}基线矩形已采集（观察模式不验收布局）` : `${width}长项目名、13项真实链路计数、8筛选按钮无溢出且关键控件完整可见`);
    if (!observe) {
      await page.getByTestId('pause-button').click(); await expect(page.getByTestId('pause-button')).toHaveText('恢复');
      await measure(page, `paused-${width}`);
      await page.getByTestId('fit-button').click(); await page.getByTestId('actual-button').click();
      await page.locator('[data-filter="completed"]').click(); await expect(page.locator('[data-filter="completed"]')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('[data-filter="completed"]').click();
      await page.getByTestId('pause-button').click();
      passed(`${width}暂停恢复、适应宽度、1:1及筛选无需横滚即可真实点击`);
    }
  }
  if (!observe) {
    // 同时覆盖两种布局跨真实5秒轮询的稳定性；不改变时钟或伪造刷新状态。
    const cycles = pages.map(page => {
      const responses = []; page.on('response', response => { if (response.url().includes('/api/snapshot')) responses.push(response.status()); });
      return responses;
    });
    await Promise.all(pages.map(page => page.evaluate(() => {
      const nodes = [...document.querySelector('.toolbar').querySelectorAll('*'), document.querySelector('.toolbar')];
      const sample = () => nodes.map(node => { const rect = node.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; });
      const baseline = JSON.stringify(sample());
      window.__scaleFrames = { samples: 0, changes: 0, labels: [] };
      const frame = () => {
        const data = window.__scaleFrames; data.samples++;
        if (JSON.stringify(sample()) !== baseline) data.changes++;
        const label = document.querySelector('#refresh-label').textContent;
        if (!data.labels.includes(label)) data.labels.push(label);
        window.__scaleFrame = requestAnimationFrame(frame);
      }; window.__scaleFrame = requestAnimationFrame(frame);
    })));
    await Promise.all(cycles.map(responses => expect.poll(() => responses.length, { timeout: 23000 }).toBeGreaterThanOrEqual(3)));
    report.refreshFrames = await Promise.all(pages.map(page => page.evaluate(() => { cancelAnimationFrame(window.__scaleFrame); return window.__scaleFrames; })));
    for (const frames of report.refreshFrames) { assert.ok(frames.samples > 100); assert.equal(frames.changes, 0); assert.ok(frames.labels.includes('正在读取')); }
    assert.ok(cycles.every(responses => responses.every(status => status === 200)));
    passed('1920/1366真实规模跨三次五秒刷新矩形零变化');
    showDemo = true;
    await Promise.all(pages.map(page => expect(page.getByTestId('demo-badge')).toBeVisible({ timeout: 8000 })));
    for (const [index, page] of pages.entries()) await measure(page, `demo-${[1920, 1366][index]}`);
    passed('演示徽标与长项目名、修订及只读说明完整留在60像素顶栏内');
    // 在成功的真实计数测量后附加三位数显示压力，不把此合成检查当作真实业务计数。
    for (const [index, page] of pages.entries()) {
      await page.getByTestId('pause-button').click();
      await page.evaluate(() => {
        for (const count of document.querySelectorAll('[data-count]')) count.textContent = '128';
        document.querySelector('#project-list-count').textContent = '1000 项登记';
      });
      await measure(page, `three-digit-${[1920, 1366][index]}`);
    }
    passed('三位数计数及1000项登记附加显示压力下仍完整可见');
    for (const [index, page] of pages.entries()) {
      // 已支持的过期登记和取消/归档双说明是合成显示边界，不把它们写回临时或真实台账。
      await page.evaluate(() => {
        document.querySelector('#project-list-count').textContent = '1000 项登记 · 过期';
        document.querySelector('#completion-label').textContent = '7 / 11 完成（另有 1 项已取消，1 项已归档）';
      });
      await measure(page, `stale-exclusions-${[1920, 1366][index]}`);
      await page.evaluate(() => { document.querySelector('#project-name').textContent = 'AWR_dashboard'; });
      await measure(page, `short-name-${[1920, 1366][index]}`);
    }
    passed('最大登记数过期态、取消与归档双说明及主持人短项目名附加显示压力通过');
  }
  assert.deepEqual(await fixtureFileBaseline(fixture.root), before); passed('临时项目源、数据库与元数据保持只读');
  assert.deepEqual(report.pageErrors, []); report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
  report.finishedAt = Date.now(); await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixture) await fixture.dispose();
  if (directory) {
    // 删除只限本测试实际创建的普通临时目录；Windows解析后仍须位于已核验临时根内。
    const target = await realpath(directory), relativeTarget = path.relative(tempRoot, target);
    assert.ok(relativeTarget.startsWith('awr-dashboard-toolbar-registry-')
      && !relativeTarget.includes(path.sep) && target === directory, '仅清理本测试自有临时登记目录');
    await rm(target, { recursive: true, force: true });
  }
}
