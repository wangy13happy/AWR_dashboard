"use strict";

const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const CARD_WIDTH = 198;
const CARD_HEIGHT = 72;
const STATUS_LABELS = { completed: "已完成", in_progress: "进行中", pending: "待办", blocked: "阻塞", cancelled: "已取消", archived: "已归档", unknown: "未知" };
const COUNT_FIELDS = ["total", "completed", "inProgress", "pending", "blocked", "cancelled", "archived", "unknown", "ready", "continuable", "waiting"];
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DETAIL_WIDTH_KEY = "awrDashboardDetailWidth";
const DETAIL_MIN_WIDTH = 320;
const DETAIL_MAX_WIDTH = 720;
const DAY_MS = 86400000;
// 泳道时间线的固定排版尺寸（像素）。日宽按画布宽度在上下限之间自适应，其余尺寸固定，
// 五秒刷新时同一数据得到同一坐标，不会让任务卡或滚动位置跳动。
// 任务卡固定宽高，标题最多两行；卡片从首次活动日开始，顶部色条长度为首次到最近活动的真实跨度。
const TIMELINE = Object.freeze({ labelWidth: 220, axisHeight: 34, cardWidth: 208, cardHeight: 58, rowGap: 8, lanePadding: 10,
  undatedWidth: 232, minDayWidth: 44, maxDayWidth: 160, minBarWidth: 6, staleDays: 7 });
// 编号分组配色：按泳道顺序循环取色，时间线、总览与依赖图分组框用同一颜色；零散任务与缺少的任务用灰与粉。
const LANE_COLORS = ["#3f6fd8", "#16a07a", "#c2662d", "#8a4fd0", "#d1477a", "#2a93b8", "#9a8a1f", "#5b6bd6", "#c0392b", "#2e8b57"];
const SCATTERED_COLOR = "#8a9ab0";
const MISSING_COLOR = "#d58a9a";
// 旧版看板即改版前的依赖图：原分层坐标、无分组框、无总览。
const VIEWS = ["timeline", "graph", "classic"];
const VIEW_KEY = "awrDashboardView";
const OVERVIEW_KEY = "awrDashboardOverviewCollapsed";
// 总览“近期活动”的窗口与停滞阈值同为7天；只影响展示分组，不改变任何计数口径。
const RECENT_DAYS = 7;
// 依赖图分组框：标题行高、框内边距、框间距与框内同列卡片行距。
const GRAPH_LANE = Object.freeze({ header: 30, padding: 14, gap: 28, rowGap: 16 });
const MISSING_LANE_KEY = "~missing";
const ui = {
  projectSelect: document.getElementById("project-select"), projectListCount: document.getElementById("project-list-count"),
  projectListBanner: document.getElementById("project-list-banner"),
  project: document.getElementById("project-name"), revision: document.getElementById("project-revision"),
  progress: document.getElementById("completion-progress"), progressLabel: document.getElementById("completion-label"),
  demo: document.getElementById("demo-badge"), filters: document.querySelector(".filters"),
  refreshLabel: document.getElementById("refresh-label"), syncDot: document.getElementById("sync-dot"),
  pause: document.getElementById("pause-button"), fit: document.getElementById("fit-button"), actual: document.getElementById("actual-button"),
  viewport: document.getElementById("graph-viewport"), world: document.getElementById("graph-world"),
  edges: document.getElementById("graph-edges"), cards: document.getElementById("graph-cards"), graphLanes: document.getElementById("graph-lanes"),
  banners: document.getElementById("banners"), empty: document.getElementById("empty-state"),
  details: document.getElementById("detail-content"), source: document.getElementById("source-label"),
  workspace: document.querySelector(".workspace"), detailPanel: document.getElementById("detail-panel"), detailResizer: document.getElementById("detail-resizer"),
  canvasArea: document.getElementById("canvas-area"), viewSwitch: document.querySelector(".view-switch"),
  timelineScroll: document.getElementById("timeline-scroll"), timelineCanvas: document.getElementById("timeline-canvas"),
  overview: document.getElementById("overview"), overviewSummary: document.getElementById("overview-summary"),
  overviewToggle: document.getElementById("overview-toggle"), overviewLanes: document.getElementById("overview-lanes"),
  overviewStale: document.getElementById("overview-stale"), overviewRecent: document.getElementById("overview-recent"),
  overviewStaleTitle: document.getElementById("overview-stale-title"), overviewRecentTitle: document.getElementById("overview-recent-title"),
};
const state = {
  snapshot: null, nodes: new Map(), positions: new Map(), graphSize: { width: 0, height: 0 }, graphLanes: [], graphLayouts: null, signature: "",
  selectedKey: null, focusKey: null, selectionRemoved: false, filter: "all", x: 0, y: 0, scale: 1, viewMode: "fit", fitted: false,
  paused: false, inFlight: null, requestSerial: 0, nextRefreshAt: Date.now(), lastSuccessAt: null,
  failure: null, demoSeen: false, drag: null, dragMoved: false, timer: null, resizeObserver: null,
  projects: null, registryMode: null, registryRevision: null, registryGeneration: 0, defaultProjectId: null,
  selectedProjectId: null, projectGeneration: 0, selectionInitialized: false, noProjectReason: null,
  projectsFailure: null, projectsInFlight: null, projectsRequestSerial: 0, nextProjectsRefreshAt: Date.now(),
  projectErrors: new Map(), projectOptionsSignature: "", snapshotRegistryRevision: null, pageInactive: false,
  detailWidth: null, detailDrag: null,
  view: "timeline", timelineLayout: null, timelineScrolled: false, overviewCollapsed: false, overviewVisible: false,
};

/** 把接口文字作为纯文本取得，缺省内容永远不会显示成 undefined。 */
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** 所有任务共用可读标题；只判断空白，不改写完整标题、身份键或安全占位。 */
function taskTitle(node) {
  return node.title.trim() ? node.title : node.key;
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
  state.graphLanes = [];
  state.graphLayouts = null;
  state.signature = "";
  state.selectedKey = null;
  state.focusKey = null;
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
  ui.graphLanes.replaceChildren();
  ui.edges.replaceChildren();
  ui.edges.setAttribute("width", "0");
  ui.edges.setAttribute("height", "0");
  ui.world.style.width = "0px"; ui.world.style.height = "0px";
  ui.timelineCanvas.replaceChildren();
  ui.timelineCanvas.style.width = "0px"; ui.timelineCanvas.style.height = "0px";
  state.timelineLayout = null;
  state.timelineScrolled = false;
  applyTransform();
  renderHeader();
  renderDetails();
  renderBanners();
  renderEmpty();
  renderOverview();
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
  // 活动时间与编号分组是新增的可选字段；旧快照缺省时时间线显示说明，依赖图照常可用。
  for (const node of snapshot.nodes) {
    const activity = node.activity;
    if (activity !== undefined && activity !== null && (!Number.isSafeInteger(activity.firstAt) || !Number.isSafeInteger(activity.lastAt)
        || activity.firstAt > activity.lastAt || !Number.isSafeInteger(activity.events))) throw new Error("活动时间不兼容，未替换已有画面。");
  }
  if (snapshot.lanes !== undefined) {
    if (!Array.isArray(snapshot.lanes)) throw new Error("编号分组不兼容，未替换已有画面。");
    const grouped = new Set();
    for (const lane of snapshot.lanes) {
      if (!lane || typeof lane.key !== "string" || typeof lane.label !== "string" || !Array.isArray(lane.workKeys)
          || typeof lane.scattered !== "boolean" || !lane.counts?.progress) throw new Error("编号分组不兼容，未替换已有画面。");
      // 每个工作只能属于一个分组，且必须是本快照里的节点。
      for (const key of lane.workKeys) {
        if (!keys.has(key) || grouped.has(key)) throw new Error("编号分组不兼容，未替换已有画面。");
        grouped.add(key);
      }
    }
  }
}

/** 仅根据节点、依赖拓扑与分组成员决定是否重新布局，状态和认领变化不会移动卡片。 */
function topologySignature(snapshot) {
  const nodes = snapshot.nodes.map((node) => node.key).sort();
  const edges = snapshot.edges.map((edge) => [edge.id, edge.from, edge.to, edge.required]).sort(compareEdgeEntries);
  const lanes = (snapshot.lanes || []).map((lane) => [lane.key, [...lane.workKeys].sort()]);
  return JSON.stringify([nodes, edges, lanes]);
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
  if (!snapshot.nodes.length) {
    const empty = { positions: new Map(), size: { width: 0, height: 0 }, lanes: [] };
    return { grouped: empty, classic: empty };
  }
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
  // 同一次分层结果给出两套坐标：依赖图按编号分组分带，旧版看板沿用原分层坐标且不画框。
  const size = { width: graph.graph().width, height: graph.graph().height };
  return { grouped: groupedLayout(snapshot, positions, size), classic: { positions, size, lanes: [] } };
}

/** 按当前视图选用分组坐标或旧版原坐标；卡片、连线、适应宽度与定位都读这一套。 */
function applyGraphLayout() {
  const layout = state.graphLayouts?.[state.view === "classic" ? "classic" : "grouped"];
  if (!layout) return;
  state.positions = layout.positions;
  state.graphSize = layout.size;
  state.graphLanes = layout.lanes;
}

/**
 * 依赖图按编号分组分带：保留分层布局的列坐标，依赖仍从左到右；每个分组成为一条互不重叠的横带，
 * 顺序与时间线泳道一致，带内同列卡片按原分层次序上下排开。缺少任务的占位节点不属于任何分组，放在最后一带。
 * 只有一个分组时不画框，沿用原分层坐标。
 */
function groupedLayout(snapshot, positions, size) {
  const lanes = (snapshot.lanes || []).map((lane) => ({ key: lane.key, label: lane.label, scattered: lane.scattered, keys: lane.workKeys }));
  const grouped = new Set(lanes.flatMap((lane) => lane.keys));
  const rest = snapshot.nodes.filter((node) => !grouped.has(node.key)).map((node) => node.key).sort();
  if (rest.length) lanes.push({ key: MISSING_LANE_KEY, label: "缺少的任务", missing: true, keys: rest });
  if (lanes.length < 2) return { positions, size, lanes: [] };
  const { header, padding, gap, rowGap } = GRAPH_LANE;
  const result = new Map();
  const frames = [];
  let top = 0;
  for (const lane of lanes) {
    const columns = new Map();
    for (const key of lane.keys) {
      const { x, y } = positions.get(key);
      if (!columns.has(x)) columns.set(x, []);
      columns.get(x).push({ key, y });
    }
    let rows = 0;
    for (const [x, items] of columns) {
      items.sort((left, right) => left.y - right.y || left.key.localeCompare(right.key));
      items.forEach((item, row) => result.set(item.key, { x: x + padding, y: top + header + row * (CARD_HEIGHT + rowGap) + CARD_HEIGHT / 2 }));
      rows = Math.max(rows, items.length);
    }
    const xs = [...columns.keys()];
    const left = Math.min(...xs) - CARD_WIDTH / 2;
    const height = header + rows * CARD_HEIGHT + (rows - 1) * rowGap + padding;
    frames.push({ key: lane.key, label: lane.label, scattered: Boolean(lane.scattered), missing: Boolean(lane.missing), keys: lane.keys,
      x: left, y: top, width: Math.max(...xs) - Math.min(...xs) + CARD_WIDTH + padding * 2, height });
    top += height + gap;
  }
  return { positions: result, size: { width: size.width + padding * 2, height: top - gap }, lanes: frames };
}

/** 分组框只是底层背景：标题写分组名与完成数，状态变化随每次渲染更新，不移动卡片。 */
function laneFrame(frame, color) {
  const box = element("div", "graph-lane");
  box.style.setProperty("--lane-color", color);
  box.dataset.laneFrame = frame.key;
  box.dataset.testid = "graph-lane";
  box.classList.toggle("is-scattered", frame.scattered);
  box.classList.toggle("is-missing", frame.missing);
  box.style.left = `${frame.x}px`;
  box.style.top = `${frame.y}px`;
  box.style.width = `${frame.width}px`;
  box.style.height = `${frame.height}px`;
  const done = frame.keys.filter((key) => state.nodes.get(key)?.status === "completed").length;
  const title = element("div", "graph-lane-title");
  title.append(element("span", "graph-lane-label", frame.label), element("span", "graph-lane-count", frame.missing ? `${frame.keys.length} 项` : `${done}/${frame.keys.length} 完成`));
  title.title = frame.missing ? "依赖指向的任务在来源中不存在" : frame.scattered ? "编号不成组或无编号的任务" : "按编号前缀自动分组，不代表业务归属";
  box.append(title);
  return box;
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
  // 高亮的任务不在新快照里时同样解除高亮，不提示；详情栏的“原选任务已不在”提示只跟随选中。
  if (state.focusKey && !nextNodes.has(state.focusKey)) state.focusKey = null;
  state.snapshot = snapshot;
  state.snapshotRegistryRevision = state.registryRevision;
  state.nodes = nextNodes;
  state.signature = signature;
  if (layout) { state.graphLayouts = layout; applyGraphLayout(); }
  state.lastSuccessAt = snapshot.updatedAt;
  state.failure = null;
  state.projectErrors.delete(state.selectedProjectId);
  // 同一实际项目的演示来源一旦出现就保留标识，绝不作为读取失败的后备数据。
  state.demoSeen ||= snapshot.mode === "demo";
  renderHeader();
  renderGraph();
  renderOverview();
  renderTimeline();
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
function createCard(node, related = null) {
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
  applyFocus(button, node.key, related);
  const position = state.positions.get(node.key);
  button.style.left = `${position.x - CARD_WIDTH / 2}px`;
  button.style.top = `${position.y - CARD_HEIGHT / 2}px`;
  // 卡片只呈现名称；完整编号仍保留在数据属性、悬停说明和辅助阅读标签中。
  button.append(element("span", "card-title", taskTitle(node)));
  const footer = element("span", "card-state");
  footer.append(element("span", "card-status", node.missing ? "缺少任务" : STATUS_LABELS[node.status]));
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
  }
  if (node.status === "in_progress") {
    // 进行中卡片始终保留同一活动槽；真实运行信号只增加覆盖层，不改变名称、状态及元数据宽度。
    const slot = element("span", "card-activity");
    slot.setAttribute("aria-hidden", "true");
    if (!warnings.length) slot.append(element("span", "running-dot"));
    if (Number.isSafeInteger(node.agentRunningUntil) && node.agentRunningUntil > Date.now()) {
      const activity = element("span", "agent-running-icon");
      activity.dataset.validUntil = String(node.agentRunningUntil);
      slot.append(activity);
    }
    footer.append(slot);
  }
  // 元数据放在状态行最右侧，仅此文字可收缩省略，状态与图标保持可见。
  const meta = [text(node.priority), text(node.kind)].filter(Boolean).join(" · ");
  footer.append(element("span", "card-meta", meta));
  button.append(footer);
  return button;
}

/**
 * 高亮任务的关联集合：自身与直接上游、直接下游（含可选依赖）。没有高亮时返回 null，表示不做聚焦。
 * 高亮由双击设置，与单击决定的详情选中分开：三个视图共用，集合内卡片突出，其余渐隐；与高亮任务相连的连线加粗。
 */
function relatedKeys() {
  const focused = state.focusKey;
  if (!focused || !state.nodes.has(focused)) return null;
  const keys = new Set([focused]);
  for (const edge of state.snapshot?.edges ?? []) {
    if (edge.from === focused) keys.add(edge.to);
    if (edge.to === focused) keys.add(edge.from);
  }
  return keys;
}

/**
 * 按关联集合给卡片或任务卡打上突出/渐隐标记。
 * 正在看详情的卡片由 is-selected 表示，既不加关联光圈也不渐隐，避免高亮别处时点开的卡片看不清；
 * 高亮的那张卡片如果不是详情卡，和直接上下游一样加关联光圈。
 */
function applyFocus(element, key, related) {
  const selected = key === state.selectedKey;
  element.classList.toggle("is-related", Boolean(related?.has(key)) && !selected);
  element.classList.toggle("is-faded", Boolean(related) && !related.has(key) && !selected);
}

/** 连线是否与高亮任务直接相连。 */
function touchesFocus(edge) {
  return Boolean(state.focusKey) && (edge.from === state.focusKey || edge.to === state.focusKey);
}

/** 只强调来源、环、缺失及敏感隐藏；非可领取的完成/进行中不是业务阻塞。 */
function isStructuralWarning(diagnostic) {
  const code = text(diagnostic?.code);
  return code.startsWith("source_") || ["dependency_cycle", "missing_dependency", "unknown_status", "sensitive_content_withheld"].includes(code);
}

/** 切任务只改已有卡片和连线的选中态。
 *  不重建整图，也不发起快照请求；数量或工作键对不上当前快照时退回整图渲染。 */
function updateSelectionPresentation() {
  const cards = [...ui.cards.children];
  const edges = [...ui.edges.children];
  const nodes = state.snapshot?.nodes || [];
  const models = state.snapshot?.edges || [];
  if (cards.length !== nodes.length || edges.length !== models.length) {
    renderGraph();
    return;
  }
  const cardByKey = new Map(cards.map((card) => [card.dataset.nodeKey, card]));
  if (nodes.some((node) => !cardByKey.has(node.key))) {
    renderGraph();
    return;
  }
  const related = relatedKeys();
  ui.world.classList.toggle("has-focus", Boolean(related));
  for (const node of nodes) {
    const card = cardByKey.get(node.key);
    const selected = node.key === state.selectedKey;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
    applyFocus(card, node.key, related);
  }
  const edgeById = new Map(edges.map((edge) => [edge.dataset.edgeId, edge]));
  for (const model of models) {
    const edge = edgeById.get(model.id);
    if (!edge) {
      renderGraph();
      return;
    }
    edge.classList.toggle("is-highlighted", touchesFocus(model));
    edge.classList.toggle("is-faded", Boolean(related) && !touchesFocus(model));
  }
  // 与高亮任务相连的线移到最后绘制，压在渐隐连线之上。
  for (const model of models) if (touchesFocus(model)) ui.edges.append(edgeById.get(model.id));
}

/** 一次更新卡片与线，保持世界变换；键盘焦点随同一工作键恢复。 */
function renderGraph() {
  if (!state.snapshot) return;
  const focusedKey = document.activeElement?.closest?.("[data-node-key]")?.dataset.nodeKey;
  const paths = document.createDocumentFragment();
  const highlighted = document.createDocumentFragment();
  const related = relatedKeys();
  ui.world.classList.toggle("has-focus", Boolean(related));
  const laneOf = new Map(state.graphLanes.flatMap((frame) => frame.keys.map((key) => [key, frame.key])));
  for (const edge of state.snapshot.edges) {
    const crossLane = laneOf.size > 0 && laneOf.get(edge.from) !== laneOf.get(edge.to);
    const className = ["dependency-edge", edge.satisfied ? "satisfied" : "", edge.required ? "" : "optional", crossLane ? "cross-lane" : ""].filter(Boolean).join(" ");
    const path = svgElement("path", { d: edgePath(edge), class: className });
    path.dataset.edgeId = edge.id;
    path.classList.toggle("is-dimmed", !matchesFilter(state.nodes.get(edge.from)) || !matchesFilter(state.nodes.get(edge.to)));
    path.classList.toggle("is-highlighted", touchesFocus(edge));
    path.classList.toggle("is-faded", Boolean(related) && !touchesFocus(edge));
    (touchesFocus(edge) ? highlighted : paths).append(path);
  }
  ui.edges.setAttribute("width", String(state.graphSize.width));
  ui.edges.setAttribute("height", String(state.graphSize.height));
  // 与高亮任务相连的线最后绘制，压在其他连线之上。
  ui.edges.replaceChildren(paths, highlighted);
  const cards = document.createDocumentFragment();
  let focusTarget = null;
  for (const node of state.snapshot.nodes) {
    const card = createCard(node, related);
    if (node.key === focusedKey) focusTarget = card;
    cards.append(card);
  }
  ui.cards.replaceChildren(cards);
  const colors = laneColors(state.snapshot);
  ui.graphLanes.replaceChildren(...state.graphLanes.map((frame) => laneFrame(frame, colors.get(frame.key))));
  alignHaloRotation();
  ui.world.style.width = `${state.graphSize.width}px`;
  ui.world.style.height = `${state.graphSize.height}px`;
  applyTransform();
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}

/**
 * 依赖图卡片与时间线任务卡每次刷新都会整组重建，CSS动画会随新元素从0度重新开始；把外圈光环的起点统一钉在
 * 文档时间线0点，角度只由页面时间决定，五秒刷新时不回跳，多张运行卡片也同相旋转。
 * 只调整动画相位，不读取或改变运行期限；减少动态效果时没有该动画，自然跳过。
 */
function alignHaloRotation() {
  if (typeof document.getAnimations !== "function") return;
  for (const animation of document.getAnimations()) {
    if (animation.animationName === "card-halo-rotate" && animation.startTime !== 0) animation.startTime = 0;
  }
}

/** 浏览器所在时区的当日零点；时间线按整日划分横轴。 */
function dayStart(timestamp) {
  const day = new Date(timestamp);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** 月-日短标签，用于刻度与任务提示；时区取浏览器本地设置。 */
function dateLabel(timestamp) {
  const day = new Date(timestamp);
  return `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** 编号分组颜色表：按快照泳道顺序取色，零散任务固定灰色；依赖图“缺少的任务”框另用粉色。 */
function laneColors(snapshot) {
  const colors = new Map([[MISSING_LANE_KEY, MISSING_COLOR]]);
  let index = 0;
  for (const lane of snapshot?.lanes ?? []) colors.set(lane.key, lane.scattered ? SCATTERED_COLOR : LANE_COLORS[index++ % LANE_COLORS.length]);
  return colors;
}

/** 进行中且最近活动早于阈值时返回停滞整日数，否则为0；已完成、待办等不算停滞。 */
function staleDays(node, now) {
  if (node.status !== "in_progress" || !node.activity) return 0;
  const days = Math.floor((now - node.activity.lastAt) / DAY_MS);
  return days >= TIMELINE.staleDays ? days : 0;
}

/**
 * 计算泳道时间线坐标，不写DOM，便于先完整算完再一次替换画面。
 * 横轴从最早活动当日到今天；每张任务卡从首次活动日开始，宽度不小于固定卡宽，跨度更长时随跨度加宽，
 * 卡片顶部色条为首次到最近活动；停滞任务从卡片右缘到今天另画虚线尾巴。
 * 没有活动记录的任务放在最左侧的“无活动记录”栏，不伪造日期。
 * 同一泳道内按开始时间贪心分行：任务卡和停滞尾巴都不与同行其他任务重叠。
 */
function calculateTimeline(snapshot, viewportWidth, now) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.key, node]));
  const lanes = snapshot.lanes ?? [];
  const members = lanes.flatMap((lane) => lane.workKeys.map((key) => nodes.get(key)));
  const dated = members.filter((node) => node.activity);
  const undatedWidth = members.length > dated.length ? TIMELINE.undatedWidth : 0;
  const start = dated.length ? dayStart(Math.min(...dated.map((node) => node.activity.firstAt))) : dayStart(now);
  const days = Math.max(1, Math.round((dayStart(now) - start) / DAY_MS) + 1);
  // 右侧至少留出一张卡宽，今天开始的任务也能完整显示；日宽在上下限内尽量铺满可见宽度。
  const trailing = TIMELINE.cardWidth + 16;
  const available = viewportWidth - TIMELINE.labelWidth - undatedWidth - trailing;
  const dayWidth = Math.max(TIMELINE.minDayWidth, Math.min(TIMELINE.maxDayWidth, available / days));
  const x = (timestamp) => undatedWidth + (timestamp - start) / DAY_MS * dayWidth;
  const nowX = x(now);
  const positions = new Map();
  const laneLayouts = [];
  let top = TIMELINE.axisHeight;
  let furthest = 0;
  for (const lane of lanes) {
    const items = lane.workKeys.map((key) => nodes.get(key)).sort((left, right) =>
      (left.activity ? 1 : 0) - (right.activity ? 1 : 0) || (left.activity?.firstAt ?? 0) - (right.activity?.firstAt ?? 0)
      || compareNodes(left, right));
    const rowEnds = [];
    const placed = [];
    for (const node of items) {
      let left; let bar = 0; let width = TIMELINE.cardWidth; let stale = 0; let extent;
      if (node.activity) {
        left = x(node.activity.firstAt);
        bar = Math.max(x(node.activity.lastAt) - left, TIMELINE.minBarWidth);
        width = Math.max(TIMELINE.cardWidth, bar);
        stale = staleDays(node, now);
        // 停滞尾巴画到今天，并在今天线右侧留出“停滞”字样的位置。
        extent = Math.max(left + width, stale ? nowX + 12 : 0);
      } else {
        // 无活动记录只有卡片，没有时间色条，固定放在左侧专栏内。
        left = 12; extent = left + width;
      }
      let row = rowEnds.findIndex((end) => end + 10 <= left);
      if (row === -1) { row = rowEnds.length; rowEnds.push(extent); } else rowEnds[row] = extent;
      furthest = Math.max(furthest, extent);
      placed.push({ node, left, width, bar, stale, row });
    }
    const pitch = TIMELINE.cardHeight + TIMELINE.rowGap;
    const height = Math.max(92, TIMELINE.lanePadding * 2 + Math.max(1, rowEnds.length) * pitch - TIMELINE.rowGap);
    for (const item of placed) {
      item.top = top + TIMELINE.lanePadding + item.row * pitch;
      item.y = item.top + TIMELINE.cardHeight / 2;
      item.right = item.left + item.width;
      positions.set(item.node.key, item);
    }
    laneLayouts.push({ lane, top, height, items: placed });
    top += height;
  }
  // 轨道宽度覆盖最右的标签，否则溢出的标签会把滚动区域撑到泳道之外；
  // 数据较短时泳道仍铺满可见宽度，避免右侧露出没有底色和分隔线的空白。
  const trackWidth = Math.max(undatedWidth + days * dayWidth + trailing, furthest + 12, viewportWidth - TIMELINE.labelWidth);
  return { start, days, dayWidth, undatedWidth, nowX, trackWidth, width: TIMELINE.labelWidth + trackWidth, height: top,
    lanes: laneLayouts, positions, viewportWidth };
}

/** 生成泳道左侧固定标题：分组色条、名称、分组来源标记、完成数与停滞数、组内完成进度。 */
function laneHead(laneLayout, color) {
  const { lane, items } = laneLayout;
  const head = element("div", "lane-head");
  head.style.setProperty("--lane-color", color);
  const override = items.some((item) => item.node.group?.origin === "override");
  const origin = lane.scattered ? "零散" : lane.labelled || override ? "看板覆盖" : "编号分组";
  head.title = lane.scattered ? "只有一项或没有可辨认编号的工作；可在看板登记清单中改名、合并或指派。"
    : lane.labelled || override ? `名称或成员来自本看板登记清单的覆盖；分组键 ${lane.key}。不代表被查看项目声明的业务线。`
      : `按编号前缀 ${lane.key} 自动分组，不代表业务归属。`;
  const title = element("div", "lane-title");
  title.append(element("span", "lane-label", lane.label), element("span", `lane-origin${lane.scattered ? " scattered" : ""}`, origin));
  const { counts } = lane;
  const stale = items.filter((item) => item.stale).length;
  const parts = [`完成 ${counts.progress.done}/${counts.progress.total}`];
  if (counts.inProgress) parts.push(`进行中 ${counts.inProgress}`);
  if (counts.blocked) parts.push(`阻塞 ${counts.blocked}`);
  const summary = element("div", "lane-summary", parts.join(" · "));
  if (stale) summary.append(element("span", "lane-stale", ` · 停滞 ${stale}`));
  const progress = element("div", "lane-progress");
  const fill = element("span");
  fill.style.width = `${Math.round((counts.progress.ratio ?? 0) * 100)}%`;
  progress.append(fill);
  head.append(title, summary, progress);
  return head;
}

/** 任务卡页脚的日期范围：同日只写一次，无活动写明“无活动记录”。 */
function activityRange(node) {
  if (!node.activity) return "无活动记录";
  const first = dateLabel(node.activity.firstAt);
  const last = dateLabel(node.activity.lastAt);
  return first === last ? first : `${first} → ${last}`;
}

/**
 * 生成单张任务卡按钮：顶部色条为真实活动跨度，正文两行标题，页脚为状态、日期与停滞/认领/可领取标记。
 * 来源文字只经 textContent 写入，完整编号保留在数据属性与提示里。
 */
function timelineItem(item, now, related = null) {
  const { node } = item;
  const button = element("button", `timeline-item status-${node.status}`);
  button.type = "button";
  button.dataset.timelineKey = node.key;
  button.dataset.testid = "timeline-item";
  const range = activityRange(node);
  const staleText = item.stale ? ` · 已 ${item.stale} 天无活动` : "";
  button.title = `${node.key} ${node.title}\n${STATUS_LABELS[node.status]} · ${range}${staleText}`;
  button.setAttribute("aria-label", `${node.key} ${node.title} ${STATUS_LABELS[node.status]} ${range}${staleText}`);
  button.setAttribute("aria-pressed", String(node.key === state.selectedKey));
  button.classList.toggle("is-selected", node.key === state.selectedKey);
  button.classList.toggle("is-dimmed", !matchesFilter(node));
  button.classList.toggle("is-ready", node.ready);
  button.classList.toggle("is-undated", !node.activity);
  applyFocus(button, node.key, related);
  button.style.left = `${item.left}px`;
  button.style.top = `${item.top}px`;
  button.style.width = `${item.width}px`;
  if (node.activity) {
    const bar = element("span", "timeline-bar");
    bar.style.width = `${item.bar}px`;
    button.append(bar);
  }
  button.append(element("span", "timeline-title", taskTitle(node)));
  const footer = element("span", "timeline-meta");
  footer.append(element("span", "timeline-status", node.missing ? "缺少任务" : STATUS_LABELS[node.status]), element("span", "timeline-range", range));
  if (item.stale) footer.append(element("span", "timeline-stale-badge", `停滞 ${item.stale} 天`));
  if (node.claims.length) {
    const icon = element("span", "claim-icon", "♟");
    icon.title = "存在有效认领；分支和负责人见详情，不表示你拥有认领";
    footer.append(icon);
  }
  if (node.ready) footer.append(element("span", "ready-label", "☛ 可领取"));
  button.append(footer);
  if (Number.isSafeInteger(node.agentRunningUntil) && node.agentRunningUntil > now) {
    const running = element("span", "timeline-running");
    running.dataset.validUntil = String(node.agentRunningUntil);
    running.title = "有智能体正在执行";
    button.append(running);
  }
  return button;
}

/** 停滞尾巴：从任务卡右缘画虚线到今天；卡片本身已写明停滞天数。不响应点击，不遮挡任务卡。 */
function staleTail(item, nowX, related = null) {
  const tail = element("span", "timeline-stale-tail");
  tail.setAttribute("aria-hidden", "true");
  tail.dataset.tailKey = item.node.key;
  applyFocus(tail, item.node.key, related);
  tail.style.left = `${item.right}px`;
  tail.style.top = `${item.y - 1}px`;
  tail.style.width = `${Math.max(0, nowX - item.right)}px`;
  return tail;
}

/** 绘制时间刻度：每日竖线，按日宽稀疏标注日期，每周一加粗；左侧可有“无活动记录”专栏。 */
function timelineAxis(layout) {
  const axis = element("div", "timeline-axis");
  axis.style.width = `${layout.width}px`;
  const corner = element("div", "timeline-corner", "编号分组");
  corner.title = "泳道按工作编号前缀自动分组，不代表业务线；可在看板登记清单中改名或合并。";
  const ticks = element("div", "timeline-ticks");
  ticks.style.width = `${layout.trackWidth}px`;
  if (layout.undatedWidth) {
    const undated = element("span", "timeline-tick undated", "无活动记录");
    undated.style.width = `${layout.undatedWidth}px`;
    ticks.append(undated);
  }
  const step = Math.max(1, Math.ceil(56 / layout.dayWidth));
  for (let index = 0; index < layout.days; index += 1) {
    const day = new Date(layout.start);
    day.setDate(day.getDate() + index);
    const tick = element("span", `timeline-tick${day.getDay() === 1 ? " week" : ""}`, index % step === 0 ? dateLabel(day.getTime()) : "");
    tick.style.left = `${layout.undatedWidth + index * layout.dayWidth}px`;
    tick.style.width = `${layout.dayWidth}px`;
    ticks.append(tick);
  }
  // “今天”标签放在粘性刻度行内，纵向滚动时始终可见；竖线本身在泳道层绘制。
  const today = element("span", "timeline-today-label", "今天");
  today.style.left = `${layout.nowX}px`;
  ticks.append(today);
  axis.append(corner, ticks);
  return axis;
}

/** 高亮任务时画出它与直接上下游的连线；可选依赖用虚线。线只连接本快照内有坐标的任务。 */
function timelineRelations(layout) {
  const svg = svgElement("svg", { class: "timeline-relations", width: layout.trackWidth, height: layout.height, "aria-hidden": "true" });
  svg.style.left = `${TIMELINE.labelWidth}px`;
  const focused = state.focusKey;
  if (!focused || !layout.positions.has(focused)) return svg;
  for (const edge of state.snapshot.edges) {
    if (edge.from !== focused && edge.to !== focused) continue;
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to || from === to) continue;
    const startX = from.right;
    const endX = to.left;
    const bend = Math.max(24, Math.abs(endX - startX) / 3);
    const path = svgElement("path", { d: `M ${startX} ${from.y} C ${startX + bend} ${from.y}, ${endX - bend} ${to.y}, ${endX} ${to.y}`,
      class: ["timeline-relation", edge.satisfied ? "satisfied" : "", edge.required ? "" : "optional"].filter(Boolean).join(" ") });
    path.dataset.edgeId = edge.id;
    svg.append(path);
  }
  return svg;
}

/**
 * 整体重建泳道时间线，但保留滚动位置与键盘焦点；同一数据的坐标不变，五秒刷新不会跳动。
 * 首次显示某项目时滚到最右侧，让“今天”和最近的工作出现在视野内。
 * 依赖图视图下不计算（隐藏容器没有宽度），切换回来时再绘制。
 */
function renderTimeline() {
  if (!state.snapshot || state.view !== "timeline") return;
  const scroll = ui.timelineScroll;
  const focusedKey = document.activeElement?.closest?.("[data-timeline-key]")?.dataset.timelineKey;
  const now = Date.now();
  if (!Array.isArray(state.snapshot.lanes)) {
    ui.timelineCanvas.replaceChildren(element("p", "timeline-unavailable", "当前快照没有编号分组数据，请切换到依赖图查看。"));
    state.timelineLayout = null;
    return;
  }
  const layout = calculateTimeline(state.snapshot, scroll.clientWidth, now);
  const fragment = document.createDocumentFragment();
  fragment.append(timelineAxis(layout));
  let focusTarget = null;
  const colors = laneColors(state.snapshot);
  const related = relatedKeys();
  ui.timelineCanvas.classList.toggle("has-focus", Boolean(related));
  for (const laneLayout of layout.lanes) {
    const row = element("div", `timeline-lane${laneLayout.lane.scattered ? " scattered" : ""}`);
    row.dataset.laneKey = laneLayout.lane.key;
    row.dataset.testid = "timeline-lane";
    row.style.height = `${laneLayout.height}px`;
    row.style.width = `${layout.width}px`;
    const track = element("div", "lane-track");
    track.style.width = `${layout.trackWidth}px`;
    for (const item of laneLayout.items) {
      const local = { ...item, top: item.top - laneLayout.top, y: item.y - laneLayout.top };
      if (item.stale) track.append(staleTail(local, layout.nowX, related));
      const button = timelineItem(local, now, related);
      if (item.node.key === focusedKey) focusTarget = button;
      track.append(button);
    }
    row.append(laneHead(laneLayout, colors.get(laneLayout.lane.key)), track);
    fragment.append(row);
  }
  const today = element("div", "timeline-today");
  today.style.left = `${TIMELINE.labelWidth + layout.nowX}px`;
  today.style.height = `${layout.height}px`;
  fragment.append(today, timelineRelations(layout));
  const { scrollLeft, scrollTop } = scroll;
  ui.timelineCanvas.style.width = `${layout.width}px`;
  ui.timelineCanvas.style.height = `${layout.height}px`;
  ui.timelineCanvas.replaceChildren(fragment);
  state.timelineLayout = layout;
  if (!state.timelineScrolled && scroll.clientWidth) {
    scroll.scrollLeft = scroll.scrollWidth;
    state.timelineScrolled = true;
  } else {
    scroll.scrollLeft = scrollLeft;
    scroll.scrollTop = scrollTop;
  }
  if (focusTarget) focusTarget.focus({ preventScroll: true });
  alignHaloRotation();
}

/** 切换选中只改任务条状态并重画关系线，不重建泳道，也不发起快照请求。 */
function updateTimelineSelection() {
  const layout = state.timelineLayout;
  if (!layout || state.view !== "timeline") return;
  const related = relatedKeys();
  ui.timelineCanvas.classList.toggle("has-focus", Boolean(related));
  for (const button of ui.timelineCanvas.querySelectorAll("[data-timeline-key]")) {
    const selected = button.dataset.timelineKey === state.selectedKey;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    applyFocus(button, button.dataset.timelineKey, related);
  }
  for (const tail of ui.timelineCanvas.querySelectorAll("[data-tail-key]")) applyFocus(tail, tail.dataset.tailKey, related);
  ui.timelineCanvas.querySelector(".timeline-relations")?.replaceWith(timelineRelations(layout));
}

/** 把指定任务条滚入可见区域；只移动时间线滚动，不改变选择以外的任何状态。 */
function revealTimelineItem(key) {
  const button = [...ui.timelineCanvas.querySelectorAll("[data-timeline-key]")].find((item) => item.dataset.timelineKey === key);
  button?.scrollIntoView({ block: "nearest", inline: "center" });
}

/** 从地址片段读取视图；只接受三个固定值。没有片段时沿用本浏览器上次手动选择的视图，否则默认时间线。 */
function viewFromHash() {
  const match = window.location.hash.match(/^#view=(timeline|graph|classic)$/);
  if (match) return match[1];
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (VIEWS.includes(saved)) return saved;
  } catch {
    // 存储不可用时使用默认视图。
  }
  return "timeline";
}

/**
 * 切换视图：更新按钮与片段地址，适应宽度和1:1只作用于依赖图与旧版看板；不重新读取快照。
 * 依赖图与旧版看板共用画布但坐标不同，二者互切时换用对应坐标并重新适应宽度。
 */
function setView(view, updateHash = true, remember = false) {
  if (!VIEWS.includes(view)) return;
  const previous = state.view;
  state.view = view;
  ui.canvasArea.dataset.view = view;
  document.body.dataset.view = view;
  for (const button of ui.viewSwitch.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === view));
  ui.fit.disabled = view === "timeline";
  ui.actual.disabled = view === "timeline";
  // 片段地址不发往服务；保留历史条目里的项目选择，只替换当前条目的地址。
  if (updateHash && window.location.hash !== `#view=${view}`) window.history.replaceState(window.history.state, "", `#view=${view}`);
  if (remember) {
    try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* 存储不可用时只影响下次默认视图。 */ }
  }
  renderOverview();
  if (view === "timeline") { renderTimeline(); return; }
  const layoutChanged = (previous === "classic") !== (view === "classic");
  if (layoutChanged && state.graphLayouts) {
    applyGraphLayout();
    renderGraph();
    if (state.snapshot?.nodes.length) fitGraph();
  } else if (state.viewMode === "fit" && state.snapshot?.nodes.length) fitGraph();
}

/** 总览中的任务条目：点击即选中并在时间线中定位，与任务条共用同一选择。 */
function overviewTask(node, lead, detail, leadClass = "") {
  const button = element("button", `overview-item status-${node.status}`);
  button.type = "button";
  button.dataset.overviewKey = node.key;
  button.title = `${node.key} ${node.title}`;
  button.setAttribute("aria-current", String(node.key === state.selectedKey));
  button.append(element("span", `overview-lead${leadClass ? ` ${leadClass}` : ""}`, lead), element("span", "overview-title", taskTitle(node)),
    element("span", "overview-detail", detail));
  return button;
}

/** 列表重建时保留各自滚动位置，五秒刷新不会把已经往下翻的列表弹回顶部。 */
function replaceList(list, items, emptyText) {
  const { scrollTop } = list;
  list.replaceChildren(...(items.length ? items : [element("p", "overview-empty", emptyText)]));
  list.scrollTop = scrollTop;
}

/**
 * 渲染时间线上方的总览：各编号分组完成率、停滞任务（进行中且超过7天无活动，按停滞天数降序）、
 * 近7天有活动的任务（按最近活动降序）。只读取当前快照，口径与泳道标题一致；依赖图视图下隐藏。
 */
function renderOverview() {
  const snapshot = state.snapshot;
  const visible = Boolean(snapshot && Array.isArray(snapshot.lanes) && snapshot.nodes.length && state.view === "timeline");
  ui.overview.hidden = !visible;
  state.overviewVisible = visible;
  ui.canvasArea.classList.toggle("has-overview", visible);
  ui.canvasArea.classList.toggle("overview-collapsed", state.overviewCollapsed);
  ui.overviewToggle.textContent = state.overviewCollapsed ? "展开" : "收起";
  ui.overviewToggle.setAttribute("aria-expanded", String(!state.overviewCollapsed));
  if (!visible) return;
  const now = Date.now();
  const laneOf = new Map(snapshot.lanes.flatMap((lane) => lane.workKeys.map((key) => [key, lane])));
  const members = [...laneOf.keys()].map((key) => state.nodes.get(key));
  const stale = members.map((node) => ({ node, days: staleDays(node, now) })).filter((item) => item.days)
    .sort((left, right) => right.days - left.days || compareNodes(left.node, right.node));
  const recent = members.filter((node) => node.activity && now - node.activity.lastAt <= RECENT_DAYS * DAY_MS)
    .sort((left, right) => right.activity.lastAt - left.activity.lastAt || compareNodes(left, right));
  const inProgress = members.filter((node) => node.status === "in_progress").length;
  ui.overviewSummary.textContent = `${snapshot.lanes.length} 个编号分组 · 进行中 ${inProgress} · 停滞 ${stale.length} · 近${RECENT_DAYS}天有活动 ${recent.length}`;
  ui.overviewStaleTitle.textContent = `停滞任务（进行中且超过${TIMELINE.staleDays}天无活动）${stale.length}`;
  ui.overviewRecentTitle.textContent = `近${RECENT_DAYS}天有活动 ${recent.length}`;
  const colors = laneColors(snapshot);
  const lanes = snapshot.lanes.map((lane) => {
    const button = element("button", `overview-lane${lane.scattered ? " scattered" : ""}`);
    button.type = "button";
    button.dataset.overviewLane = lane.key;
    button.style.setProperty("--lane-color", colors.get(lane.key));
    const { progress } = lane.counts;
    const laneStale = stale.filter((item) => laneOf.get(item.node.key) === lane).length;
    button.title = `${lane.label}：完成 ${progress.done}/${progress.total}${laneStale ? `，停滞 ${laneStale}` : ""}。点击定位到该泳道。`;
    const bar = element("span", "overview-lane-bar");
    const fill = element("span");
    fill.style.width = `${Math.round((progress.ratio ?? 0) * 100)}%`;
    bar.append(fill);
    button.append(element("span", "overview-lane-label", lane.label), bar, element("span", "overview-lane-count", `${progress.done}/${progress.total}`),
      element("span", "overview-lane-stale", laneStale ? `停滞 ${laneStale}` : ""));
    return button;
  });
  replaceList(ui.overviewLanes, lanes, "没有编号分组");
  replaceList(ui.overviewStale, stale.map(({ node, days }) => overviewTask(node, `${days} 天`, laneOf.get(node.key).label, "stale")),
    `没有超过${TIMELINE.staleDays}天无活动的进行中任务`);
  replaceList(ui.overviewRecent, recent.map((node) => overviewTask(node, dateLabel(node.activity.lastAt),
    `${STATUS_LABELS[node.status]} · ${laneOf.get(node.key).label}`)), `近${RECENT_DAYS}天没有活动记录`);
}

/** 只更新总览条目的当前选中标记，不重建列表。 */
function updateOverviewSelection() {
  // 依赖图视图或没有编号分组时总览未显示，不必查询条目。
  if (!state.overviewVisible) return;
  for (const button of ui.overview.querySelectorAll("[data-overview-key]")) {
    button.setAttribute("aria-current", String(button.dataset.overviewKey === state.selectedKey));
  }
}

/** 把指定泳道滚到时间线可见区域顶部（刻度行下方），并短暂高亮提示位置。 */
function revealLane(key) {
  const row = [...ui.timelineCanvas.querySelectorAll("[data-lane-key]")].find((item) => item.dataset.laneKey === key);
  if (!row) return;
  ui.timelineScroll.scrollTop = row.offsetTop - TIMELINE.axisHeight;
  row.classList.remove("is-flashing");
  void row.offsetWidth;
  row.classList.add("is-flashing");
}

/** 总览点击：任务条目选中并定位，分组条目定位到泳道。 */
function onOverviewClick(event) {
  const task = event.target.closest("[data-overview-key]");
  if (task) { selectNode(task.dataset.overviewKey, true); return; }
  const lane = event.target.closest("[data-overview-lane]");
  if (lane) revealLane(lane.dataset.overviewLane);
}

/** 收起或展开总览；偏好只存一个布尔值，存储不可用时本页仍按当前选择显示。 */
function toggleOverview() {
  state.overviewCollapsed = !state.overviewCollapsed;
  try { window.localStorage.setItem(OVERVIEW_KEY, String(state.overviewCollapsed)); } catch { /* 偏好写入失败不影响显示。 */ }
  renderOverview();
}

/** 视图按钮事件委托。 */
function onViewClick(event) {
  const button = event.target.closest("[data-view]");
  if (button) setView(button.dataset.view, true, true);
}

/** 时间线任务条单击只显示详情，与依赖图卡片共用同一选中状态和详情栏；高亮关联任务改由双击。 */
function onTimelineClick(event) {
  const item = event.target.closest("[data-timeline-key]");
  if (item) selectNode(item.dataset.timelineKey);
  // 点在泳道空白处同时取消详情与高亮；泳道标题等按钮不算空白。
  else if (event.target.closest(".lane-track")) clearSelection();
}

/** 时间线任务条双击切换关联高亮。 */
function onTimelineDoubleClick(event) {
  const item = event.target.closest("[data-timeline-key]");
  if (item) toggleFocus(item.dataset.timelineKey);
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
    const button = element("button", `dependency-chip ${node.status}`);
    // 名称与编号分行显示；选择属性始终使用完整工作键，允许多个任务同名。
    button.append(element("span", "dependency-title", taskTitle(node)), element("span", "dep-id", node.key));
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
  content.append(element("h2", "detail-title", taskTitle(node)));
  // 编号独立保留为可全选的纯文本，不让显示名称参与身份关联。
  const identity = element("p", "detail-id", "工作项编号：");
  identity.append(element("code", "", node.key));
  content.append(identity);
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
  // 暂停、请求失败或页面后台停留都不能让旧运行信号无限存续。
  for (const icon of ui.cards.querySelectorAll(".agent-running-icon")) {
    if (Number(icon.dataset.validUntil) <= Date.now()) icon.remove();
  }
  for (const icon of ui.timelineCanvas.querySelectorAll(".timeline-running")) {
    if (Number(icon.dataset.validUntil) <= Date.now()) icon.remove();
  }
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

/** 写入唯一画布世界变换，使线与按钮卡片始终同步平移和缩放。
 *  同时发布无单位的 --graph-scale，供外圈光环和加粗边框在缩放小于 1 时按设计像素除以缩放反向补偿。
 *  补偿后的屏幕厚度等于 1:1 设计值；缩放不小于 1 时样式里的 max 保持原像素，不会额外加粗。
 *  变量与 transform 只在这里一起写，避免缩放和补偿各走各的。卡片外框仍由布局宽高决定。 */
function applyTransform() {
  ui.world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  ui.world.dataset.scale = String(state.scale);
  ui.world.style.setProperty("--graph-scale", String(state.scale));
}

/** 根据画布可用宽度适配并居中；小图保持卡片原尺寸，不无限放大。 */
function fitGraph() {
  // 依赖图被时间线视图隐藏时没有宽度；此时只保留适配模式，显示后由尺寸观察再适配。
  if (!state.graphSize.width || !ui.viewport.clientWidth) return;
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
  updateSelectionPresentation();
  updateTimelineSelection();
  updateOverviewSelection();
  renderDetails();
  if (center && state.view === "timeline") revealTimelineItem(key);
  else if (center) {
    const position = state.positions.get(key);
    state.x = ui.viewport.clientWidth / 2 - position.x * state.scale;
    state.y = ui.viewport.clientHeight / 2 - position.y * state.scale;
    state.viewMode = "manual";
    applyTransform();
  }
}

/** 同时取消详情选中与关联高亮：所有卡片与连线恢复正常显示，详情栏回到提示；不发起快照请求。 */
function clearSelection() {
  if (!state.selectedKey && !state.focusKey) return;
  state.selectedKey = null;
  state.focusKey = null;
  state.selectionRemoved = false;
  updateSelectionPresentation();
  updateTimelineSelection();
  updateOverviewSelection();
  renderDetails();
}

/** Esc 取消选中；输入框与下拉框内按键不处理。 */
function onDocumentKeydown(event) {
  if (event.key !== "Escape" || event.target.closest?.("input, textarea, select")) return;
  clearSelection();
}

/**
 * 卡片与任务条的双击切换关联高亮：双击未高亮的任务即高亮它与直接上下游并显示其详情，再双击同一任务取消高亮、保留详情。
 * 双击前浏览器已派发两次单击，详情已切到该任务；这里仍调用 selectNode，保证只收到双击时（如辅助工具）详情同样一致。
 * 单击、总览条目和详情邻接按钮只做选中定位，不改变高亮。
 */
function toggleFocus(key) {
  if (!state.nodes.has(key)) return;
  if (key === state.focusKey) {
    state.focusKey = null;
    updateSelectionPresentation();
    updateTimelineSelection();
    return;
  }
  state.focusKey = key;
  selectNode(key);
}

/** 通过事件委托单击显示任务详情，原生按钮同时支持 Tab、Enter 和空格。 */
function onCardClick(event) {
  const card = event.target.closest("[data-node-key]");
  if (card) selectNode(card.dataset.nodeKey);
}

/** 依赖图与旧版看板卡片双击切换关联高亮。 */
function onCardDoubleClick(event) {
  const card = event.target.closest("[data-node-key]");
  if (card) toggleFocus(card.dataset.nodeKey);
}

/**
 * 依赖图与旧版看板点画布空白（含编号分组框）同时取消详情与高亮。
 * 拖动平移结束时浏览器也会补发一次点击，拖动过的这一次不算空白点击，避免平移后聚焦丢失。
 */
function onViewportClick(event) {
  if (state.dragMoved) { state.dragMoved = false; return; }
  if (event.target.closest("button")) return;
  clearSelection();
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
  renderTimeline();
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
  state.dragMoved = false;
  state.drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, originX: state.x, originY: state.y };
  ui.viewport.setPointerCapture(event.pointerId);
  ui.viewport.classList.add("is-dragging");
}

/** 按指针屏幕位移平移世界；状态刷新不会重置这一视口。 */
function onPointerMove(event) {
  if (!state.drag || state.drag.id !== event.pointerId) return;
  // 位移超过3像素才算拖动；手抖的细微移动仍按点击处理，可点空白取消选中。
  if (Math.hypot(event.clientX - state.drag.startX, event.clientY - state.drag.startY) > 3) state.dragMoved = true;
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
  // 日宽随时间线可见宽度变化；宽度未变时坐标相同，不必重建。
  if (state.view === "timeline" && state.timelineLayout && state.timelineLayout.viewportWidth !== ui.timelineScroll.clientWidth) renderTimeline();
}

/** 侧栏至少留下480像素画布，较窄窗口留半窗；最小侧栏也随窄窗收紧。 */
function detailWidthBounds() {
  const width = ui.workspace.clientWidth;
  const max = Math.min(DETAIL_MAX_WIDTH, width - Math.min(480, width / 2));
  return { min: Math.min(DETAIL_MIN_WIDTH, width * .4, max), max };
}

/** 按当前窗口钳制实际宽度，保留原偏好供窗口变宽时恢复，默认仍用既有样式。 */
function applyDetailWidth() {
  const bounds = detailWidthBounds();
  if (state.detailWidth !== null) {
    const width = Math.max(bounds.min, Math.min(bounds.max, state.detailWidth));
    ui.workspace.style.setProperty("--detail-width", `${width}px`);
  }
  ui.detailResizer.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
  ui.detailResizer.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
  ui.detailResizer.setAttribute("aria-valuenow", String(Math.round(ui.detailPanel.getBoundingClientRect().width)));
}

/** 本地存储只保存有界宽度数值，权限或容量错误不能破坏看板只读交互。 */
function saveDetailWidth() {
  if (state.detailWidth === null) return;
  try { window.localStorage.setItem(DETAIL_WIDTH_KEY, String(state.detailWidth)); } catch { /* 偏好写入失败时当前页面仍保持宽度。 */ }
}

/** 从独立拖柄开始主指针调宽，不冒泡为图平移，也不选择页面文字。 */
function onDetailPointerDown(event) {
  if (event.button !== 0 || !event.isPrimary || state.detailDrag) return;
  event.preventDefault();
  state.detailDrag = { id: event.pointerId, startX: event.clientX, startWidth: ui.detailPanel.getBoundingClientRect().width };
  ui.detailResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("is-resizing-detail");
}

/** 捕获屏幕横向位移连续改变右栏宽度；窗体边界在每次移动时重新核对。 */
function onDetailPointerMove(event) {
  if (!state.detailDrag || event.pointerId !== state.detailDrag.id) return;
  const bounds = detailWidthBounds();
  state.detailWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max,
    state.detailDrag.startWidth + state.detailDrag.startX - event.clientX)));
  applyDetailWidth();
}

/** 结束、取消、捕获丢失或离页均释放拖动状态；先清状态避免释放捕获时重入。 */
function onDetailPointerEnd(event) {
  if (!state.detailDrag || (event.pointerId !== undefined && event.pointerId !== state.detailDrag.id)) return;
  const id = state.detailDrag.id;
  state.detailDrag = null;
  document.body.classList.remove("is-resizing-detail");
  if (ui.detailResizer.hasPointerCapture(id)) ui.detailResizer.releasePointerCapture(id);
  saveDetailWidth();
}

/** 分隔条采用标准方向键与端点操作，键盘和鼠标共用同一宽度边界及偏好。 */
function onDetailResizeKey(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const bounds = detailWidthBounds();
  const current = ui.detailPanel.getBoundingClientRect().width;
  const requested = event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max
    : current + (event.key === "ArrowLeft" ? 16 : -16);
  state.detailWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max, requested)));
  applyDetailWidth();
  saveDetailWidth();
}

/** 只读取本来源的宽度偏好；无效或禁用的存储回到既有默认布局。 */
function initializeDetailResize() {
  try {
    const saved = window.localStorage.getItem(DETAIL_WIDTH_KEY);
    const width = saved === null || saved.trim() === "" ? NaN : Number(saved);
    // 窄窗允许实际拖到320像素以下，读回同样接受该偏好；当前窗口边界由applyDetailWidth统一钳制。
    if (Number.isFinite(width) && width > 0 && width <= DETAIL_MAX_WIDTH) state.detailWidth = width;
  } catch { /* 存储不可用不影响项目读取、默认布局或后续鼠标操作。 */ }
  for (const [type, listener] of [["pointerdown", onDetailPointerDown], ["pointermove", onDetailPointerMove],
    ["pointerup", onDetailPointerEnd], ["pointercancel", onDetailPointerEnd], ["lostpointercapture", onDetailPointerEnd], ["keydown", onDetailResizeKey]]) {
    ui.detailResizer.addEventListener(type, listener);
  }
  window.addEventListener("resize", applyDetailWidth);
  applyDetailWidth();
}

/** 页面离开时取消计时和读取，避免留下无效的后台轮询。 */
function onPageHide() {
  onDetailPointerEnd({});
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
  state.resizeObserver?.observe(ui.timelineScroll);
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
  initializeDetailResize();
  try { state.overviewCollapsed = window.localStorage.getItem(OVERVIEW_KEY) === "true"; } catch { /* 存储不可用时默认展开。 */ }
  ui.overview.addEventListener("click", onOverviewClick);
  ui.overviewToggle.addEventListener("click", toggleOverview);
  ui.projectSelect.addEventListener("change", onProjectChange);
  ui.pause.addEventListener("click", togglePause);
  ui.fit.addEventListener("click", fitGraph);
  ui.actual.addEventListener("click", actualSize);
  ui.filters.addEventListener("click", onFilterClick);
  ui.cards.addEventListener("click", onCardClick);
  ui.cards.addEventListener("dblclick", onCardDoubleClick);
  ui.timelineCanvas.addEventListener("click", onTimelineClick);
  ui.timelineCanvas.addEventListener("dblclick", onTimelineDoubleClick);
  ui.viewSwitch.addEventListener("click", onViewClick);
  window.addEventListener("hashchange", () => setView(viewFromHash(), false));
  document.addEventListener("keydown", onDocumentKeydown);
  ui.details.addEventListener("click", onDetailClick);
  ui.viewport.addEventListener("wheel", onCanvasWheel, { passive: false });
  ui.viewport.addEventListener("pointerdown", onPointerDown);
  ui.viewport.addEventListener("pointermove", onPointerMove);
  ui.viewport.addEventListener("pointerup", onPointerEnd);
  ui.viewport.addEventListener("pointercancel", onPointerEnd);
  ui.viewport.addEventListener("click", onViewportClick);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  state.resizeObserver = new ResizeObserver(onViewportResize);
  state.resizeObserver.observe(ui.viewport);
  state.resizeObserver.observe(ui.timelineScroll);
  state.timer = window.setInterval(onClockTick, 250);
  setView(viewFromHash(), false);
  renderProjects();
  void refreshProjects();
}

initialize();
