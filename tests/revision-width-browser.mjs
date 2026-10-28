import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, fixtureFileBaseline } from './reader-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, process.env.AWR_DASHBOARD_VERIFICATION_DIR ?? 'verification/revision-width-jump/fixed');
const relative = path.relative(path.join(root, 'verification/revision-width-jump'), output);
assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), '只写本工作树专项证据');
const report = { passed: false, startedAt: Date.now(), stages: [], scenarios: [], pageErrors: [], checks: [] };
let fixture, registryDirectory, server, browser;
let phase = 'before';
const pages = [];
const groups = ['completed', 'in_progress', 'blocked', 'ready', 'waiting', 'cancelled', 'archived'];
const longName = 'AWR_dashboard · 临时动态数据刷新与长项目名称验证';

/** 只改变自有夹具，原子同步工作载荷与投影；来源指纹另由真实来源字节产生。 */
async function changeFixture(stage) {
  fixture.db.exec('BEGIN');
  const update = fixture.db.prepare('UPDATE work_items SET active=?,payload_json=?,status=?,raw_status=? WHERE external_key=?');
  for (const [index, key] of [...fixture.workIds.keys()].entries()) {
    const group = groups[Math.floor(index / 100)];
    const old = JSON.parse(fixture.db.prepare('SELECT payload_json FROM work_items WHERE external_key=?').get(key).payload_json);
    const active = stage.all ? true : !!group && index % 100 < stage.count;
    const status = stage.all ? 'in_progress' : group === 'waiting' ? 'planned' : group === 'archived' ? 'completed' : group ?? 'planned';
    const payload = { ...old, status, raw_status: status, archived: !stage.all && group === 'archived',
      blocker: !stage.all && group === 'waiting' ? 'Dedicated fixture waiting' : null };
    update.run(Number(active), JSON.stringify(payload), status, status, key);
  }
  fixture.db.prepare('UPDATE projects SET project_revision=?,name=?').run(stage.revision, stage.long ? longName : 'AWR');
  fixture.db.exec('COMMIT');
  // 更新没有工作引用的goal源，保留ledger的所有真实引用关系，使hash变化不是DOM伪造。
  const goal = fixture.sourceRows.get('goal');
  const bytes = Buffer.from(`# Dedicated dynamic fixture ${stage.name}\n`);
  await writeFile(fileURLToPath(goal.locator), bytes);
  fixture.db.prepare('UPDATE sources SET fingerprint=?,revision=revision+1 WHERE id=?')
    .run(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, goal.id);
  const registry = { version: 1, defaultProjectId: 'dynamic', projects: Array.from({ length: stage.registry }, (_, index) => ({
    id: index ? `fixture-${index}` : 'dynamic', name: `Fixture ${index}`, root: fixture.root,
  })) };
  await writeFile(path.join(registryDirectory, 'projects.json'), JSON.stringify(registry));
  return readSnapshot(fixture.root);
}

/** 在任何夹具变更前启动连续逐帧测量；只忽略原生下拉选项，保留所有顶栏布局叶子。 */
async function startFrames(page, atEnd) {
  await page.evaluate(atEnd => {
    const toolbar = document.querySelector('.toolbar');
    toolbar.scrollLeft = atEnd ? toolbar.scrollWidth : 0;
    const nodes = [toolbar, ...toolbar.querySelectorAll('*')].filter(node => node.tagName !== 'OPTION');
    const keys = nodes.map(node => node.id || node.dataset.count || node.dataset.filter || `${node.tagName}.${node.className}`);
    const capture = () => ({ elements: nodes.map((node, index) => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { key: keys[index], x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        // 原生下拉框disabled时Chrome会设0.7透明度；状态反馈不是位移，仍拒绝完全透明。
        display: style.display, visibility: style.visibility, opaque: Number(style.opacity) > 0,
        connected: node.isConnected };
    }), sameNodes: [toolbar, ...toolbar.querySelectorAll('*')].filter(node => node.tagName !== 'OPTION')
      .every((node, index) => node === nodes[index]), nodeCount: toolbar.querySelectorAll('*:not(option)').length + 1,
      scroll: [toolbar.scrollLeft, toolbar.scrollTop, toolbar.scrollWidth, toolbar.clientWidth, scrollX, scrollY] });
    const baseline = capture(), serialized = JSON.stringify(baseline);
    const data = { baseline, samples: 0, changedFrames: 0, changes: [], labels: [] };
    const seen = new Set();
    const started = performance.now();
    let frame;
    const tick = () => {
      const geometry = capture(), value = JSON.stringify(geometry);
      data.samples++;
      if (value !== serialized) {
        data.changedFrames++;
        if (!seen.has(value) && data.changes.length < 30) { seen.add(value); data.changes.push({ ms: performance.now() - started, geometry }); }
      }
      const label = document.querySelector('#refresh-label').textContent;
      if (!data.labels.includes(label)) data.labels.push(label);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.finishRevisionFrames = () => { cancelAnimationFrame(frame); return { ...data, elapsedMs: performance.now() - started, final: capture() }; };
  }, atEnd);
}

/** 测量每个直接文字节点；字形宽度可变化，但必须容纳于稳定的元素及所属分组。 */
async function measure(page, label) {
  const value = await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const rectObject = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
    const elements = [...toolbar.querySelectorAll('*')].filter(node => node.tagName !== 'OPTION').map(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const group = node.closest('.project-heading,.project-picker,.completion,.filter,.refresh-state,.view-actions');
      const text = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim());
      return { key: node.id || node.dataset.count || node.dataset.filter || `${node.tagName}.${node.className}`,
        rect: rectObject(rect), group: group && rectObject(group.getBoundingClientRect()), visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0,
        ellipsis: style.textOverflow === 'ellipsis', text: node.textContent.trim(),
        ranges: text.flatMap(child => { const range = document.createRange(); range.selectNodeContents(child); return [...range.getClientRects()].map(rectObject); }) };
    });
    return { width: innerWidth, toolbar: rectObject(toolbar.getBoundingClientRect()), clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth, elements,
      revision: document.querySelector('#project-revision').textContent, completion: document.querySelector('#completion-label').textContent,
      ratio: document.querySelector('progress').value };
  });
  const defects = [];
  for (const item of value.elements) {
    const inside = (a, b) => a.left >= b.left - .1 && a.right <= b.right + .1 && a.top >= b.top - .1 && a.bottom <= b.bottom + .1;
    // 只有既有装饰图标与live模式演示徽标可以隐藏；业务文字不能通过隐藏/省略来通过检查。
    if (!item.visible && item.key !== 'demo-badge' && item.key !== 'SPAN.filter-icon') defects.push(`${item.key}: invisible`);
    if (!item.visible) continue;
    if (item.group && !inside(item.rect, item.group)) defects.push(`${item.key}: outside group`);
    if (value.width >= 1366 && !inside(item.rect, value.toolbar)) defects.push(`${item.key}: outside toolbar`);
    if (item.key !== 'project-name' && item.ranges.some(range => !inside(range, item.rect))) defects.push(`${item.key}: text overflow`);
  }
  await page.screenshot({ path: path.join(output, `${label}.png`) });
  return { label, ...value, defects };
}

/** 等自然五秒轮询显示确切的修订、指纹、各类计数与进度，禁止仅凭响应数宣称更新。 */
async function waitForSnapshot(page, expected, registryCount) {
  await expect(page.locator('#project-revision')).toHaveText(`r${expected.revision} · ${expected.sourceFingerprint.replace(/^sha256:/, '').slice(0, 8)}`, { timeout: 25000 });
  await expect(page.locator('#project-name')).toHaveText(expected.project.name);
  for (const count of ['continuable', 'ready', 'waiting', 'blocked', 'completed', 'inProgress', 'pending', 'cancelled']) {
    await expect(page.locator(`[data-count="${count}"]`)).toHaveText(String(expected.counts[count]));
  }
  await expect(page.locator('#project-list-count')).toHaveText(`${registryCount} 项登记`, { timeout: 10000 });
  assert.equal(await page.locator('progress').evaluate(node => node.value), expected.counts.progress.ratio ?? 0);
  // 取消和归档说明都必须真实随计数出现/消失；不冻结文案换取几何稳定。
  const { done, total } = expected.counts.progress;
  const exclusions = [['cancelled', '已取消'], ['archived', '已归档']].filter(([key]) => expected.counts[key])
    .map(([key, word]) => `${expected.counts[key]} 项${word}`);
  await expect(page.locator('#completion-label')).toHaveText(total ? `${done} / ${total} 完成${exclusions.length ? `（另有 ${exclusions.join('，')}）` : ''}` : '无可统计任务');
  await expect(page.locator('progress')).toHaveAttribute('aria-valuetext', total ? `${done} / ${total} 来源声明完成` : '无可统计任务');
}

/** 同时核验自有项目与登记文件字节；有意变更只发生在两个只读窗口之间。 */
async function readonlyState() {
  return { project: await fixtureFileBaseline(fixture.root), registry: createHash('sha256')
    .update(await readFile(path.join(registryDirectory, 'projects.json'))).digest('hex') };
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createReaderFixture({ works: Array.from({ length: 1000 }, (_, index) => ({ key: `DYNAMIC-${index}`, status: 'planned' })) });
  registryDirectory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'awr-dashboard-dynamic-registry-'));
  const stages = [
    { name: 'before', revision: 9, count: 9, registry: 9 },
    { name: 'two-digits', revision: 10, count: 10, registry: 10, long: true },
    { name: 'r63', revision: 63, count: 9, registry: 9 },
    { name: 'r64', revision: 64, count: 10, registry: 10, long: true },
    { name: 'r99', revision: 99, count: 99, registry: 99 },
    { name: 'r100', revision: 100, count: 100, registry: 100, long: true },
    { name: 'thousand', revision: 101, count: 0, all: true, registry: 1 },
    { name: 'empty-max-revision', revision: Number.MAX_SAFE_INTEGER, count: 0, registry: 1, long: true },
    { name: 'restore', revision: 102, count: 9, registry: 9 },
  ];
  let expected = await changeFixture(stages[0]);
  const initialBaseline = await readonlyState();
  server = createDashboardServer({ projectRoot: fixture.root, registryPath: path.join(registryDirectory, 'projects.json') });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port; assert.ok(![4317, 8765].includes(report.port));
  browser = await chromium.launch({ channel: 'chrome', headless: true }); report.browserVersion = browser.version();
  for (const [width, end] of [[2300, false], [1920, false], [1366, false], [960, true]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const scenario = { name: `${width}-${end ? 'end' : 'start'}`, responses: [], measurements: [] };
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('response', async response => {
      if (!response.url().includes('/api/snapshot')) return;
      // 名单修订变化会有意拒绝旧选择；保留服务实际错误码，不能把这种保护误判为布局回归。
      const record = { time: Date.now(), phase, status: response.status() }; scenario.responses.push(record);
      try { const body = await response.json(); record.code = body.error?.code; record.revision = body.revision; }
      catch { record.bodyUnavailable = true; }
    });
    await page.goto(`http://127.0.0.1:${report.port}/#view=graph`); await waitForSnapshot(page, expected, stages[0].registry);
    await startFrames(page, end);
    scenario.measurements.push(await measure(page, `${scenario.name}-before`));
    pages.push({ page, scenario }); report.scenarios.push(scenario);
  }
  assert.deepEqual(await readonlyState(), initialBaseline);
  report.stages.push({ ...stages[0], hash: expected.sourceFingerprint, counts: expected.counts, readonly: true });
  for (const stage of stages.slice(1)) {
    phase = stage.name;
    expected = await changeFixture(stage);
    const baseline = await readonlyState();
    await Promise.all(pages.map(({ page }) => waitForSnapshot(page, expected, stage.registry)));
    for (const { page, scenario } of pages) scenario.measurements.push(await measure(page, `${scenario.name}-${stage.name}`));
    assert.deepEqual(await readonlyState(), baseline, '每次有意变更后的纯轮询不写自有项目和登记文件');
    report.stages.push({ ...stage, hash: expected.sourceFingerprint, counts: expected.counts, readonly: true });
    console.log(`真实刷新已读回：${stage.name} r${stage.revision}`);
  }
  // 登记清单损坏只改变已支持的过期文案；恢复仍走真实名单读取，不替换DOM。
  phase = 'stale';
  await writeFile(path.join(registryDirectory, 'projects.json'), '{');
  const staleBaseline = await readonlyState();
  await Promise.all(pages.map(({ page }) => expect(page.locator('#project-list-count')).toContainText('过期', { timeout: 15000 })));
  for (const { page, scenario } of pages) scenario.measurements.push(await measure(page, `${scenario.name}-stale`));
  assert.deepEqual(await readonlyState(), staleBaseline);
  report.stages.push({ name: 'stale', readonly: true });
  phase = 'registry-restored';
  expected = await changeFixture({ name: 'registry-restored', revision: 103, count: 9, registry: 10 });
  const restoreBaseline = await readonlyState();
  await Promise.all(pages.map(({ page }) => waitForSnapshot(page, expected, 10)));
  for (const { page, scenario } of pages) {
    scenario.measurements.push(await measure(page, `${scenario.name}-registry-restored`));
    scenario.frames = await page.evaluate(() => window.finishRevisionFrames());
  }
  assert.deepEqual(await readonlyState(), restoreBaseline);
  report.stages.push({ name: 'registry-restored', revision: 103, hash: expected.sourceFingerprint, counts: expected.counts, readonly: true });
  // 先完整落盘，再统一断言，使基线失败仍保留全部阶段和截图。
  for (const scenario of report.scenarios) {
    assert.ok(scenario.frames.samples > 100 && scenario.frames.elapsedMs >= 14000);
    assert.equal(scenario.frames.changedFrames, 0, `${scenario.name}全部顶栏元素及滚动零位移`);
    assert.ok(scenario.measurements.every(item => item.defects.length === 0), `${scenario.name}文字和元素完整容纳`);
    if (!scenario.name.startsWith('960')) assert.ok(scenario.measurements.every(item => item.scrollWidth === item.clientWidth), '1366及以上无需横滚');
    assert.ok(scenario.responses.filter(item => item.status === 200).length >= stages.length);
    assert.ok(scenario.responses.every(item => item.status === 200 || (item.status === 409 && item.code === 'REGISTRY_CHANGED')
      || (item.status === 503 && item.code === 'REGISTRY_UNAVAILABLE' && item.phase !== 'before')
      || (item.status === 503 && item.code === 'REGISTRY_INVALID' && ['stale', 'registry-restored'].includes(item.phase))), '仅允许真实名单变更的已知保护性拒绝');
  }
  assert.deepEqual(report.pageErrors, []);
  report.checks = ['真实修订与来源指纹更新', '八类计数更新及1000边界', '进度与取消归档说明更新', '项目名与登记数及过期恢复', '全部顶栏逐帧零位移', '文字容纳及纯轮询只读'];
  report.passed = true;
} catch (error) { report.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1; }
finally {
  // 阶段等待失败时仍保留此前实际绘制帧，不能让最需要诊断的失败窗口丢失。
  for (const { page, scenario } of pages) if (!scenario.frames && !page.isClosed()) {
    try { scenario.frames = await page.evaluate(() => window.finishRevisionFrames()); }
    catch (error) { scenario.captureError = error.message; }
  }
  report.finishedAt = Date.now();
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (fixture) await fixture.dispose();
  if (registryDirectory) {
    const target = await realpath(registryDirectory), temp = await realpath(os.tmpdir());
    assert.equal(path.dirname(target), temp); assert.ok(path.basename(target).startsWith('awr-dashboard-dynamic-registry-'));
    await rm(target, { recursive: true, force: true });
  }
}
