import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { readSnapshot } from '../src/reader.js';
import { createReaderFixture, fixtureFileBaseline, fixtureId } from './reader-fixture.mjs';
import { windowsPowerShellEnvironment } from './support/background-project-fixture.mjs';

// 卡片外圈旋转光环专项：临时AWR夹具＋显式原生观察，亮灭仍走真实读取判定；不扫描真实进程或项目。
const output = path.resolve(process.env.AWR_HALO_BROWSER_ROOT ?? 'verification/card-halo-browser');
const RUNNING_KEYS = ['H-01', 'H-02', 'H-03'];
const NATIVE = Object.fromEntries(RUNNING_KEYS.map((key, index) => [key, `00000000-1111-2222-3333-00000000000${index + 1}`]));
const ALL_KEYS = ['H-00', ...RUNNING_KEYS, 'H-04'];
const report = { scope: 'temporary AWR fixture, explicit native observations, random loopback port; no real project, agent scan or production port',
  checks: [], pageErrors: [], consoleErrors: [], screenshots: [], measurements: {}, passed: false };
const states = Object.fromEntries(RUNNING_KEYS.map(key => [key, 'ended']));
const started = performance.now();
let fixture, server, browser;

/** 记录真正完成的断言；失败原文由外层保存。 */
function passed(name, detail) { report.checks.push(detail === undefined ? { name, passed: true } : { name, passed: true, detail }); }

/** 只列本测试节点的子孙浏览器进程，不枚举或停止其他项目、代理或服务。 */
async function ownedBrowserPids() {
  if (process.platform !== 'win32') return [];
  const script = `$p=@(${process.pid});$a=@();for($d=0;$d -lt 5;$d++){$n=@();foreach($id in $p){$n+=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -Property ProcessId,Name)};$a+=$n;$p=@($n|ForEach-Object ProcessId)};@($a|Where-Object Name -Match '^(chrome|headless_shell|chrome-headless-shell|msedge)[.]exe$'|Select-Object -ExpandProperty ProcessId)|ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: windowsPowerShellEnvironment(), timeout: 10000 });
  return stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
}

/**
 * 构造5张卡的专用临时项目：H-01～H-03为进行中且各有官方形状的client.bound绑定，
 * 依赖使三者落在同一列、上下相距16px；H-00完成、H-04计划，用作非运行卡片对照。
 */
async function createHaloFixture() {
  const now = Date.now();
  const created = await createReaderFixture({
    works: [
      { key: 'H-00', status: 'completed', title: '已完成前置（非运行对照）' },
      { key: 'H-01', status: 'in_progress', title: '运行中：卡片外圈旋转光环' },
      { key: 'H-02', status: 'in_progress', title: '相邻运行卡片' },
      { key: 'H-03', status: 'in_progress', title: '进行中但当前无执行回合' },
      { key: 'H-04', status: 'planned', title: '后续计划（非运行对照）' },
    ],
    edges: [{ from: 'H-04', to: 'H-01' }, ...RUNNING_KEYS.map(key => ({ from: key, to: 'H-00' }))],
  });
  created.db.exec('ALTER TABLE sessions ADD COLUMN work_item_id TEXT; ALTER TABLE sessions ADD COLUMN started_at INTEGER; ALTER TABLE sessions ADD COLUMN ended_at INTEGER;');
  created.db.exec('CREATE TABLE events(project_id TEXT,event_type TEXT,payload_json TEXT,project_revision INTEGER);');
  for (const [index, key] of RUNNING_KEYS.entries()) {
    const session = fixtureId(900 + index);
    created.db.prepare('INSERT INTO sessions(id,project_id,status,work_item_id,started_at,ended_at) VALUES(?,?,?,?,?,NULL)')
      .run(session, created.projectId, 'active', created.workIds.get(key), now - 2000);
    created.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(created.projectId, 'client.bound',
      JSON.stringify({ binding: { client: 'codex', external_session: NATIVE[key], session_id: session } }), index + 1);
  }
  return { ...created,
    /** 当前声明的原生回合状态；只有executing会被既有判定点亮，其他状态必须熄灭。 */
    observation(sampledAt) {
      return { ok: true, sampledAt, processes: [{ pid: 73111, createdAt: now - 10000, client: 'codex', alive: true,
        sessions: RUNNING_KEYS.map(key => ({ id: NATIVE[key], state: states[key], startedAt: now - 1000 })) }] };
    } };
}

/** 读取所有卡片外框、伪元素样式和滚动尺寸；伪元素外扩换算成屏幕像素并核对是否落在画布内。 */
async function inspect(page) {
  return page.evaluate((keys) => {
    const viewport = document.querySelector('.graph-viewport').getBoundingClientRect();
    const scale = Number(document.querySelector('.graph-world').dataset.scale);
    const cards = {};
    for (const key of keys) {
      const node = document.querySelector(`[data-node-key="${key}"]`);
      const rect = node.getBoundingClientRect();
      const before = getComputedStyle(node, '::before');
      const after = getComputedStyle(node, '::after');
      const style = getComputedStyle(node);
      const halo = before.content !== 'none';
      // ::before 相对卡片内边距盒定位，外扩=-(top)-实际边框宽；乘世界缩放得到屏幕像素。
      const extent = halo ? (-parseFloat(before.top) - parseFloat(style.borderTopWidth)) * scale : 0;
      cards[key] = {
        rect: [rect.x, rect.y, rect.width, rect.height],
        icon: Boolean(node.querySelector('.agent-running-icon')),
        halo, haloAnimation: before.animationName, haloPointer: before.pointerEvents, haloAngle: before.getPropertyValue('--card-halo-angle'),
        haloTop: before.top, haloPadding: before.paddingTop,
        thickBorder: after.content !== 'none' ? after.boxShadow : null,
        borderWidth: style.borderTopWidth, borderColor: style.borderTopColor,
        outline: [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset], boxShadow: style.boxShadow, zIndex: style.zIndex,
        haloInside: !halo || (rect.left - extent >= viewport.left && rect.right + extent <= viewport.right
          && rect.top - extent >= viewport.top && rect.bottom + extent <= viewport.bottom),
        extentPx: extent,
      };
    }
    // 画布以内的祖先不得裁切光环；画布本身是可平移视窗，原设计即overflow hidden。
    const clippingAncestors = [];
    for (let node = document.querySelector('.task-card').parentElement; node && !node.classList.contains('graph-viewport'); node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflow !== 'visible' || style.clipPath !== 'none' || /paint|strict|content/.test(style.contain)) clippingAncestors.push(node.className);
    }
    const scroll = Object.fromEntries([['html', document.documentElement], ['body', document.body], ['workspace', document.querySelector('.workspace')],
      ['viewport', document.querySelector('.graph-viewport')]].map(([name, node]) => [name, [node.scrollWidth, node.clientWidth]]));
    const haloAnimations = document.getAnimations().filter(animation => animation.animationName === 'card-halo-rotate').map(animation => animation.startTime);
    return { cards, scale, clippingAncestors, scroll, haloAnimations, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth };
  }, ALL_KEYS);
}

/** 两次测量的每张卡外框最大位移（像素）。 */
function maxShift(before, after) {
  let max = 0;
  for (const key of ALL_KEYS) before.cards[key].rect.forEach((value, index) => { max = Math.max(max, Math.abs(value - after.cards[key].rect[index])); });
  return max;
}

/** 屏幕像素下限。0.01 只吸收设计值除以缩放再乘回时的浮点误差，挡不住原先 0.44px、0.66px。 */
const MIN_SCREEN_PX = 1.99;

/** 内阴影第四个长度是加粗边框的局部像素；乘画布缩放后才是屏幕像素。 */
function insetPx(shadow) {
  const match = String(shadow ?? '').match(/0px 0px 0px ([0-9.]+)px inset$/);
  assert.ok(match, `加粗边框阴影无法解析: ${shadow}`);
  return Number(match[1]);
}

/** 等待指定卡片集合恰好亮起（信号节点由原期限逻辑创建/移除）。 */
async function waitRunning(page, keys) {
  await expect(page.locator('.agent-running-icon')).toHaveCount(keys.length, { timeout: 7500 });
  for (const key of keys) await expect(page.locator(`[data-node-key="${key}"] .agent-running-icon`)).toHaveCount(1);
}

/**
 * 跨多个五秒刷新逐帧采样：每帧重新按工作键取卡片（刷新会整组重建），记录外框与光环角度，
 * 并用MutationObserver统计卡片层被替换的次数，证明采样窗口内确实发生过重建。
 */
async function sampleFrames(page, durationMs, keys) {
  return page.evaluate(({ durationMs, keys }) => new Promise((resolve) => {
    const rebuilds = [];
    const observer = new MutationObserver(() => rebuilds.push(performance.now()));
    observer.observe(document.getElementById('graph-cards'), { childList: true });
    const frames = [];
    const end = performance.now() + durationMs;
    function tick(time) {
      const frame = { time, rects: {}, angles: {} };
      for (const key of keys) {
        const node = document.querySelector(`[data-node-key="${key}"]`);
        const rect = node.getBoundingClientRect();
        frame.rects[key] = [rect.x, rect.y, rect.width, rect.height];
        const angle = getComputedStyle(node, '::before').getPropertyValue('--card-halo-angle');
        if (node.querySelector('.agent-running-icon')) frame.angles[key] = parseFloat(angle);
      }
      frames.push(frame);
      if (time < end) requestAnimationFrame(tick); else { observer.disconnect(); resolve({ frames, rebuilds }); }
    }
    requestAnimationFrame(tick);
  }), { durationMs, keys });
}

/** 汇总逐帧结果：最大位移、重建次数，以及角度是否只按时间前进（回到起点会出现大幅倒退）。 */
function summarizeFrames({ frames, rebuilds }, runningKeys) {
  let maxRectShift = 0; let maxAngleStep = 0; let backwardSteps = 0; let stalledFrames = 0;
  const first = frames[0];
  for (const [index, frame] of frames.entries()) {
    for (const key of Object.keys(frame.rects)) frame.rects[key].forEach((value, i) => { maxRectShift = Math.max(maxRectShift, Math.abs(value - first.rects[key][i])); });
    if (!index) continue;
    const previous = frames[index - 1];
    const expected = (frame.time - previous.time) * 360 / 2400;
    for (const key of runningKeys) {
      // 角度按360循环比较；差值超过本帧应转角度+3度即视为跳变（含复位到0度）。
      const step = ((frame.angles[key] - previous.angles[key]) % 360 + 360) % 360;
      maxAngleStep = Math.max(maxAngleStep, Math.abs(step - expected));
      if (Math.abs(step - expected) > 3) backwardSteps += 1;
      if (step === 0) stalledFrames += 1;
    }
  }
  return { frames: frames.length, rebuilds: rebuilds.length, maxRectShift, maxAngleDeviationDeg: Number(maxAngleStep.toFixed(4)), angleJumps: backwardSteps, stalledFrames };
}

/** 截图并登记路径；clip为运行卡片列外扩区域，便于看清边框与光环。 */
async function shot(page, name, clipKeys) {
  const file = path.join(output, `${name}.png`);
  let clip;
  if (clipKeys) {
    clip = await page.evaluate((keys) => {
      const rects = keys.map(key => document.querySelector(`[data-node-key="${key}"]`).getBoundingClientRect());
      const left = Math.min(...rects.map(r => r.left)) - 28; const top = Math.min(...rects.map(r => r.top)) - 28;
      const right = Math.max(...rects.map(r => r.right)) + 28; const bottom = Math.max(...rects.map(r => r.bottom)) + 28;
      return { x: Math.max(0, left), y: Math.max(0, top), width: Math.min(innerWidth, right) - Math.max(0, left), height: Math.min(innerHeight, bottom) - Math.max(0, top) };
    }, clipKeys);
  }
  await page.screenshot({ path: file, ...(clip ? { clip } : { fullPage: true }) });
  report.screenshots.push(path.relative(output, file).split(path.sep).join('/'));
}

/** 按纵向位置找出同列的相邻卡片对，供间隙点击测试使用。 */
function adjacentPairs(state) {
  const column = RUNNING_KEYS.map(key => ({ key, rect: state.cards[key].rect })).sort((a, b) => a.rect[1] - b.rect[1]);
  return column.slice(1).map((item, index) => [column[index].key, item.key]);
}

/**
 * 点击穿透（须在1:1缩放下检查）：光环环带中的整像素点不属于任何卡片，真实点击它按画布空白处理（取消选中），不选中光环所属卡片；
 * 相邻卡片之间的整像素间隙不被任何卡片占用，紧贴下方卡片上缘的点击仍选中该卡。
 */
async function checkPointerPassThrough(page, pairs, label) {
  const hit = await page.evaluate(({ pairs }) => {
    const rect = key => document.querySelector(`[data-node-key="${key}"]`).getBoundingClientRect();
    const cardAt = (x, y) => document.elementFromPoint(x, y)?.closest('.task-card')?.dataset.nodeKey ?? null;
    const halo = rect('H-01');
    // 未选中时环带位于外缘外2~5px；取整数行floor(top)-3，距外缘3~4px，落在环带中部。
    const point = [Math.round(halo.left + halo.width / 2), Math.floor(halo.top) - 3];
    const gaps = pairs.map(([upper, lower]) => {
      const a = rect(upper); const b = rect(lower); const x = a.left + a.width / 2; const samples = [];
      // 命中测试按整像素取点；小数坐标会被取整进相邻卡片，因此只取离两侧外框至少1px的整数行。
      for (let y = Math.ceil(a.bottom) + 1; y <= Math.floor(b.top) - 1; y += 1) samples.push([y, cardAt(x, y)]);
      return { upper, lower, gapPx: b.top - a.bottom, samples, gapOwners: [...new Set(samples.map(sample => sample[1]))],
        lowerEdge: cardAt(x, b.top + 1), upperEdge: cardAt(x, a.bottom - 1) };
    });
    return { haloTop: halo.top, point, haloBand: cardAt(...point), gaps };
  }, { pairs });
  assert.equal(hit.haloBand, null, JSON.stringify(hit));
  for (const gap of hit.gaps) {
    assert.ok(gap.samples.length > 0, JSON.stringify(gap));
    assert.deepEqual(gap.gapOwners.filter(Boolean), [], JSON.stringify(gap));
    assert.equal(gap.lowerEdge, gap.lower); assert.equal(gap.upperEdge, gap.upper);
  }
  const selected = () => page.locator('[aria-pressed="true"][data-testid="node-card"]').evaluateAll(nodes => nodes.map(node => node.dataset.nodeKey));
  // 光环不接收点击：点击穿透到画布空白，按空白点击取消选中，而不是选中光环所属的 H-01。
  hit.selectionBeforeHaloClick = await selected();
  await page.mouse.click(...hit.point);
  await page.waitForTimeout(100);
  hit.selectionAfterHaloClick = await selected();
  assert.deepEqual(hit.selectionAfterHaloClick, []);
  const lower = hit.gaps[0].lower;
  const lowerRect = await page.locator(`[data-node-key="${lower}"]`).boundingBox();
  await page.mouse.click(lowerRect.x + lowerRect.width / 2, lowerRect.y + 1);
  await expect(page.locator(`[data-node-key="${lower}"]`)).toHaveAttribute('aria-pressed', 'true');
  hit.edgeClickSelected = lower;
  passed(`${label} 光环不响应点击，相邻卡片间隙与边缘点击区域不被遮挡`, hit);
  return hit;
}

/** 在一个视口宽度下完成亮灯、刷新、选中、点击穿透、减少动态和熄灭的全部检查。 */
async function runViewport(width, height, label) {
  for (const key of RUNNING_KEYS) states[key] = 'ended';
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', error => report.pageErrors.push(`${label}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`${label}: ${message.text()}`); });
  const result = {};
  await page.goto(`${base}/#view=graph`);
  await expect(page.locator('[data-testid="node-card"]')).toHaveCount(ALL_KEYS.length);
  await page.waitForTimeout(300);
  const off = await inspect(page);
  assert.equal(off.clippingAncestors.length, 0, off.clippingAncestors.join(','));
  for (const key of ALL_KEYS) assert.equal(off.cards[key].halo || off.cards[key].thickBorder !== null, false, `${key} 未运行时不应显示光环`);
  await shot(page, `${label}-not-running`, RUNNING_KEYS);
  passed(`${label} 未运行卡片无光环、无加粗边框`);

  // 亮灯：H-01、H-02进入执行回合；H-03仍是进行中但无回合，作为非运行进行中对照。
  states['H-01'] = 'executing'; states['H-02'] = 'executing';
  await waitRunning(page, ['H-01', 'H-02']);
  await page.waitForTimeout(200);
  const on = await inspect(page);
  result.lightOnShiftPx = maxShift(off, on);
  assert.equal(result.lightOnShiftPx, 0);
  assert.deepEqual(on.scroll, off.scroll);
  assert.equal(on.horizontalOverflow, false);
  for (const key of ['H-01', 'H-02']) {
    const card = on.cards[key];
    assert.equal(card.halo, true); assert.equal(card.haloAnimation, 'card-halo-rotate'); assert.equal(card.haloPointer, 'none');
    assert.equal(card.borderWidth, off.cards[key].borderWidth);
    // 局部像素乘画布缩放才是屏幕厚度。缩小视图要补偿回设计值；1:1 必须仍是 3px 环和 2px 加粗。
    const ringScreenPx = parseFloat(card.haloPadding) * on.scale;
    const thickScreenPx = insetPx(card.thickBorder) * on.scale;
    assert.ok(ringScreenPx >= MIN_SCREEN_PX, `${key} 屏幕光环 ${ringScreenPx}px`);
    assert.ok(thickScreenPx >= MIN_SCREEN_PX, `${key} 屏幕加粗 ${thickScreenPx}px`);
    if (on.scale >= 1) {
      assert.equal(card.thickBorder, `${card.borderColor} 0px 0px 0px 2px inset`);
      assert.equal(card.haloTop, '-6px'); assert.equal(card.extentPx, 5 * on.scale); assert.equal(card.haloPadding, '3px');
    } else {
      assert.ok(Math.abs(ringScreenPx - 3) < 0.08, `${key} 补偿后屏幕光环 ${ringScreenPx}px`);
      assert.ok(Math.abs(thickScreenPx - 2) < 0.08, `${key} 补偿后屏幕加粗 ${thickScreenPx}px`);
      assert.ok(Math.abs(card.extentPx - 5) < 0.2, `${key} 补偿后屏幕外扩 ${card.extentPx}px`);
    }
    assert.equal(card.haloInside, true);
    card.ringScreenPx = ringScreenPx; card.thickScreenPx = thickScreenPx;
  }
  for (const key of ['H-00', 'H-03', 'H-04']) assert.equal(on.cards[key].halo, false);
  assert.ok(on.haloAnimations.length === 2 && on.haloAnimations.every(time => time === 0), JSON.stringify(on.haloAnimations));
  passed(`${label} 亮灯前后全部卡片外框位移0px，滚动尺寸不变且无横向溢出`, { shiftPx: result.lightOnShiftPx, scroll: on.scroll, scale: on.scale });
  passed(`${label} 运行卡片显示外圈旋转光环与内加至少2屏幕像素的加粗边框，光环完整落在画布内`, { extentPx: on.cards['H-01'].extentPx, borderWidth: on.cards['H-01'].borderWidth, thickBorder: on.cards['H-01'].thickBorder, ringScreenPx: on.cards['H-01'].ringScreenPx, thickScreenPx: on.cards['H-01'].thickScreenPx });
  if (width === 390) {
    const fit = on.cards['H-01'];
    assert.ok(on.scale < 1, `390 适应宽度应缩小整图，实际 scale=${on.scale}`);
    assert.ok(fit.ringScreenPx >= MIN_SCREEN_PX, `390 屏幕光环 ${fit.ringScreenPx}px`);
    assert.ok(fit.thickScreenPx >= MIN_SCREEN_PX, `390 屏幕加粗 ${fit.thickScreenPx}px`);
    assert.equal(result.lightOnShiftPx, 0);
    result.fitWidthScreen = { scale: on.scale, ringScreenPx: fit.ringScreenPx, thickScreenPx: fit.thickScreenPx, extentPx: fit.extentPx, shiftPx: 0, card: fit.rect };
    passed('390 适应宽度屏幕光环与加粗均不少于2px，卡片位移0px', result.fitWidthScreen);
  }

  const angleA = (await inspect(page)).cards['H-01'].haloAngle;
  await shot(page, `${label}-running-rotating-a`, RUNNING_KEYS);
  await page.waitForTimeout(700);
  const angleB = (await inspect(page)).cards['H-01'].haloAngle;
  await shot(page, `${label}-running-rotating-b`, RUNNING_KEYS);
  await shot(page, `${label}-running-full`);
  assert.notEqual(angleA, angleB);
  result.rotationAngles = [angleA, angleB];
  passed(`${label} 光环持续旋转`, { angles: result.rotationAngles });

  // 跨至少两次五秒刷新逐帧采样：卡片外框不动，光环角度不因整组重建回到起点。
  const frames = summarizeFrames(await sampleFrames(page, 11000, ALL_KEYS), ['H-01', 'H-02']);
  result.refreshFrames = frames;
  assert.ok(frames.rebuilds >= 2, `rebuilds=${frames.rebuilds}`);
  assert.equal(frames.maxRectShift, 0);
  assert.equal(frames.angleJumps, 0);
  passed(`${label} 跨${frames.rebuilds}次刷新重建逐帧${frames.frames}帧外框位移0px，旋转相位连续`, frames);

  // 点击穿透按1:1像素检查。窄屏适应宽度的卡片间隙只有几个屏幕像素，整像素取样不稳定，改在原尺寸视图执行。
  if (on.scale >= 0.9) result.hitTest = await checkPointerPassThrough(page, adjacentPairs(on), label);
  else result.hitTestDeferred = `scale=${on.scale}，点击穿透改在原尺寸视图检查`;

  // 选中：运行卡片保留原类型色外轮廓和阴影，与未运行进行中卡片的选中样式完全相同；光环外移到轮廓之外。
  await page.locator('[data-node-key="H-01"]').click();
  await expect(page.locator('[data-node-key="H-01"]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);
  const selectedRunning = await inspect(page);
  await shot(page, `${label}-selected-running`, RUNNING_KEYS);
  await page.locator('[data-node-key="H-03"]').click();
  await expect(page.locator('[data-node-key="H-03"]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);
  const selectedIdle = await inspect(page);
  await shot(page, `${label}-selected-not-running`, RUNNING_KEYS);
  await page.locator('[data-node-key="H-00"]').click();
  await page.waitForTimeout(100);
  const selectedCompleted = await inspect(page);
  const runningCard = selectedRunning.cards['H-01']; const idleCard = selectedIdle.cards['H-03']; const completedCard = selectedCompleted.cards['H-00'];
  assert.deepEqual([runningCard.outline, runningCard.boxShadow, runningCard.zIndex], [idleCard.outline, idleCard.boxShadow, idleCard.zIndex]);
  assert.equal(runningCard.outline[2], runningCard.borderColor);
  assert.equal(completedCard.outline[2], completedCard.borderColor);
  if (selectedRunning.scale >= 1) assert.equal(runningCard.haloTop, '-9px');
  else assert.ok(Math.abs(runningCard.extentPx - 8) < 0.25, `选中后屏幕外扩 ${runningCard.extentPx}px`);
  assert.equal(runningCard.haloInside, true);
  assert.equal(maxShift(on, selectedRunning), 0);
  result.selected = { running: runningCard.outline, runningShadow: runningCard.boxShadow, notRunning: idleCard.outline, completed: completedCard.outline, haloTopWhenSelected: runningCard.haloTop };
  passed(`${label} 选中运行卡片保留原类型色轮廓与阴影，光环外移不盖住轮廓`, result.selected);

  // 减少动态效果：光环静止但仍显示，加粗边框保持，外框不变。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const reducedA = await inspect(page);
  await page.waitForTimeout(600);
  const reducedB = await inspect(page);
  for (const key of ['H-01', 'H-02']) {
    assert.equal(reducedA.cards[key].halo, true); assert.equal(reducedA.cards[key].haloAnimation, 'none');
    const reducedThick = insetPx(reducedA.cards[key].thickBorder) * reducedA.scale;
    assert.ok(reducedThick >= MIN_SCREEN_PX, `${key} 减少动态时屏幕加粗 ${reducedThick}px`);
    if (reducedA.scale >= 1) assert.equal(reducedA.cards[key].thickBorder, reducedA.cards[key].borderColor + ' 0px 0px 0px 2px inset');
    assert.equal(reducedA.cards[key].haloAngle, reducedB.cards[key].haloAngle);
  }
  assert.equal(maxShift(on, reducedB), 0);
  await shot(page, `${label}-running-reduced-motion`, RUNNING_KEYS);
  await shot(page, `${label}-running-reduced-motion-full`);
  result.reducedMotion = { animation: reducedA.cards['H-01'].haloAnimation, angle: reducedA.cards['H-01'].haloAngle };
  passed(`${label} 减少动态效果时静态光环与加粗边框仍显示`, result.reducedMotion);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // 熄灭：H-01回合结束后下一次刷新移除光环与加粗边框，外框仍不动。
  states['H-01'] = 'ended';
  await waitRunning(page, ['H-02']);
  await page.waitForTimeout(200);
  const lightOff = await inspect(page);
  assert.equal(lightOff.cards['H-01'].halo, false); assert.equal(lightOff.cards['H-01'].thickBorder, null);
  result.lightOffShiftPx = maxShift(off, lightOff);
  assert.equal(result.lightOffShiftPx, 0);
  passed(`${label} 回合结束后熄灭且位移0px`, { shiftPx: result.lightOffShiftPx });

  if (width < 600) {
    // 窄屏适配视图缩得很小，再用“原尺寸”查看真实像素光环；仍需完整落在画布内且无横向溢出。
    states['H-01'] = 'executing';
    await waitRunning(page, ['H-01', 'H-02']);
    await page.locator('[data-testid="actual-button"]').click();
    await page.waitForTimeout(200);
    const actual = await inspect(page);
    for (const key of ['H-01', 'H-02']) assert.equal(actual.cards[key].haloInside, true);
    assert.equal(actual.horizontalOverflow, false);
    assert.equal(actual.scale, 1);
    // 原尺寸就是 1:1，补偿不得把环或加粗再加厚。
    assert.equal(actual.cards['H-01'].haloPadding, '3px');
    assert.equal(actual.cards['H-01'].thickBorder, `${actual.cards['H-01'].borderColor} 0px 0px 0px 2px inset`);
    assert.equal(actual.cards['H-01'].haloTop, '-6px');
    await shot(page, `${label}-actual-size-running`, RUNNING_KEYS);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    await shot(page, `${label}-actual-size-reduced-motion`, RUNNING_KEYS);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    result.actualSize = { scale: actual.scale, extentPx: actual.cards['H-01'].extentPx, scroll: actual.scroll };
    result.hitTest = await checkPointerPassThrough(page, adjacentPairs(actual), `${label}原尺寸`);
    passed(`${label} 原尺寸下光环完整可见、无横向溢出`, result.actualSize);
  }
  report.measurements[label] = result;
  await page.close();
}

/** 2倍设备像素比近景：边框取整结果不同（1.5px不再变1px），核对亮灯位移0、光环与加粗边框仍贴合，并留高清截图。 */
async function closeUpHiDpi() {
  for (const key of RUNNING_KEYS) states[key] = 'ended';
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(`dpr2: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`dpr2: ${message.text()}`); });
  await page.goto(`${base}/#view=graph`);
  await expect(page.locator('[data-testid="node-card"]')).toHaveCount(ALL_KEYS.length);
  await page.waitForTimeout(300);
  const off = await inspect(page);
  states['H-01'] = 'executing'; states['H-02'] = 'executing';
  await waitRunning(page, ['H-01', 'H-02']);
  await page.waitForTimeout(200);
  const on = await inspect(page);
  const shift = maxShift(off, on);
  assert.equal(shift, 0);
  for (const key of ['H-01', 'H-02']) {
    assert.equal(on.cards[key].halo, true); assert.equal(on.cards[key].haloInside, true);
    assert.equal(on.cards[key].thickBorder, `${on.cards[key].borderColor} 0px 0px 0px 2px inset`);
  }
  await shot(page, '1366-dpr2-running', RUNNING_KEYS);
  await page.locator('[data-node-key="H-01"]').click();
  await expect(page.locator('[data-node-key="H-01"]')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(100);
  await shot(page, '1366-dpr2-selected-running', RUNNING_KEYS);
  report.measurements.dpr2 = { shiftPx: shift, borderWidth: on.cards['H-01'].borderWidth, extentPx: on.cards['H-01'].extentPx };
  passed('2倍像素比下亮灯位移0px，光环与内加2px边框贴合并完整可见', report.measurements.dpr2);
  await context.close();
}

let base;
try {
  await mkdir(output, { recursive: true });
  report.browserPidsBefore = await ownedBrowserPids();
  fixture = await createHaloFixture();
  const baseline = await fixtureFileBaseline(fixture.root);
  server = createDashboardServer({ projectRoot: fixture.root, snapshotReader: root => readSnapshot(root, { agentObservation: fixture.observation(Date.now()) }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  report.port = server.address().port;
  assert.ok(![4317, 8765].includes(report.port));
  base = `http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  await runViewport(1366, 900, '1366');
  await runViewport(390, 844, '390');
  await closeUpHiDpi();
  assert.deepEqual(await fixtureFileBaseline(fixture.root), baseline);
  passed('全部浏览器读取保持临时项目字节与元数据全等');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  passed('页面异常与控制台错误均为0');
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) { await new Promise(resolve => server.close(resolve)); await server.agentObserverStopped; report.serverListeningAfter = server.listening; }
  report.browserPidsAfter = await ownedBrowserPids();
  if (report.browserPidsAfter.length) { report.passed = false; process.exitCode = 1; }
  await fixture?.dispose();
  report.durationMs = performance.now() - started;
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, port: report.port, durationMs: report.durationMs, error: report.error }));
}
