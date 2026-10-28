import { hasSensitiveContent } from './safety.js';

// 编号分组只是按工作编号字面前缀归族的展示方式，不代表业务线或业务归属。
// 用户 2026-10-26 决定以它作为默认泳道依据；语义名称只能来自本看板登记清单的可选覆盖。
const SCATTERED_KEY = '~scattered';
const SCATTERED_LABEL = '零散任务';
const LANE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORK_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const OVERRIDE_LIMIT = 500;
// 互为前缀的族名合并时，较短者至少4个字符，避免 DB、KB 这类短词吞并无关族名。
const ALIAS_MIN_LENGTH = 4;

/** 校验登记清单中的可选泳道覆盖；结构错误返回 null，由调用方使整份清单无效。 */
export function validLaneOverrides(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['labels', 'merge', 'assign'].includes(key))
    || hasSensitiveContent(value)) return null;
  const result = {};
  for (const field of ['labels', 'merge', 'assign']) {
    const map = value[field] ?? {};
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > OVERRIDE_LIMIT) return null;
    const keyPattern = field === 'assign' ? WORK_KEY : LANE_KEY;
    for (const [key, target] of Object.entries(map)) {
      if (!keyPattern.test(key) || typeof target !== 'string') return null;
      // 名称是展示文字；合并与指派的目标必须是同样受限的分组键，不能写成路径或标记。
      if (field === 'labels' ? !target.trim() || target.length > 60 || /[\u0000-\u001f\u007f<>]/.test(target) : !LANE_KEY.test(target)) return null;
    }
    result[field] = { ...map };
  }
  return result;
}

/**
 * 取工作的字面编号：普通键直接使用；AWR 自动生成的 WORK-哈希键改取标题开头的编号，
 * 例如“BUTTON-TRAPPED-001 按钮报警…”。没有可辨认编号时返回 null，不按标题语义猜测。
 */
export function workCode(node) {
  if (!/^WORK-[0-9a-f]{16,}$/i.test(node.key)) return node.key;
  if (node.hidden || typeof node.title !== 'string') return null;
  const match = node.title.match(/^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+)/);
  return match ? match[1] : null;
}

/** 编号的第一段去掉末尾数字并转大写即为族名，如 STREAM-REUSE-001 → STREAM、T12 → T。 */
export function codeFamily(code) {
  if (typeof code !== 'string') return null;
  const family = code.split(/[-_.:\s/]/)[0].replace(/\d+$/, '').toUpperCase();
  return LANE_KEY.test(family) ? family : null;
}

/** 互为前缀的族名并入最短者，如 DASHBOARD → DASH、DEPLOYMENT → DEPLOY。 */
function aliasFamilies(families) {
  const names = [...new Set(families)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const alias = new Map();
  for (const name of names) {
    const shorter = names.find((other) => other.length >= ALIAS_MIN_LENGTH && other.length < name.length && name.startsWith(other));
    alias.set(name, shorter ? alias.get(shorter) : name);
  }
  return alias;
}

/** 统计分组内状态，口径与全项目计数一致：取消和归档不进入完成进度分母。 */
function laneCounts(members) {
  const counts = { total: 0, completed: 0, inProgress: 0, pending: 0, blocked: 0, cancelled: 0, archived: 0, unknown: 0,
    progress: { done: 0, total: 0, ratio: null } };
  const names = { completed: 'completed', in_progress: 'inProgress', pending: 'pending', blocked: 'blocked', cancelled: 'cancelled', archived: 'archived', unknown: 'unknown' };
  for (const node of members) {
    counts.total += 1; counts[names[node.status]] += 1;
    if (node.status !== 'archived' && node.status !== 'cancelled') {
      counts.progress.total += 1;
      if (node.status === 'completed') counts.progress.done += 1;
    }
  }
  if (counts.progress.total) counts.progress.ratio = counts.progress.done / counts.progress.total;
  return counts;
}

/**
 * 给快照节点写入 group 并返回按时间排序的分组列表。步骤依次为：
 * 1. 指派覆盖优先；否则取字面编号族名，并合并互为前缀的族名；
 * 2. 合并覆盖把族名改写到目标分组；
 * 3. 未经覆盖且只有一项、或没有可辨认编号的工作归入“零散任务”；
 * 4. 名称覆盖只改显示名称。缺失工作项不参与分组，保持原依赖图语义。
 */
export function assignLanes(nodes, overrides = {}) {
  const { labels = {}, merge = {}, assign = {} } = overrides;
  const works = nodes.filter((node) => !node.missing);
  const literal = new Map(works.map((node) => [node.key, codeFamily(workCode(node))]));
  const alias = aliasFamilies([...literal.values()].filter(Boolean));
  const chosen = new Map();
  for (const node of works) {
    if (Object.hasOwn(assign, node.key)) { chosen.set(node.key, { key: assign[node.key], origin: 'override' }); continue; }
    const family = literal.get(node.key) && alias.get(literal.get(node.key));
    if (!family) { chosen.set(node.key, null); continue; }
    chosen.set(node.key, Object.hasOwn(merge, family) ? { key: merge[family], origin: 'override' } : { key: family, origin: 'prefix' });
  }
  const sizes = new Map();
  for (const lane of chosen.values()) if (lane) sizes.set(lane.key, (sizes.get(lane.key) ?? 0) + 1);
  const members = new Map();
  for (const node of nodes) {
    if (node.missing) { node.group = null; continue; }
    let lane = chosen.get(node.key);
    if (!lane || (lane.origin === 'prefix' && sizes.get(lane.key) < 2 && !Object.hasOwn(labels, lane.key))) {
      lane = { key: SCATTERED_KEY, origin: 'scattered' };
    }
    const label = lane.key === SCATTERED_KEY ? SCATTERED_LABEL : labels[lane.key] ?? lane.key;
    node.group = { key: lane.key, label, origin: lane.origin };
    members.set(lane.key, [...(members.get(lane.key) ?? []), node]);
  }
  const lanes = [...members].map(([key, list]) => {
    const times = list.map((node) => node.activity).filter(Boolean);
    return { key, label: list[0].group.label, labelled: Object.hasOwn(labels, key), scattered: key === SCATTERED_KEY,
      firstAt: times.length ? Math.min(...times.map((item) => item.firstAt)) : null,
      lastAt: times.length ? Math.max(...times.map((item) => item.lastAt)) : null,
      workKeys: list.map((node) => node.key), counts: laneCounts(list) };
  });
  // 按最早活动排序体现开发先后；零散任务固定在末尾，没有活动记录的分组排在有记录者之后。
  lanes.sort((a, b) => Number(a.scattered) - Number(b.scattered)
    || (a.firstAt ?? Infinity) - (b.firstAt ?? Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return lanes;
}
