"use strict";

const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const CARD_WIDTH = 198;
const CARD_HEIGHT = 72;
const STATUS_LABELS = { completed: "已完成", in_progress: "进行中", pending: "待办", blocked: "阻塞", cancelled: "已取消", archived: "已归档", unknown: "未知" };
const COUNT_FIELDS = ["total", "completed", "inProgress", "pending", "blocked", "cancelled", "archived", "unknown", "ready", "continuable", "waiting"];
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ui = {
  projectSelect: document.getElementById("project-select"), projectListCount: document.getElementById("project-list-count"),
  projectListBanner: document.getElementById("project-list-banner"),
  project: document.getElementById("project-name"), revision: document.getElementById("project-revision"),
  progress: document.getElementById("completion-progress"), progressLabel: document.getElementById("completion-label"),
  demo: document.getElementById("demo-badge"), filters: document.querySelector(".filters"),
  refreshLabel: document.getElementById("refresh-label"), syncDot: document.getElementById("sync-dot"),
  pause: document.getElementById("pause-button"), fit: document.getElementById("fit-button"), actual: document.getElementById("actual-button"),
  viewport: document.getElementById("graph-viewport"), world: document.getElementById("graph-world"),
  edges: document.getElementById("graph-edges"), cards: document.getElementById("graph-cards"),
  banners: document.getElementById("banners"), empty: document.getElementById("empty-state"),
  details: document.getElementById("detail-content"), source: document.getElementById("source-label"),
};
const state = {
  snapshot: null, nodes: new Map(), positions: new Map(), graphSize: { width: 0, height: 0 }, signature: "",
  selectedKey: null, selectionRemoved: false, filter: "all", x: 0, y: 0, scale: 1, viewMode: "fit", fitted: false,
  paused: false, inFlight: null, requestSerial: 0, nextRefreshAt: Date.now(), lastSuccessAt: null,
  failure: null, demoSeen: false, drag: null, timer: null, resizeObserver: null,
  projects: null, registryMode: null, registryRevision: null, registryGeneration: 0, defaultProjectId: null,
  selectedProjectId: null, projectGeneration: 0, selectionInitialized: false, noProjectReason: null,
  projectsFailure: null, projectsInFlight: null, projectsRequestSerial: 0, nextProjectsRefreshAt: Date.now(),
  projectErrors: new Map(), projectOptionsSignature: "", snapshotRegistryRevision: null, pageInactive: false,
};

/** 把接口文字作为纯文本取得，缺省内容永远不会显示成 undefined。 */
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** 创建普通元素；所有来源文字经 textContent 写入，不拼接 HTML。 */
function element(tag, className = "", content = null) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== null) result.textContent = text(content);
  return result;
}

/** 创建只含内部计算属性的矢量元素，来源文字不进入路径或样式。 */
function svgElement(tag, attributes) {
  const result = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
  return result;
}

/** 格式化快照的毫秒时刻，缺失时返回明确的未成功状态。 */
function timeLabel(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "尚无成功读取";
}

/** 登记标识只接受有界的不透明键，浏览器保存值也不能变成路径或任意查询。 */
function validProjectId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/** 核对登记列表契约；清单错误不会把最后成功名单悄悄替换为空列表。 */
function validateProjects(payload) {
  if (!payload || payload.version !== 1 || !["registry", "fixed"].includes(payload.mode)
      || typeof payload.registryRevision !== "string" || !payload.registryRevision
      || !Array.isArray(payload.projects) || !Number.isSafeInteger(payload.updatedAt)
      || (payload.defaultProjectId !== null && !validProjectId(payload.defaultProjectId))) {
    throw new Error("项目登记名单格式不兼容，请检查本地清单。");
  }
  const ids = new Set();
  for (const project of payload.projects) {
    if (!project || !validProjectId(project.id) || ids.has(project.id)
        || typeof project.name !== "string" || !project.name) throw new Error("项目登记条目不完整，请检查本地清单。");
    ids.add(project.id);
  }
  if (payload.defaultProjectId !== null && !ids.has(payload.defaultProjectId)) throw new Error("默认项目未在当前清单登记。");
  if (payload.mode === "fixed" && (payload.registryRevision !== "fixed" || payload.projects.length !== 1 || !ids.has("default"))) {
    throw new Error("固定项目名单格式不兼容。");
  }
}

/** 只读当前页面历史条目的选择；不使用会影响其他标签页的全局存储。 */
function savedProjectSelection() {
  const saved = window.history.state?.awrDashboardSelection;
  if (saved && typeof saved === "object" && !Array.isArray(saved) && Object.hasOwn(saved, "projectId")
      && (saved.projectId === null || validProjectId(saved.projectId))) return saved;
  return null;
}

/** 保存本页面条目选择，包括明确取消的空选择，刷新后不会自动回到其他项目。 */
function persistProjectSelection() {
  const previous = window.history.state;
  const preserved = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  window.history.replaceState({ ...preserved, awrDashboardSelection: { projectId: state.selectedProjectId } }, "");
}

/** 先使请求身份失效再取消网络；取消失效时的迟到响应也不能重新提交。 */
function invalidateSnapshotRequest() {
  state.requestSerial += 1;
  state.inFlight?.controller.abort();
  state.inFlight = null;
}

/** 真正切换目标时清空图、详情、筛选、视口、进度时刻和演示标识，不改变暂停。 */
function clearProjectView() {
  state.snapshot = null;
  state.snapshotRegistryRevision = null;
  state.nodes = new Map();
  state.positions = new Map();
  state.graphSize = { width: 0, height: 0 };
  state.signature = "";
  state.selectedKey = null;
  state.selectionRemoved = false;
  state.filter = "all";
  state.x = 0; state.y = 0; state.scale = 1; state.viewMode = "fit"; state.fitted = false;
  state.lastSuccessAt = null;
  state.failure = null;
  state.demoSeen = false;
  if (state.drag && ui.viewport.hasPointerCapture(state.drag.id)) ui.viewport.releasePointerCapture(state.drag.id);
  state.drag = null;
  ui.viewport.classList.remove("is-dragging");
  ui.cards.replaceChildren();
  ui.edges.replaceChildren();
  ui.edges.setAttribute("width", "0");
  ui.edges.setAttribute("height", "0");
  ui.world.style.width = "0px"; ui.world.style.height = "0px";
  applyTransform();
  renderHeader();
  renderDetails();
  renderBanners();
  renderEmpty();
}

/** 原生选择框始终列出全部登记项；只在已实际失败后标记条目，不宣称未探测项目可用。 */
function renderProjects() {
  const projects = state.projects || [];
  const signature = JSON.stringify([state.projects !== null, projects.map((project) => [project.id, project.name, state.projectErrors.get(project.id) || null])]);
  if (signature !== state.projectOptionsSignature) {
    const options = document.createDocumentFragment();
    const placeholder = element("option", "", state.projects === null ? "正在读取名单…" : projects.length ? "请选择项目" : "没有登记项目");
    placeholder.value = "";
    placeholder.disabled = true;
    options.append(placeholder);
    for (const project of projects) {
      const failure = state.projectErrors.get(project.id);
      const option = element("option", "", `${project.name}${failure ? " · 读取失败" : ""}`);
      option.value = project.id;
      option.title = failure || "登记条目；仅选中项目时读取进度，不代表已核验可用。";
      options.append(option);
    }
    ui.projectSelect.replaceChildren(options);
    state.projectOptionsSignature = signature;
  }
  ui.projectSelect.value = state.selectedProjectId || "";
  ui.projectSelect.disabled = state.projects === null || Boolean(state.projectsFailure) || projects.length === 0;
  ui.projectListCount.textContent = `${state.projects === null ? "—" : projects.length} 项登记${state.projectsFailure ? " · 过期" : ""}`;
  ui.projectSelect.closest(".project-picker").classList.toggle("is-stale", Boolean(state.projectsFailure));
  renderProjectListBanner();
}

/** 明确区分整份名单失效、当前项目移除及暂停中的登记修订过期。 */
function renderProjectListBanner() {
  let message = "";
  let failed = false;
  if (state.projectsFailure) {
    failed = true;
    message = `项目登记名单不可用：${state.projectsFailure} 已停止项目读取与切换；${state.projects === null ? "尚无成功名单" : "当前名单为过期数据"}${state.snapshot ? "，当前图也为过期数据" : ""}。清单修复后自动恢复，暂停状态保持不变。`;
  } else if (state.noProjectReason === "removed") {
    message = "当前项目已取消登记，画面已清空。请选择其他登记项目；条目重新出现时不会自动选回。";
  } else if (state.snapshot && state.registryMode === "registry" && state.snapshotRegistryRevision !== state.registryRevision) {
    message = `登记名单已变化，当前图为上次登记修订的过期数据；${state.paused ? "暂停期间不自动读取，恢复后重新核验" : "正在重新读取当前项目"}。`;
  }
  ui.projectListBanner.hidden = !message;
  ui.projectListBanner.className = `banner${failed ? " failure" : ""}`;
  ui.projectListBanner.textContent = message;
}

/** 切换先清空旧项目所有展示，再允许暂停中仅本次手动选择读取一次。 */
function chooseProject(projectId, allowPaused = false) {
  if (state.projectsFailure || !state.projects?.some((project) => project.id === projectId)) return;
  if (projectId === state.selectedProjectId) return;
  invalidateSnapshotRequest();
  state.projectGeneration += 1;
  state.selectedProjectId = projectId;
  state.noProjectReason = null;
  clearProjectView();
  persistProjectSelection();
  renderProjects();
  state.nextRefreshAt = Date.now();
  void refreshSnapshot({ allowPaused });
}

/** 消费新名单：显式移除当前选择时等待用户重选，不用默认项目静默补位。 */
function acceptProjects(payload) {
  validateProjects(payload);
  const changed = state.registryMode !== payload.mode || state.registryRevision !== payload.registryRevision;
  const recovered = Boolean(state.projectsFailure);
  if (changed) {
    // 整份名单版本也绑定到每个快照请求；同一标识改根目录后，旧读取不能继续提交。
    invalidateSnapshotRequest();
    state.registryGeneration += 1;
    state.projectErrors.clear();
  }
  state.projects = payload.projects;
  state.registryMode = payload.mode;
  state.registryRevision = payload.registryRevision;
  state.defaultProjectId = payload.defaultProjectId;
  state.projectsFailure = null;
  if ((changed || recovered) && !state.paused) state.nextRefreshAt = Date.now();
  if (!state.selectionInitialized) {
    state.selectionInitialized = true;
    const saved = savedProjectSelection();
    const wanted = saved ? saved.projectId : payload.defaultProjectId;
    if (wanted !== null && state.projects.some((project) => project.id === wanted)) chooseProject(wanted);
    else {
      state.noProjectReason = wanted !== null ? "removed" : null;
      persistProjectSelection();
      renderHeader(); renderEmpty();
    }
  } else if (state.selectedProjectId !== null && !state.projects.some((project) => project.id === state.selectedProjectId)) {
    invalidateSnapshotRequest();
    state.projectGeneration += 1;
    state.selectedProjectId = null;
    state.noProjectReason = "removed";
    clearProjectView();
    persistProjectSelection();
  }
  renderProjects();
  // 名单检查与读取分离；暂停仍更新名单，但绝不顺带轮询任意项目数据库。
  if (!state.paused && !state.inFlight && state.selectedProjectId !== null && Date.now() >= state.nextRefreshAt) void refreshSnapshot();
  renderRefreshState();
}

/** 整份清单失效即中止数据读取，保留并明确标记最后成功的名单及图。 */
function failProjects(message) {
  invalidateSnapshotRequest();
  state.projectsFailure = message;
  renderProjects();
  renderEmpty();
  renderRefreshState();
}

/** 单飞更新项目名单，超时、生命周期和旧序号均不能覆盖新的成功清单。 */
async function refreshProjects({ force = false } = {}) {
  if (state.pageInactive) return;
  if (state.projectsInFlight && !force) return;
  if (force) {
    state.projectsRequestSerial += 1;
    state.projectsInFlight?.controller.abort();
    state.projectsInFlight = null;
  }
  const serial = ++state.projectsRequestSerial;
  const controller = new AbortController();
  state.projectsInFlight = { serial, controller };
  state.nextProjectsRefreshAt = Date.now() + POLL_MS;
  let timedOut = false;
  /** 名单超时即废止序号，取消失效的迟到响应也不能解除名单错误门禁。 */
  const timeout = window.setTimeout(function projectsRequestTimeout() {
    timedOut = true;
    controller.abort();
    if (serial !== state.projectsRequestSerial || state.pageInactive) return;
    state.projectsRequestSerial += 1;
    state.projectsInFlight = null;
    failProjects("名单读取超时，请稍后重试。");
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("/api/projects", { method: "GET", cache: "no-store", credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("项目名单响应格式无效，请检查本地清单。"); }
    if (serial !== state.projectsRequestSerial || state.pageInactive) return;
    if (!response.ok) throw new Error(text(payload?.error?.message, "项目登记名单暂时不可用。"));
    acceptProjects(payload);
  } catch (error) {
    if (serial !== state.projectsRequestSerial || state.pageInactive) return;
    failProjects(timedOut ? "名单读取超时，请稍后重试。" : error instanceof TypeError ? "无法连接本地服务。" : text(error?.message, "项目登记名单暂时不可用。"));
  } finally {
    window.clearTimeout(timeout);
    // 被强制重新核验或页面恢复替代的旧请求，不能清除当前名单请求的单飞标记。
    if (state.projectsInFlight?.serial === serial) state.projectsInFlight = null;
  }
}

/** 原生选择事件支持键盘操作；无效或过期清单不能切换到任意路径。 */
function onProjectChange() {
  chooseProject(ui.projectSelect.value, true);
}

/** 在提交画面前核对关键契约；错误响应不能替换最后一次完整成功快照。 */
function validateSnapshot(snapshot) {
  const invalid = !snapshot || snapshot.version !== 1 || snapshot.readOnly !== true || !["live", "demo"].includes(snapshot.mode)
    || !snapshot.project || typeof snapshot.project.name !== "string"
    || typeof snapshot.project.id !== "string" || !snapshot.project.id
    || typeof snapshot.project.root !== "string" || !snapshot.project.root || !Number.isSafeInteger(snapshot.revision)
    || typeof snapshot.sourceFingerprint !== "string" || !Number.isSafeInteger(snapshot.updatedAt)
    || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.sources)
    || !Array.isArray(snapshot.diagnostics) || !snapshot.counts || !snapshot.counts.progress;
  if (invalid) throw new Error("快照格式不兼容，未替换已有画面。");
  for (const field of COUNT_FIELDS) {
    if (!Number.isSafeInteger(snapshot.counts[field]) || snapshot.counts[field] < 0) throw new Error("快照计数不兼容，未替换已有画面。");
  }
  const progress = snapshot.counts.progress;
  if (!Number.isSafeInteger(progress.done) || !Number.isSafeInteger(progress.total)
      || (progress.ratio !== null && (!Number.isFinite(progress.ratio) || progress.ratio < 0 || progress.ratio > 1))) {
    throw new Error("快照进度不兼容，未替换已有画面。");
  }
  const keys = new Set();
  for (const node of snapshot.nodes) {
    if (!node || typeof node.key !== "string" || !node.key || keys.has(node.key) || typeof node.title !== "string"
        || !Object.hasOwn(STATUS_LABELS, node.status) || typeof node.ready !== "boolean"
        || typeof node.continuable !== "boolean" || typeof node.waiting !== "boolean"
        || !Array.isArray(node.claims) || !Array.isArray(node.diagnostics) || !Array.isArray(node.upstream)
        || !Array.isArray(node.downstream) || !Array.isArray(node.acceptance) || !Array.isArray(node.evidence)) {
      throw new Error("任务快照不完整，未替换已有画面。");
    }
    keys.add(node.key);
  }
  for (const edge of snapshot.edges) {
    if (!edge || typeof edge.id !== "string" || !keys.has(edge.from) || !keys.has(edge.to)
        || typeof edge.required !== "boolean" || typeof edge.satisfied !== "boolean") {
      throw new Error("依赖快照不完整，未替换已有画面。");
    }
  }
}

/** 仅根据节点与依赖拓扑决定是否重新布局，状态和认领变化不会移动卡片。 */
function topologySignature(snapshot) {
  const nodes = snapshot.nodes.map((node) => node.key).sort();
  const edges = snapshot.edges.map((edge) => [edge.id, edge.from, edge.to, edge.required]).sort(compareEdgeEntries);
  return JSON.stringify([nodes, edges]);
}

/** 用稳定的完整边标识排序，避免数据库返回行次序影响拓扑签名。 */
function compareEdgeEntries(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

/** 保持工作键自然顺序，让同一数据在多次读取中获得稳定的布局输入。 */
function compareNodes(left, right) {
  return left.key.localeCompare(right.key, "zh-CN", { numeric: true });
}

/** 给分层布局提供空边标签；这是布局库要求，不包含业务执行动作。 */
function emptyEdgeLabel() {
  return {};
}

/** 复用本地 Dagre 生成左到右分层坐标；空图不伪造任何演示节点。 */
function calculateLayout(snapshot) {
  if (!snapshot.nodes.length) return { positions: new Map(), size: { width: 0, height: 0 } };
  if (!window.dagre) throw new Error("本地布局资源未加载，请刷新页面。");
  const graph = new window.dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: 88, nodesep: 16, edgesep: 8, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(emptyEdgeLabel);
  for (const node of [...snapshot.nodes].sort(compareNodes)) graph.setNode(node.key, { width: CARD_WIDTH, height: CARD_HEIGHT });
  for (const edge of [...snapshot.edges].sort(compareEdges)) graph.setEdge(edge.from, edge.to, {}, edge.id);
  window.dagre.layout(graph);
  const positions = new Map();
  for (const node of snapshot.nodes) {
    const position = graph.node(node.key);
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) throw new Error("依赖布局失败，未替换已有画面。");
    positions.set(node.key, { x: position.x, y: position.y });
  }
  return { positions, size: { width: graph.graph().width, height: graph.graph().height } };
}

/** 按依赖起点、终点和标识稳定排序，可选依赖也保留其真实连线。 */
function compareEdges(left, right) {
  return `${left.from}\u0000${left.to}\u0000${left.id}`.localeCompare(`${right.from}\u0000${right.to}\u0000${right.id}`);
}

/** 原子接受完整快照；同实际项目保留视口，登记标识改绑另一项目时重置全部交互。 */
function acceptSnapshot(snapshot) {
  validateSnapshot(snapshot);
  // 登记标识可被管理员改绑；数据库项目标识也可能因复制而相同，因此必须同时比较
  // 已核验快照的真实根与数据库身份，不能只用登记标识、拓扑或重复工作键识别项目。
  const projectChanged = state.snapshot !== null && (state.snapshot.project.root !== snapshot.project.root
    || state.snapshot.project.id !== snapshot.project.id);
  const signature = topologySignature(snapshot);
  // 先完整计算可能失败的布局，再提交状态，避免计数和图来自不同快照。
  const layout = !projectChanged && signature === state.signature ? null : calculateLayout(snapshot);
  const nextNodes = new Map(snapshot.nodes.map((node) => [node.key, node]));
  // 清空必须放在契约及布局全部成功之后；坏快照不破坏原完整画面。
  // 复用真正切换时的重置，同时保留暂停与当前登记选择，再原子提交新项目。
  if (projectChanged) clearProjectView();
  state.selectionRemoved = Boolean(state.selectedKey && !nextNodes.has(state.selectedKey));
  if (state.selectionRemoved) state.selectedKey = null;
  state.snapshot = snapshot;
  state.snapshotRegistryRevision = state.registryRevision;
  state.nodes = nextNodes;
  state.signature = signature;
  if (layout) { state.positions = layout.positions; state.graphSize = layout.size; }
  state.lastSuccessAt = snapshot.updatedAt;
  state.failure = null;
  state.projectErrors.delete(state.selectedProjectId);
  // 同一实际项目的演示来源一旦出现就保留标识，绝不作为读取失败的后备数据。
  state.demoSeen ||= snapshot.mode === "demo";
  renderHeader();
  renderGraph();
  renderDetails();
  renderBanners();
  renderEmpty();
  renderProjects();
  if (!state.fitted && snapshot.nodes.length) { fitGraph(); state.fitted = true; }
}

/** 渲染标题、来源修订及全项目计数，筛选不会改变完成进度的分母。 */
function renderHeader() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    const selected = state.projects?.find((project) => project.id === state.selectedProjectId);
    ui.project.textContent = selected?.name || "依赖进度图";
    ui.project.title = selected ? `${selected.name} · 登记项目 · 只读` : "请选择登记项目，只读查看";
    ui.revision.textContent = selected ? "尚无成功快照" : "未选择项目";
    ui.revision.title = "当前尚无成功读取的项目修订";
    ui.progress.value = 0;
    ui.progress.setAttribute("aria-valuetext", "尚无成功快照");
    ui.progressLabel.textContent = "—";
    ui.demo.hidden = !state.demoSeen;
    for (const count of document.querySelectorAll("[data-count]")) count.textContent = "—";
    ui.source.textContent = selected ? "数据源：等待选中项目的只读快照 · 完成仅为来源声明" : "数据源：请选择登记项目 · 看板仅只读查看";
    updateFilterButtons();
    return;
  }
  ui.project.textContent = snapshot.project.name;
  ui.project.title = `${snapshot.project.name} · ${text(snapshot.project.root)} · 只读`;
  const shortFingerprint = snapshot.sourceFingerprint.replace(/^sha256:/, "").slice(0, 8);
  ui.revision.textContent = `r${snapshot.revision} · ${shortFingerprint}`;
  ui.revision.title = "数据库投影修订与本轮来源核验指纹；不表示验收通过";
  ui.demo.hidden = !state.demoSeen;
  const { done, total, ratio } = snapshot.counts.progress;
  ui.progress.value = ratio === null ? 0 : ratio;
  ui.progress.setAttribute("aria-valuetext", total ? `${done} / ${total} 来源声明完成` : "无可统计任务");
  const exclusions = [];
  if (snapshot.counts.cancelled) exclusions.push(`${snapshot.counts.cancelled} 项已取消`);
  if (snapshot.counts.archived) exclusions.push(`${snapshot.counts.archived} 项已归档`);
  ui.progressLabel.textContent = total ? `${done} / ${total} 完成${exclusions.length ? `（另有 ${exclusions.join("，")}）` : ""}` : "无可统计任务";
  for (const count of document.querySelectorAll("[data-count]")) count.textContent = String(snapshot.counts[count.dataset.count]);
  ui.source.textContent = `数据源：只读稳定副本 + 来源指纹核验 · AWR（智能体工作运行时）${text(snapshot.project.awrVersion)} · 完成仅为来源声明`;
  updateFilterButtons();
}

/** 判断节点是否匹配当前展示分类，保留全部节点和真实依赖拓扑。 */
function matchesFilter(node) {
  if (state.filter === "all") return true;
  if (["continuable", "ready", "waiting"].includes(state.filter)) return node[state.filter] === true;
  return node.status === state.filter;
}

/** 更新筛选的可访问状态，同一筛选再次点击即恢复全部。 */
function updateFilterButtons() {
  for (const button of ui.filters.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
}

/** 绘制参考图的轻直线依赖；自环用短弧保留，不擅自删除或修复。 */
function edgePath(edge) {
  const from = state.positions.get(edge.from);
  const to = state.positions.get(edge.to);
  const startX = from.x + CARD_WIDTH / 2;
  const endX = to.x - CARD_WIDTH / 2;
  if (edge.from === edge.to) return `M ${startX} ${from.y - 14} C ${startX + 48} ${from.y - 60}, ${startX + 48} ${from.y + 60}, ${startX} ${from.y + 14}`;
  return `M ${startX} ${from.y} L ${endX} ${to.y}`;
}

/** 创建固定尺寸任务卡，来源内容只做纯文本和完整标题提示。 */
function createCard(node) {
  const button = element("button", `task-card status-${node.status}`);
  button.type = "button";
  button.dataset.nodeKey = node.key;
  button.dataset.testid = "node-card";
  button.setAttribute("aria-label", `${node.key} ${node.title} ${STATUS_LABELS[node.status]}`);
  button.setAttribute("aria-pressed", String(node.key === state.selectedKey));
  button.title = `${node.key} ${node.title}`;
  button.classList.toggle("is-selected", node.key === state.selectedKey);
  button.classList.toggle("is-ready", node.ready);
  button.classList.toggle("is-missing", node.missing === true);
  button.classList.toggle("is-dimmed", !matchesFilter(node));
  const position = state.positions.get(node.key);
  button.style.left = `${position.x - CARD_WIDTH / 2}px`;
  button.style.top = `${position.y - CARD_HEIGHT / 2}px`;
  const heading = element("span", "card-heading");
  heading.append(element("span", "card-key", node.key));
  const meta = [text(node.priority), text(node.kind)].filter(Boolean).join(" · ");
  heading.append(element("span", "card-meta", meta));
  button.append(heading, element("span", "card-title", node.title));
  const footer = element("span", "card-state");
  footer.append(element("span", "", node.missing ? "缺少任务" : STATUS_LABELS[node.status]));
  if (node.claims.length) {
    const icon = element("span", "claim-icon", "♟");
    icon.title = "存在有效认领；分支和负责人见详情，不表示你拥有认领";
    footer.append(icon);
  }
  if (node.ready) footer.append(element("span", "ready-label", "☛ 可领取"));
  const warnings = node.diagnostics.filter(isStructuralWarning);
  if (warnings.length) {
    const warning = element("span", "card-warning", "!");
    warning.title = warnings.map((diagnostic) => text(diagnostic.code)).join("，");
    footer.append(warning);
  } else if (node.status === "in_progress") footer.append(element("span", "running-dot"));
  button.append(footer);
  return button;
}

/** 只强调来源、环、缺失及敏感隐藏；非可领取的完成/进行中不是业务阻塞。 */
function isStructuralWarning(diagnostic) {
  const code = text(diagnostic?.code);
  return code.startsWith("source_") || ["dependency_cycle", "missing_dependency", "unknown_status", "sensitive_content_withheld"].includes(code);
}

/** 一次更新卡片与线，保持世界变换；键盘焦点随同一工作键恢复。 */
function renderGraph() {
  if (!state.snapshot) return;
  const focusedKey = document.activeElement?.closest?.("[data-node-key]")?.dataset.nodeKey;
  const paths = document.createDocumentFragment();
  for (const edge of state.snapshot.edges) {
    const className = ["dependency-edge", edge.satisfied ? "satisfied" : "", edge.required ? "" : "optional"].filter(Boolean).join(" ");
    const path = svgElement("path", { d: edgePath(edge), class: className });
    path.dataset.edgeId = edge.id;
    path.classList.toggle("is-dimmed", !matchesFilter(state.nodes.get(edge.from)) || !matchesFilter(state.nodes.get(edge.to)));
    path.classList.toggle("is-highlighted", edge.from === state.selectedKey || edge.to === state.selectedKey);
    paths.append(path);
  }
  ui.edges.setAttribute("width", String(state.graphSize.width));
  ui.edges.setAttribute("height", String(state.graphSize.height));
  ui.edges.replaceChildren(paths);
  const cards = document.createDocumentFragment();
  let focusTarget = null;
  for (const node of state.snapshot.nodes) {
    const card = createCard(node);
    if (node.key === focusedKey) focusTarget = card;
    cards.append(card);
  }
  ui.cards.replaceChildren(cards);
  ui.world.style.width = `${state.graphSize.width}px`;
  ui.world.style.height = `${state.graphSize.height}px`;
  applyTransform();
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

/** 创建详情分区，正文以独立元素写入，避免任何源字符串变成标记。 */
function detailSection(title, className = "") {
  const section = element("section", "detail-section");
  section.append(element("h3", className, title));
  return section;
}

/** 显示可点击的直接必要邻接项，仅定位本快照节点，不读取任何文件。 */
function adjacencySection(title, keys) {
  const section = detailSection(`${title} ${keys.length}）`);
  const list = element("div", "dependency-list");
  for (const key of keys) {
    const node = state.nodes.get(key);
    if (!node) continue;
    const button = element("button", `dependency-chip ${node.status}`, `${node.key} ${node.title}`);
    button.type = "button";
    button.dataset.selectKey = node.key;
    button.dataset.testid = "adjacent-node";
    list.append(button);
  }
  if (!list.childElementCount) list.append(element("span", "evidence-meta", "无"));
  section.append(list);
  return section;
}

/** 渲染当前选中任务全部允许的详情；移除的任务不保留成当前项。 */
function renderDetails() {
  const node = state.nodes.get(state.selectedKey);
  const content = document.createDocumentFragment();
  if (!node) {
    const empty = element("div", "detail-empty");
    empty.append(element("p", "", state.selectionRemoved ? "原选任务已不在当前有效投影中" : "点击任务查看详情"));
    empty.append(element("p", "", "此看板只读，不执行或认领任务。"));
    content.append(empty);
    ui.details.replaceChildren(content);
    return;
  }
  content.append(element("h2", "detail-title", `${node.key} ${node.title}`));
  const badges = element("div", "detail-badges");
  badges.append(element("span", `detail-badge ${node.status}`, STATUS_LABELS[node.status]));
  if (node.priority) badges.append(element("span", "detail-badge priority", node.priority));
  if (node.kind) badges.append(element("span", "detail-badge", node.kind));
  badges.append(element("span", "detail-badge owner", `♟ ${text(node.owner, "未标注") || "未标注"}`));
  content.append(badges);
  if (!matchesFilter(node)) content.append(element("p", "detail-selection-note", "此任务不匹配当前筛选，详情仍保留。"));
  if (node.rawStatus && node.rawStatus !== node.status) content.append(element("p", "claim-details", `原始状态：${node.rawStatus}`));
  for (const claim of node.claims) {
    const branch = claim.branchId ? `分支 ${claim.branchId}` : "主分支";
    content.append(element("p", "claim-details", `有效认领：${text(claim.agentId, "未标注") || "未标注"} · ${branch}${claim.expiresAt === null ? " · 无到期时间" : ` · 到期 ${timeLabel(claim.expiresAt)}`}`));
  }
  const next = detailSection("NEXT ACTION", "next-action");
  next.append(element("p", "", text(node.nextAction) || "未填写下一步。"));
  content.append(next);
  if (node.summary) { const summary = detailSection("摘要"); summary.append(element("p", "", node.summary)); content.append(summary); }
  content.append(adjacencySection("依赖（上游", node.upstream), adjacencySection("阻塞（下游", node.downstream));
  const acceptance = detailSection("验收标准");
  const criteria = element("ul");
  for (const criterion of node.acceptance) criteria.append(element("li", "", criterion));
  acceptance.append(criteria.childElementCount ? criteria : element("p", "evidence-meta", "没有登记验收条目。"));
  content.append(acceptance);
  const evidence = detailSection("证据（登记元数据）");
  const items = element("ul", "evidence-list");
  for (const record of node.evidence) {
    const item = element("li");
    item.append(element("code", "", text(record.locator) || text(record.summary) || "未填写定位符"));
    const metadata = [text(record.type), text(record.level), record.verifiedAt === null ? "" : `登记验证时间 ${timeLabel(record.verifiedAt)}`].filter(Boolean);
    if (metadata.length) item.append(element("span", "evidence-meta", metadata.join(" · ")));
    if (record.summary && record.summary !== record.locator) item.append(element("span", "evidence-meta", record.summary));
    if (record.sha256) item.append(element("span", "evidence-meta", `散列：${record.sha256}`));
    if (record.sourceSha) item.append(element("span", "evidence-meta", `来源修订：${record.sourceSha}`));
    items.append(item);
  }
  evidence.append(items.childElementCount ? items : element("p", "evidence-meta", "没有明确关联的登记证据。"));
  content.append(evidence);
  const diagnostics = detailSection("AWR（智能体工作运行时）诊断");
  const diagnosticList = element("ul", "diagnostic-list");
  for (const diagnostic of node.diagnostics) {
    const item = element("li");
    item.append(element("code", "diagnostic-code", text(diagnostic.code)));
    const details = [text(diagnostic.workKey), text(diagnostic.detail)].filter(Boolean).join(" · ");
    if (details) item.append(element("div", "diagnostic-detail", details));
    diagnosticList.append(item);
  }
  diagnostics.append(diagnosticList.childElementCount ? diagnosticList : element("p", "evidence-meta", "无依赖就绪诊断。"));
  content.append(diagnostics, element("p", "detail-note", "完成仅为来源声明；可领取不等于执行许可。证据定位符只展示文字，不打开或下载文件。"));
  ui.details.replaceChildren(content);
}

/** 显示来源漂移、失联旧数据与暂停提示；诊断成功不等于来源已经同步。 */
function renderBanners() {
  const banners = document.createDocumentFragment();
  if (state.failure) {
    const last = state.lastSuccessAt === null ? "尚无成功快照。" : `当前为旧数据，上次成功 ${timeLabel(state.lastSuccessAt)}。`;
    const banner = element("p", "banner failure", `读取失败 / 连接中断：${state.failure} ${last}`);
    banner.dataset.testid = "failure-banner";
    banners.append(banner);
  }
  const sources = state.snapshot?.sources || [];
  const sourceDiagnostics = state.snapshot?.diagnostics?.filter(isSourceDiagnostic) || [];
  if (sources.some(isNotFresh) || sourceDiagnostics.length) {
    const changed = sources.some(isStale) || sourceDiagnostics.some(isRegistryChange);
    const banner = element("p", "banner source-warning", `${changed ? "来源已变化" : "来源未验证"}，图为上次索引。可领取判定已保守停止；看板不会自动重新索引。`);
    banner.dataset.testid = "source-banner";
    banners.append(banner);
  }
  if (state.paused) {
    const banner = element("p", "banner pause", `已暂停进度图刷新，项目名单仍每5秒更新；手动切换仅读取一次。${state.lastSuccessAt === null ? "" : `上次成功 ${timeLabel(state.lastSuccessAt)}。`}`);
    banner.dataset.testid = "pause-banner";
    banners.append(banner);
  }
  ui.banners.replaceChildren(banners);
  renderProjectListBanner();
}

/** 辨认项目级来源诊断，不把非领取状态误报为失联。 */
function isSourceDiagnostic(diagnostic) {
  return text(diagnostic?.code).startsWith("source_");
}

/** 标识未完成当前字节核验的来源。 */
function isNotFresh(source) {
  return source.freshness !== "fresh";
}

/** 区分已知内容漂移和暂时无法核验的来源。 */
function isStale(source) {
  return source.freshness === "stale";
}

/** 识别来源注册变化，给出旧索引而非最新来源的清楚提示。 */
function isRegistryChange(diagnostic) {
  return /registry|changed|mismatch/.test(text(diagnostic.code));
}

/** 在真实空图或首次读取失败时显示空态，不自动生成演示数据。 */
function renderEmpty() {
  ui.empty.hidden = Boolean(state.snapshot?.nodes.length);
  if (ui.empty.hidden) return;
  const message = state.projectsFailure ? "项目名单不可用，已停止读取" : state.projects === null ? "正在读取登记项目…"
    : state.selectedProjectId === null ? state.noProjectReason === "removed" ? "当前项目已取消登记，请重新选择" : state.projects.length ? "请选择登记项目" : "没有登记项目"
    : state.snapshot ? "没有有效工作项" : state.failure ? "暂时无法读取当前项目" : state.inFlight ? "正在读取项目…" : state.paused ? "已暂停，尚无成功快照" : "正在读取项目…";
  ui.empty.replaceChildren(element("p", "", message));
}

/** 更新进度图倒计时；暂停仅停止图读取，名单检查仍继续。 */
function renderRefreshState() {
  let appearance = state.inFlight ? "loading" : "";
  let label = state.inFlight ? "正在读取" : `每 5s 刷新 · ${timeLabel(state.lastSuccessAt)} 后 ${Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000))}s`;
  if (state.projects === null) { appearance = "loading"; label = "正在读取项目名单"; }
  else if (state.selectedProjectId === null) { appearance = "paused"; label = "等待选择项目"; }
  if (state.failure) { appearance = "failed"; label = state.snapshot ? "读取失败 · 保留旧数据" : "读取失败"; }
  if (state.paused) { appearance = "paused"; label = "已暂停"; }
  if (state.projectsFailure) { appearance = "failed"; label = "名单不可用 · 已停止读取"; }
  ui.syncDot.className = `sync-dot ${appearance}`;
  ui.refreshLabel.textContent = label;
  ui.pause.textContent = state.paused ? "恢复" : "暂停";
  ui.pause.setAttribute("aria-pressed", String(state.paused));
}

/** 核对请求序号、项目切换代次和清单代次，连A至B至A的第一份A也不能提交。 */
function isCurrentSnapshotRequest(request) {
  return request.serial === state.requestSerial && request.projectId === state.selectedProjectId
    && request.projectGeneration === state.projectGeneration && request.registryGeneration === state.registryGeneration
    && request.registryRevision === state.registryRevision && !state.projectsFailure && !state.pageInactive
    && (!state.paused || request.allowPaused);
}

/** 仅旧固定模式夹具可省略新增身份；多项目响应必须显式匹配当前登记标识与版本。 */
function validateSnapshotIdentity(snapshot, request) {
  if (state.registryMode === "registry") {
    if (snapshot?.selectedProjectId !== request.projectId || snapshot?.registryRevision !== request.registryRevision) {
      throw new Error("快照的项目或登记修订不匹配，未替换已有画面。");
    }
  } else if ((snapshot?.selectedProjectId !== undefined && snapshot.selectedProjectId !== request.projectId)
      || (snapshot?.registryRevision !== undefined && snapshot.registryRevision !== request.registryRevision)) {
    throw new Error("固定快照的项目身份不匹配，未替换已有画面。");
  }
}

/** 绑定不可变目标读取快照；5秒超时与多重代次防止暂停或切换后的迟到覆盖。 */
async function refreshSnapshot({ allowPaused = false } = {}) {
  if ((state.paused && !allowPaused) || state.inFlight || state.projectsFailure || state.pageInactive
      || state.selectedProjectId === null || !state.projects) return;
  const serial = ++state.requestSerial;
  const controller = new AbortController();
  const request = { serial, controller, allowPaused, projectId: state.selectedProjectId,
    projectGeneration: state.projectGeneration, registryGeneration: state.registryGeneration, registryRevision: state.registryRevision };
  state.inFlight = request;
  state.nextRefreshAt = Date.now() + POLL_MS;
  let timedOut = false;
  /** 先废止逻辑请求再取消网络；即使底层没有响应取消，5秒后的响应也不能提交。 */
  const timeout = window.setTimeout(function requestTimeout() {
    timedOut = true;
    if (isCurrentSnapshotRequest(request)) {
      state.failure = "读取超时，请稍后重试。";
      state.projectErrors.set(request.projectId, state.failure);
      state.requestSerial += 1;
      state.inFlight = null;
      renderProjects(); renderBanners(); renderEmpty(); renderRefreshState();
    }
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  renderRefreshState();
  renderEmpty();
  try {
    // 固定模式保留原请求形状；登记模式只传清单标识，不把任意根目录暴露为选择接口。
    const query = new URLSearchParams({ project: request.projectId, registry: request.registryRevision });
    const address = state.registryMode === "fixed" ? "/api/snapshot" : `/api/snapshot?${query}`;
    const response = await fetch(address, { method: "GET", cache: "no-store", credentials: "omit", headers: { Accept: "application/json" }, signal: controller.signal });
    let payload;
    try {
      payload = await response.json();
    } catch {
      // JSON解析器的原始异常可能包含响应片段；错误提示只能使用固定文字。
      throw new Error("服务响应格式无效，未替换已有画面。");
    }
    if (!isCurrentSnapshotRequest(request)) return;
    if (!response.ok) {
      const code = text(payload?.error?.code);
      if (state.registryMode === "registry" && (code.startsWith("REGISTRY_") || code === "PROJECT_NOT_REGISTERED")) {
        // 服务在读取期间已发现名单变化/损坏：立刻阻断旧版本并强制核验名单，
        // 不能把清单错误记为单项目故障，更不能等待旧名单请求来解除门禁。
        failProjects(text(payload?.error?.message, "项目登记已变化，正在重新核验名单。"));
        void refreshProjects({ force: true });
        return;
      }
      throw new Error(text(payload?.error?.message, "本轮快照不可用，请稍后重试。"));
    }
    validateSnapshotIdentity(payload, request);
    acceptSnapshot(payload);
  } catch (error) {
    if (!isCurrentSnapshotRequest(request)) return;
    state.failure = timedOut ? "读取超时，请稍后重试。" : error instanceof TypeError ? "无法连接本地服务，请确认服务仍在运行。" : text(error?.message, "本轮快照不可用，请稍后重试。");
    state.projectErrors.set(request.projectId, state.failure);
    renderProjects();
    renderBanners();
    renderEmpty();
  } finally {
    window.clearTimeout(timeout);
    // 恢复可能已经发出新请求，旧请求结束时不能清除新请求的单飞状态。
    if (state.inFlight?.serial === serial) { state.inFlight = null; renderRefreshState(); }
  }
}

/** 250毫秒检查节拍并更新倒计时，单飞保护避免慢服务下请求堆积。 */
function onClockTick() {
  if (state.pageInactive) return;
  if (!state.projectsInFlight && Date.now() >= state.nextProjectsRefreshAt) void refreshProjects();
  // 自动图读取先等本节拍的名单核验；手动选择仍可立即读取已合法登记的目标。
  if (!state.paused && !state.projectsInFlight && !state.inFlight && Date.now() >= state.nextRefreshAt) void refreshSnapshot();
  renderRefreshState();
}

/** 暂停先使旧序号失效再取消请求；恢复立即读取，不等待下一节拍。 */
function togglePause() {
  state.paused = !state.paused;
  if (state.paused) {
    invalidateSnapshotRequest();
  } else { state.nextRefreshAt = Date.now(); void refreshSnapshot(); }
  renderRefreshState();
  renderBanners();
  renderEmpty();
}

/** 写入唯一画布世界变换，使线与按钮卡片始终同步平移和缩放。 */
function applyTransform() {
  ui.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  ui.world.dataset.scale = String(state.scale);
}

/** 根据画布可用宽度适配并居中；小图保持卡片原尺寸，不无限放大。 */
function fitGraph() {
  if (!state.graphSize.width) return;
  state.scale = Math.max(.001, Math.min(1, (ui.viewport.clientWidth - 64) / state.graphSize.width));
  state.x = (ui.viewport.clientWidth - state.graphSize.width * state.scale) / 2;
  state.y = (ui.viewport.clientHeight - state.graphSize.height * state.scale) / 2;
  state.viewMode = "fit";
  applyTransform();
}

/** 恢复卡片原尺寸，并把依赖图中心放回画布中心。 */
function actualSize() {
  state.scale = 1;
  state.x = (ui.viewport.clientWidth - state.graphSize.width) / 2;
  state.y = (ui.viewport.clientHeight - state.graphSize.height) / 2;
  state.viewMode = "actual";
  applyTransform();
}

/** 选中同快照节点；邻接定位保持缩放，不执行或认领任何任务。 */
function selectNode(key, center = false) {
  if (!state.nodes.has(key)) return;
  state.selectedKey = key;
  state.selectionRemoved = false;
  renderGraph();
  renderDetails();
  if (center) {
    const position = state.positions.get(key);
    state.x = ui.viewport.clientWidth / 2 - position.x * state.scale;
    state.y = ui.viewport.clientHeight / 2 - position.y * state.scale;
    state.viewMode = "manual";
    applyTransform();
  }
}

/** 通过事件委托选择任务，原生按钮同时支持 Tab、Enter 和空格。 */
function onCardClick(event) {
  const card = event.target.closest("[data-node-key]");
  if (card) selectNode(card.dataset.nodeKey);
}

/** 详情邻接按钮只选择并定位当前数据里的节点。 */
function onDetailClick(event) {
  const button = event.target.closest("[data-select-key]");
  if (button) selectNode(button.dataset.selectKey, true);
}

/** 切换淡化筛选，计数与进度保持全项目口径。 */
function onFilterClick(event) {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter === state.filter ? "all" : button.dataset.filter;
  updateFilterButtons();
  renderGraph();
  renderDetails();
}

/** 以鼠标在画布上的指针位置为缩放锚点，不改变详情栏滚动。 */
function onCanvasWheel(event) {
  if (!state.snapshot?.nodes.length) return;
  event.preventDefault();
  const rect = ui.viewport.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const worldX = (px - state.x) / state.scale;
  const worldY = (py - state.y) / state.scale;
  state.scale = Math.max(.001, Math.min(3, state.scale * Math.exp(-event.deltaY * .0015)));
  state.x = px - worldX * state.scale;
  state.y = py - worldY * state.scale;
  state.viewMode = "manual";
  applyTransform();
}

/** 从空白画布开始平移，任务按钮仍保留正常选择和键盘交互。 */
function onPointerDown(event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  state.drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: state.x, originY: state.y };
  ui.viewport.setPointerCapture(event.pointerId);
  ui.viewport.classList.add("is-dragging");
}

/** 按指针屏幕位移平移世界；状态刷新不会重置这一视口。 */
function onPointerMove(event) {
  if (!state.drag || state.drag.id !== event.pointerId) return;
  state.x = state.drag.originX + event.clientX - state.drag.startX;
  state.y = state.drag.originY + event.clientY - state.drag.startY;
  state.viewMode = "manual";
  applyTransform();
}

/** 正常结束或取消指针拖动，释放捕获，不写入任何用户数据。 */
function onPointerEnd(event) {
  if (!state.drag || state.drag.id !== event.pointerId) return;
  if (ui.viewport.hasPointerCapture(event.pointerId)) ui.viewport.releasePointerCapture(event.pointerId);
  state.drag = null;
  ui.viewport.classList.remove("is-dragging");
}

/** 仅在用户保持宽度适配模式时响应窗口尺寸变化，手工视口不跳动。 */
function onViewportResize() {
  if (state.viewMode === "fit" && state.fitted) fitGraph();
}

/** 页面离开时取消计时和读取，避免留下无效的后台轮询。 */
function onPageHide() {
  state.pageInactive = true;
  invalidateSnapshotRequest();
  state.projectsRequestSerial += 1;
  state.projectsInFlight?.controller.abort();
  state.projectsInFlight = null;
  window.clearInterval(state.timer);
  state.timer = null;
  state.resizeObserver?.disconnect();
}

/** 返回缓存中的页面时重连观察与计时；用户主动暂停的选择不被恢复事件改变。 */
function onPageShow(event) {
  if (!event.persisted) return;
  state.pageInactive = false;
  state.resizeObserver?.observe(ui.viewport);
  if (state.timer === null) state.timer = window.setInterval(onClockTick, 250);
  // 返回缓存后的名单也可能已变；先核验名单，暂停状态只限制随后图读取。
  state.nextProjectsRefreshAt = Date.now();
  state.nextRefreshAt = Date.now();
  void refreshProjects({ force: true });
  onViewportResize();
  renderRefreshState();
}

/** 绑定本地页面交互并立即读取真实项目，没有自动演示回退或写接口。 */
function initialize() {
  ui.projectSelect.addEventListener("change", onProjectChange);
  ui.pause.addEventListener("click", togglePause);
  ui.fit.addEventListener("click", fitGraph);
  ui.actual.addEventListener("click", actualSize);
  ui.filters.addEventListener("click", onFilterClick);
  ui.cards.addEventListener("click", onCardClick);
  ui.details.addEventListener("click", onDetailClick);
  ui.viewport.addEventListener("wheel", onCanvasWheel, { passive: false });
  ui.viewport.addEventListener("pointerdown", onPointerDown);
  ui.viewport.addEventListener("pointermove", onPointerMove);
  ui.viewport.addEventListener("pointerup", onPointerEnd);
  ui.viewport.addEventListener("pointercancel", onPointerEnd);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  state.resizeObserver = new ResizeObserver(onViewportResize);
  state.resizeObserver.observe(ui.viewport);
  state.timer = window.setInterval(onClockTick, 250);
  renderProjects();
  void refreshProjects();
}

initialize();
