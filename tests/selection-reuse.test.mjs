import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/** 最小元素只覆盖选择复用所调用的 DOM 面；不启动页面、计时器或网络。 */
function makeElement(tag) {
  const node = {
    tag, className: '', children: [], dataset: {}, style: { setProperty() {} }, attributes: {}, textContent: '',
    type: '', title: '', hidden: false, value: 0,
  };
  node.classList = {
    toggle(name, enabled) {
      const names = new Set(node.className.split(' ').filter(Boolean));
      if (enabled) names.add(name);
      else names.delete(name);
      node.className = [...names].join(' ');
    },
    add(name) { this.toggle(name, true); },
    remove(name) { this.toggle(name, false); },
  };
  node.append = (...children) => {
    // 与真实 DOM 一致：追加已在其中的子节点是移到末尾，不是复制一份。
    for (const child of children) {
      if (!child) continue;
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      node.children.push(child);
    }
  };
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.replaceChildren = (...children) => {
    node.children = children.flatMap((child) => child?.tag === 'fragment' ? child.children : [child]);
  };
  node.focus = () => {};
  return node;
}

/** 装入真实页面函数，停在 initialize 之前，避免轮询和名单请求。 */
async function loadPage() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const startup = source.lastIndexOf('\ninitialize();');
  assert.ok(startup > 0);
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector() { return makeElement('div'); },
    createElement: (tag) => makeElement(tag),
    createElementNS: (_namespace, tag) => makeElement(tag),
    createDocumentFragment: () => makeElement('fragment'),
    getAnimations: () => [],
    activeElement: null,
  };
  const context = vm.createContext({
    document,
    window: { history: { state: null, replaceState() {} }, localStorage: { getItem() { return null; }, setItem() {} } },
  });
  vm.runInContext(source.slice(0, startup), context);
  return context;
}

/** 在页面脚本里安装两张卡和一条依赖，字段只满足当前渲染契约。 */
function installSnapshot(context) {
  vm.runInContext(`
    const node = (key, title) => ({
      key, title, status: 'pending', claims: [], ready: false, missing: false, diagnostics: [],
      priority: 'P1', kind: 'implementation', agentRunningUntil: null, owner: null, rawStatus: 'pending',
      nextAction: title + '的下一步', summary: '', upstream: [], downstream: [], acceptance: [], evidence: [],
      continuable: false, waiting: true,
    });
    const nodes = [node('A', '任务甲'), node('B', '任务乙')];
    nodes[0].downstream = ['B'];
    nodes[1].upstream = ['A'];
    state.snapshot = { nodes, edges: [{ id: 'e1', from: 'A', to: 'B', required: true, satisfied: false }] };
    state.nodes = new Map(nodes.map((item) => [item.key, item]));
    state.positions = new Map([['A', { x: 100, y: 40 }], ['B', { x: 400, y: 40 }]]);
    state.graphSize = { width: 600, height: 120 };
    state.filter = 'all';
    state.selectedKey = null;
  `, context);
}

test('切任务复用同一批卡片和连线，只移动选中态和详情', async () => {
  const context = await loadPage();
  installSnapshot(context);
  const result = vm.runInContext(`
    renderGraph();
    const cards = [...ui.cards.children];
    const edges = [...ui.edges.children];
    selectNode('B');
    const detailText = JSON.stringify(ui.details.children);
    const highlightedAfterSelect = edges[0].className.includes('is-highlighted');
    // 单击只换详情；双击才高亮关联，高亮同样只改已有卡片和连线的样式。
    toggleFocus('B');
    ({
      cardCount: cards.length,
      edgeCount: edges.length,
      sameCards: ui.cards.children.every((card, index) => card === cards[index]),
      sameEdges: ui.edges.children.every((edge, index) => edge === edges[index]),
      firstSelected: cards[0].className.includes('is-selected'),
      secondSelected: cards[1].className.includes('is-selected'),
      pressed: cards[1].attributes['aria-pressed'],
      highlightedAfterSelect,
      highlighted: edges[0].className.includes('is-highlighted'),
      detailText,
    })
  `, context);
  assert.equal(result.cardCount, 2);
  assert.equal(result.edgeCount, 1);
  assert.equal(result.sameCards, true);
  assert.equal(result.sameEdges, true);
  assert.equal(result.firstSelected, false);
  assert.equal(result.secondSelected, true);
  assert.equal(result.pressed, 'true');
  assert.equal(result.highlightedAfterSelect, false);
  assert.equal(result.highlighted, true);
  assert.match(result.detailText, /任务乙/);
  assert.doesNotMatch(result.detailText, /任务甲的下一步/);
});

test('刷新整图仍重建卡片，未知任务不改变当前选择', async () => {
  const context = await loadPage();
  installSnapshot(context);
  const result = vm.runInContext(`
    renderGraph();
    const first = [...ui.cards.children];
    renderGraph();
    const second = [...ui.cards.children];
    selectNode('A');
    const selected = [...ui.cards.children];
    selectNode('MISSING');
    ({
      rebuilt: first.length === second.length && first.every((card, index) => card !== second[index]),
      selectedKey: state.selectedKey,
      kept: ui.cards.children.every((card, index) => card === selected[index]),
    })
  `, context);
  assert.equal(result.rebuilt, true);
  assert.equal(result.selectedKey, 'A');
  assert.equal(result.kept, true);
});
