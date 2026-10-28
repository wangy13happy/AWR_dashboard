import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/** 最小文档夹具仅供真实createCard构造树；不启动页面、计时器、网络或任何生产读取。 */
function fakeElement() {
  const node = { className: '', children: [], dataset: {}, style: {}, attributes: {}, textContent: '' };
  node.classList = { toggle(name, enabled) {
    const names = new Set(node.className.split(' ').filter(Boolean));
    if (enabled) names.add(name); else names.delete(name);
    node.className = [...names].join(' ');
  } };
  node.append = (...children) => node.children.push(...children);
  node.setAttribute = (name, value) => { node.attributes[name] = value; };
  return node;
}

/** 按类查找构造结果，验证可见文字与活动槽的行为而非复制样式实现。 */
function descendants(node, className) {
  return [node, ...node.children.flatMap(child => descendants(child, className))]
    .filter(child => child.className.split(' ').includes(className));
}

/** 为每例加载独立真实页面函数，固定任务位置和选择，避免测试间状态串用。 */
async function cardFor(overrides = {}, selected = false) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const startup = source.lastIndexOf('\ninitialize();');
  assert.ok(startup > 0);
  const context = vm.createContext({ document: { createElement: fakeElement, getElementById: () => null, querySelector: () => null } });
  vm.runInContext(source.slice(0, startup), context);
  const node = { key: 'A', title: '两行长名称及原始文案', status: 'in_progress', claims: [], ready: false,
    diagnostics: [], priority: 'P1', kind: 'implementation', agentRunningUntil: null, ...overrides };
  context.task = node;
  context.selected = selected;
  return vm.runInContext('state.positions.set("A", {x: 200, y: 100}); state.selectedKey = selected ? "A" : null; createCard(task)', context);
}

test('运行信号出现或过期保留同一活动槽，名称、状态和元数据文字不变', async () => {
  const cards = await Promise.all([null, Date.now() + 60000, Date.now() - 1].map(agentRunningUntil => cardFor({ agentRunningUntil })));
  for (const card of cards) {
    assert.equal(descendants(card, 'card-activity').length, 1);
    assert.equal(descendants(card, 'running-dot').length, 1);
    for (const name of ['card-title', 'card-status', 'card-meta']) {
      assert.equal(descendants(card, name)[0].textContent, descendants(cards[0], name)[0].textContent);
    }
  }
  assert.deepEqual(cards.map(card => descendants(card, 'agent-running-icon').length), [0, 1, 0]);
  assert.equal(descendants(cards[1], 'card-activity')[0].attributes['aria-hidden'], 'true');
});

test('非进行中卡片即使收到未过期信号也不显示活动槽和运行环', async () => {
  for (const status of ['completed', 'pending', 'blocked', 'cancelled', 'archived', 'unknown']) {
    const card = await cardFor({ status, agentRunningUntil: Date.now() + 60000 });
    assert.equal(descendants(card, 'card-activity').length, 0);
    assert.equal(descendants(card, 'agent-running-icon').length, 0);
  }
});

test('结构警告和有效运行信号可并存，警告文案和活动槽保持', async () => {
  const card = await cardFor({ diagnostics: [{ code: 'source_not_fresh' }], agentRunningUntil: Date.now() + 60000 });
  assert.equal(descendants(card, 'card-warning')[0].textContent, '!');
  assert.equal(descendants(card, 'card-activity').length, 1);
  assert.equal(descendants(card, 'agent-running-icon').length, 1);
  assert.equal(descendants(card, 'running-dot').length, 0);
});

/** 加载真实页面函数到隔离上下文；文档对象只提供本例需要的接口，不启动页面初始化。 */
async function appContext(documentExtras = {}) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({ document: { createElement: fakeElement, getElementById: () => null, querySelector: () => null, ...documentExtras } });
  vm.runInContext(source.slice(0, source.lastIndexOf('\ninitialize();')), context);
  return context;
}

/** 解析样式表的规则（含@supports/@media内层），只取选择器与声明文本供静态护栏断言。 */
function cssRules(css) {
  const rules = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of body.matchAll(pattern)) rules.push({ selector: match[1].trim().replace(/^@[^{]*$/, '').trim(), declarations: match[2].trim() });
  return rules;
}

test('外圈光环相位钉在文档时间线起点，只调整光环动画且缺少接口时安全跳过', async () => {
  const animations = [{ animationName: 'card-halo-rotate', startTime: 1234.5 }, { animationName: 'agent-running-spin', startTime: 50 },
    { animationName: 'card-halo-rotate', startTime: 0 }, { animationName: 'card-halo-rotate', startTime: null }];
  const context = await appContext({ getAnimations: () => animations });
  context.alignHaloRotation();
  assert.deepEqual(animations.map(animation => animation.startTime), [0, 50, 0, 0]);
  const legacy = await appContext();
  assert.doesNotThrow(() => legacy.alignHaloRotation());
});

test('运行光环与加粗边框只用不响应指针的伪元素绘制，卡片外框和布局属性不变', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rules = cssRules(css);
  const base = rules.find(rule => rule.selector === '.task-card');
  for (const declaration of ['width: 198px', 'height: 72px', 'padding: 7px 10px 6px', 'border: 1.5px solid var(--card-accent)']) assert.ok(base.declarations.includes(declaration), declaration);
  const running = rules.filter(rule => rule.selector.includes(':has(.agent-running-icon)'));
  // 卡片本身的运行态规则只允许设置光环自定义尺寸，不能改宽高、边框宽度、内外边距、定位或变换。
  for (const rule of running.filter(rule => !rule.selector.includes('::'))) {
    for (const declaration of rule.declarations.split(';').map(text => text.trim()).filter(Boolean)) assert.match(declaration, /^--card-halo-(gap|width):/);
  }
  const halo = running.find(rule => rule.selector.endsWith('::before') && rule.declarations.includes('conic-gradient'));
  assert.match(halo.declarations, /conic-gradient\(from var\(--card-halo-angle\)/);
  assert.match(halo.declarations, /animation: card-halo-rotate 2\.4s linear infinite/);
  assert.match(halo.declarations, /pointer-events: none/);
  assert.match(halo.declarations, /position: absolute/);
  const border = running.find(rule => rule.selector.endsWith('::after'));
  // 加粗边框贴住原边框内缘并用不取整的内阴影加厚；伪元素自身不带边框，不依赖设备像素取整后的边框宽。
  // 缩放小于1时按设计像素除以 --graph-scale 补偿，1:1 时 max 仍是 2px，不额外加粗。
  assert.match(border.declarations, /box-shadow: inset 0 0 0 max\(2px, calc\(2px \/ var\(--graph-scale, 1\)\)\) var\(--card-accent\)/);
  assert.match(border.declarations, /pointer-events: none/);
  assert.match(border.declarations, /inset: 0;/);
  assert.doesNotMatch(border.declarations, /border:/);
  assert.match(halo.declarations, /inset: calc\(-1px - var\(--card-halo-gap\) - var\(--card-halo-width\)\)/);
  assert.match(css, /@property --card-halo-angle \{ syntax: "<angle>"; inherits: false; initial-value: 0deg; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.task-card:has\(\.agent-running-icon\)::before \{ animation: none; \} \}/);
  // 选中规则保持原类型色外轮廓与阴影，运行时只把光环外移。
  assert.ok(rules.some(rule => rule.selector === '.task-card.is-selected, .task-card.is-selected:hover'
    && rule.declarations === 'outline: 2px solid var(--card-accent); outline-offset: 2px; box-shadow: 0 1px 7px var(--card-accent); z-index: 2;'));
  assert.ok(running.some(rule => rule.selector === '.task-card.is-selected:has(.agent-running-icon)'
    && rule.declarations === '--card-halo-gap: max(5px, calc(5px / var(--graph-scale, 1)));'));
  const sized = running.find(rule => rule.selector === '.task-card:has(.agent-running-icon)');
  assert.match(sized.declarations, /--card-halo-gap: max\(2px, calc\(2px \/ var\(--graph-scale, 1\)\)\)/);
  assert.match(sized.declarations, /--card-halo-width: max\(3px, calc\(3px \/ var\(--graph-scale, 1\)\)\)/);
});

test('选择只增加选择语义，保留原状态、可领取类型以及完整名称', async () => {
  for (const attributes of [{ status: 'completed' }, { status: 'blocked' }, { status: 'pending', ready: true }, { status: 'cancelled' }]) {
    const card = await cardFor(attributes, true);
    assert.ok(card.className.split(' ').includes(`status-${attributes.status}`));
    assert.ok(card.className.split(' ').includes('is-selected'));
    assert.equal(card.attributes['aria-pressed'], 'true');
    if (attributes.ready) assert.ok(card.className.split(' ').includes('is-ready'));
    assert.equal(descendants(card, 'card-title')[0].textContent, '两行长名称及原始文案');
  }
});
