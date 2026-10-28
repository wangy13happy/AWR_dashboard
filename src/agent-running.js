export const RUNNING_SAMPLE_TTL_MS = 15000;
/** 观察器单次扫描的失败上限。探针在此时限内返回的成功样本仍应可被消费。 */
export const SCAN_TIMEOUT_MS = 1800;
/** 探针两次扫描之间的休眠。必须与 agent-process-windows.cs 的 25×20 毫秒循环一致。 */
export const PROBE_SLEEP_MS = 500;
/** 连续缺证宽限里加在扫描上限之后的固定余量。 */
export const EVIDENCE_GRACE_PAD_MS = 500;
/** 扫描超时或热日志读不稳时，未超过该宽限不得拆圈。宽限 = 扫描上限 + 500 毫秒。 */
export const EVIDENCE_GAP_GRACE_MS = SCAN_TIMEOUT_MS + EVIDENCE_GRACE_PAD_MS;
/**
 * 扫描反复超时、且进程仍活、上次仍是 executing/busy 时的持有上限。
 * 覆盖 busy 至少 60 秒、至少 30 次采样缺口；超过该上限仍未再确认则灭灯，避免探针永久失联后常亮。
 */
export const EXECUTING_HOLD_MS = 90000;
/**
 * 成功观察的新鲜期。必须严格大于「单次扫描超时 + 探针休眠」，
 * 否则一次偏慢但成功的扫描会在下一次样本到达前被判过期，刷新时拆圈。
 */
export const OBSERVATION_MAX_AGE_MS = SCAN_TIMEOUT_MS + PROBE_SLEEP_MS + EVIDENCE_GRACE_PAD_MS;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** 仅接收已实证的完整UUID或Claude的local_UUID宿主号。 */
function validAlias(value) { return typeof value === 'string' && (UUID.test(value) || value.startsWith('local_') && UUID.test(value.slice(6))); }

/**
 * 读取绑定候选键。不剥离 Claude 宿主 local_ 前缀，不从自由文本猜客户端。
 * Codex 与已带 grok:/claude-code: 前缀的通用绑定仍只返回一个键。
 * 通用绑定且 external_session 是裸 UUID 时，同时返回 claude 与 grok 两个候选：
 * 裸 ID 无法区分客户端，是否亮圈由后续“恰好一个存活执行进程”决定。
 */
function bindingKey(binding) {
  const id = binding.externalSession;
  if (typeof id !== 'string') return [];
  if (binding.client === 'codex' && UUID.test(id)) return [`codex:${id.toLowerCase()}`];
  if (binding.client === 'generic') {
    if (id.startsWith('grok:') && UUID.test(id.slice(5))) return [`grok:${id.slice(5).toLowerCase()}`];
    if (id.startsWith('claude-code:') && validAlias(id.slice(12))) return [`claude:${id.slice(12).toLowerCase()}`];
    if (UUID.test(id)) {
      const bare = id.toLowerCase();
      return [`claude:${bare}`, `grok:${bare}`];
    }
  }
  return [];
}

/**
 * 成功样本在新鲜期内可直接使用。新鲜期长于一次扫描超时加探针休眠，
 * 所以慢但成功的扫描不会在下一轮样本前被当成过期。
 * 热日志缺证不在这里继承；那种延续由 evidence=held 和缺证宽限单独判断。
 */
export function observationIsFresh(observation, now) {
  return observation?.ok === true && Number.isSafeInteger(observation.sampledAt)
    && observation.sampledAt <= now && now - observation.sampledAt < OBSERVATION_MAX_AGE_MS
    && Array.isArray(observation.processes) && observation.processes.length <= 256;
}

/**
 * 本轮没有稳定读到尾部时，探针可以标明 evidence=held，表示沿用上一份成功解析。
 * 扫描失败但进程仍活时，观察器标明 evidence=scan-hold，持有长于短缺证宽限。
 * 只有仍是 executing、证据时刻不晚于现在、且未超过对应上限时才算回合还开着。
 * turn_ended、未来时间或超过上限都不延续。
 */
function heldTurnStillOpen(native, now) {
  if (native?.evidence !== 'held' && native?.evidence !== 'scan-hold') return true;
  const limit = native.evidence === 'scan-hold' ? EXECUTING_HOLD_MS : EVIDENCE_GAP_GRACE_MS;
  return Number.isSafeInteger(native.evidenceAt) && native.evidenceAt <= now
    && now - native.evidenceAt <= limit;
}

/** Codex、Claude、Grok 都只在同客户端内沿 parentId 继承，跨客户端不借绑定。 */
const INHERITING_CLIENTS = new Set(['codex', 'claude', 'grok']);

/** 精确绑定包含单键绑定，以及裸 UUID 展开后的 claude/grok 双候选。 */
function boundWorkIds(keys, singleOwners, duals) {
  const owners = new Set(keys.flatMap(key => [...(singleOwners.get(key) ?? [])]));
  for (const dual of duals) if (dual.keys.some(key => keys.includes(key))) owners.add(dual.workId);
  return owners;
}

/**
 * 同客户端的后继 thread 只沿 parentId 找已绑定的前驱。
 * 深度不超过 8。后继自己已有绑定、祖先绑定不唯一、或链路断开时不继承。
 */
function inheritedWorkIds(hit, singleOwners, parentOf, duals) {
  if (boundWorkIds(hit.keys, singleOwners, duals).size > 0 || !INHERITING_CLIENTS.has(hit.client) || !UUID.test(hit.parentId ?? '')) return new Set();
  const seen = new Set([hit.id]);
  let current = hit.parentId;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const key = `${hit.client}:${current}`;
    const owners = boundWorkIds([key], singleOwners, duals);
    if (owners.size > 0) return owners;
    current = parentOf.get(key) ?? null;
  }
  return new Set();
}

/** 批量关联原生身份和唯一工作；恢复边只验证同工作接续，不传播祖先原生号。 */
export function runningWorkIds({ sessions, bindings, resumptions = [], observation, now }) {
  const running = new Set();
  if (!observationIsFresh(observation, now)) return running;
  const bySession = new Map(sessions.map(session => [session.id, session]));
  if (bySession.size !== sessions.length) return running;
  const invalid = new Set(); const graph = new Map();
  for (const edge of resumptions) {
    const from = bySession.get(edge.from); const to = bySession.get(edge.to);
    if (!from || !to || !from.workId || from.workId !== to.workId || edge.from === edge.to) {
      invalid.add(edge.from); invalid.add(edge.to); continue;
    }
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    graph.get(edge.from).add(edge.to);
  }
  const memo = new Map();
  /** 结束的绑定会话只能沿官方同工作链接到仍活跃的执行会话；不把结束声明自动复活。 */
  function activeContinuation(id, stack = new Set()) {
    if (invalid.has(id)) return false;
    if (stack.has(id) || stack.size > 128) { for (const member of stack) invalid.add(member); return false; }
    if (memo.has(id)) return memo.get(id);
    const session = bySession.get(id); const next = new Set(stack); next.add(id);
    let active = session?.status === 'active' && session.endedAt === null;
    for (const child of graph.get(id) ?? []) active = activeContinuation(child, next) || active;
    active = active && !invalid.has(id); memo.set(id, active); return active;
  }
  for (const id of bySession.keys()) activeContinuation(id);
  const singleOwners = new Map();
  // 裸 UUID 是一条绑定的两个候选，不能当成两条独立绑定分别亮圈。
  const duals = [];
  for (const binding of bindings) {
    const keys = bindingKey(binding); const session = bySession.get(binding.sessionId);
    if (keys.length === 0 || !session?.workId || invalid.has(session.id) || !memo.get(session.id)) continue;
    if (keys.length === 1) {
      if (!singleOwners.has(keys[0])) singleOwners.set(keys[0], new Set());
      singleOwners.get(keys[0]).add(session.workId);
    } else duals.push({ workId: session.workId, keys });
  }
  const hits = [];
  // 父链来自本轮观察里的 parentId，包含已结束的中间 thread；不跨客户端，也不读取其他项目数据库。
  const parentOf = new Map();
  for (const process of observation.processes) {
    if (!['codex', 'claude', 'grok'].includes(process?.client) || !Array.isArray(process.sessions)) continue;
    for (const native of process.sessions) {
      const id = native?.id?.toLowerCase?.() ?? '';
      const parent = native?.parentId?.toLowerCase?.() ?? '';
      if (!UUID.test(id) || !UUID.test(parent) || parent === id) continue;
      parentOf.set(`${process.client}:${id}`, parent);
    }
  }
  for (const process of observation.processes) {
    if (process?.alive !== true || !Number.isSafeInteger(process.pid) || process.pid <= 0
      || !Number.isSafeInteger(process.createdAt) || process.createdAt <= 0 || process.createdAt > now
      || !['codex', 'claude', 'grok'].includes(process.client) || !Array.isArray(process.sessions)) continue;
    for (const native of process.sessions) {
      if (!UUID.test(native?.id ?? '') || native.state !== 'executing'
        || !Number.isSafeInteger(native.startedAt) || native.startedAt < process.createdAt || native.startedAt > observation.sampledAt
        || !heldTurnStillOpen(native, now)) continue;
      const id = native.id.toLowerCase();
      const keys = [`${process.client}:${id}`];
      if (process.client === 'claude' && validAlias(native.hostSessionId)) keys.push(`claude:${native.hostSessionId.toLowerCase()}`);
      const parent = native.parentId?.toLowerCase?.() ?? '';
      hits.push({ pid: process.pid, createdAt: process.createdAt, keys, client: process.client, id, parentId: UUID.test(parent) && parent !== id ? parent : null });
    }
  }
  const identity = hit => `${hit.pid}:${hit.createdAt}`;
  /** 候选键命中的是已通过亮圈门禁的存活执行进程，空闲或已结束回合不算命中。 */
  function processesFor(key) {
    const found = new Set();
    for (const hit of hits) if (hit.keys.includes(key)) found.add(identity(hit));
    return found;
  }
  /** 两个候选分别落到不同进程时，这条裸绑定不唯一，不能单独把工作点亮。 */
  function dualIsAmbiguous(dual) {
    const left = processesFor(dual.keys[0]); const right = processesFor(dual.keys[1]);
    if (left.size === 0 || right.size === 0) return false;
    return new Set([...left, ...right]).size > 1;
  }
  for (const hit of hits) {
    const workIds = new Set(hit.keys.flatMap(key => [...(singleOwners.get(key) ?? [])]));
    const inherited = inheritedWorkIds(hit, singleOwners, parentOf, duals);
    for (const workId of inherited) workIds.add(workId);
    const matchedDuals = duals.filter(dual => dual.keys.some(key => hit.keys.includes(key)));
    for (const dual of matchedDuals) workIds.add(dual.workId);
    if (workIds.size !== 1) continue;
    const workId = [...workIds][0];
    const fromSingle = hit.keys.some(key => singleOwners.get(key)?.has(workId));
    const fromUniqueDual = matchedDuals.some(dual => dual.workId === workId && !dualIsAmbiguous(dual));
    // 后继自己没有绑定、且祖先只属于这一个工作时，光环跟到新 UUID。祖先不唯一则上面已经跳过。
    const fromInherited = inherited.size === 1 && inherited.has(workId);
    if (fromSingle || fromUniqueDual || fromInherited) running.add(workId);
  }
  return running;
}

/** 保留前端期限字段；领取过期、runner、目录或pid文件不参与运行判定。 */
export function evaluateAgentRunning({ work, running, observation, now }) {
  return work.status === 'in_progress' && work.current && !work.hidden && running.has(work.id)
    && observationIsFresh(observation, now) ? observation.sampledAt + RUNNING_SAMPLE_TTL_MS : null;
}
