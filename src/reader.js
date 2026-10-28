import { constants } from 'node:fs';
import { lstat, realpath, open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseToml } from 'smol-toml';
import { DashboardError, hasSensitiveContent, sanitizeText } from './safety.js';
import { runningWorkIds, evaluateAgentRunning } from './agent-running.js';
import { assignLanes } from './lanes.js';

const DATABASE_LIMIT = 64 * 1024 * 1024;
const SOURCE_LIMIT = 8 * 1024 * 1024;
const APPLICATION_ID = 0x41575231;
// 0.6.0 的 008–014 仅新增表和索引；读取契约仍逐项检查下方实际使用的列。
// 只接受完整的两个已核验版本，不把中间迁移状态或未来版本当成兼容。
const MIGRATIONS = ['catalog', 'domain', 'search', 'draft_work', 'workstreams', 'workstream_sessions', 'content_reviews',
  'responsibility', 'operation_readset_receipts', 'agent_authorization', 'team_handoff', 'delivery_deps', 'usage_time', 'eta_checkpoints'];
const SCHEMA_RELEASES = new Map([[7, '0.5.1'], [14, '0.6.0']]);
const WORK_STATUSES = new Set(['draft', 'planned', 'ready', 'claimed', 'in_progress', 'blocked', 'completed', 'cancelled', 'unknown']);
// 固定 0.5.1 的已知普通文件适配器；目录适配器不在本看板的已核验范围中。
const ADAPTERS = new Set(['markdown-heading-v1', 'markdown-rules-v1', 'markdown-ledger-v1', 'yaml-ledger-v1', 'yaml-workstream-ledger-v1']);
const REQUIRED_COLUMNS = Object.freeze({
  projects: ['id', 'external_key', 'name', 'root', 'authority_mode', 'current_branch_id', 'project_revision'],
  sources: ['id', 'project_id', 'domain', 'role', 'locator', 'format', 'adapter', 'revision', 'fingerprint', 'freshness', 'active', 'config_json'],
  work_items: ['id', 'project_id', 'external_key', 'title', 'source_id', 'source_ref_json', 'source_revision', 'revision', 'active', 'payload_json', 'updated_at', 'kind', 'required', 'raw_status', 'status', 'priority', 'milestone', 'score', 'evidence_level', 'summary', 'next_action', 'blocker', 'acceptance_json', 'tags_json', 'paths_json'],
  edges: ['id', 'project_id', 'from_kind', 'from_key', 'relation', 'to_kind', 'to_key', 'required', 'source_id', 'source_ref_json', 'source_revision', 'revision', 'active'],
  claims: ['id', 'project_id', 'work_item_id', 'session_id', 'agent_id', 'branch_id', 'status', 'acquired_at', 'expires_at', 'released_at', 'revision'],
  evidence: ['id', 'project_id', 'work_item_id', 'external_key', 'evidence_type', 'level', 'summary', 'locator', 'sha256', 'source_sha', 'command', 'scope_json', 'source_id', 'source_revision', 'source_ref_json', 'branch_id', 'revision', 'verified_at', 'active', 'payload_json'],
  branches: ['id', 'project_id', 'name', 'parent_branch_id', 'git_ref', 'fork_project_revision', 'status', 'revision'],
  schema_migrations: ['version', 'name', 'applied_at'],
});
const DIAGNOSTIC_TEXT = Object.freeze({
  source_registry_unverified: '当前来源注册与已索引配置未能核验一致；图为最近记录的投影。',
  source_not_fresh: '相关节点或依赖边的权威来源未核验为当前版本。',
  unknown_status: '来源状态尚无确定解释。',
  status_not_selectable: '来源状态不是可领取的计划或就绪状态。',
  work_archived: '工作项已归档，不能作为可领取项。',
  active_blocker: '来源记录包含仍有效的显式阻塞。',
  missing_dependency: '必要依赖没有有效工作项投影。',
  dependency_cycle: '此必要依赖闭包包含环上的工作项。',
  dependency_not_completed: '必要前置项未声明完成或已经归档。',
  active_claim: '工作项仍有未释放、未过期的认领。',
  sensitive_content_withheld: '敏感内容已隐藏；看板停止肯定的就绪判断。',
});

/** 生成稳定字节指纹，与固定 AWR 源码的 file:// 指纹格式一致。 */
function fingerprint(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** 规范化对象键顺序，仅用于配置等价比较与结果指纹，不改写源文件。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 比较 Windows 扩展前缀与大小写后的真实路径，其他平台保留大小写。 */
function normalizedPath(value) {
  let result = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  result = path.normalize(result);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

/** 判断绝对路径是否在固定项目根中，拒绝目录穿越及相邻前缀目录。 */
function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** 拒绝路径组件的符号链接/重解析跳转；SQLite 原文件从不进入此函数的连接。 */
async function ensureLocalPath(root, target, fileRequired = true) {
  if (!insideRoot(root, target)) throw new DashboardError('UNSAFE_PATH');
  let current = root;
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new DashboardError('UNSAFE_PATH');
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new DashboardError('UNSAFE_PATH');
    const final = index === components.length - 1;
    if ((!final || !fileRequired) ? !info.isDirectory() : !info.isFile()) throw new DashboardError('UNSAFE_PATH');
    const actual = await realpath(current);
    if (!insideRoot(root, actual) || normalizedPath(actual) !== normalizedPath(current)) throw new DashboardError('UNSAFE_PATH');
  }
}

/** 只读获取普通文件身份和纳秒元数据；不存在可选日志时返回 null。 */
async function stamp(root, filename, optional = false) {
  try {
    await ensureLocalPath(root, filename);
    const info = await lstat(filename, { bigint: true });
    return { size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 前后身份和元数据必须一致；共享内存不是捕获输入，也从不打开。 */
function sameStamp(first, second) {
  return first === null || second === null ? first === second
    : ['size', 'mtime', 'ctime', 'dev', 'ino'].every((field) => first[field] === second[field]);
}

/** 有界读取，避免文件在检查后膨胀引起无界分配，Linux 同时禁止最终符号链接。 */
async function boundedRead(filename, limit, captureInput = false, expected = null) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile()) throw new DashboardError('UNSAFE_PATH');
    // 打开后、读取前复核句柄身份，防止检查与 open 之间替换文件或重解析目标。
    if (expected && !sameStamp(expected, { size: actual.size, mtime: actual.mtimeNs,
      ctime: actual.ctimeNs, dev: actual.dev, ino: actual.ino })) throw new DashboardError('CAPTURE_CONFLICT', '', true);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, limit - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new DashboardError('DATABASE_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (captureInput && ['ENOENT', 'ESTALE'].includes(error.code)) throw new DashboardError('CAPTURE_CONFLICT', '', true);
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/** 缓存只比较决定里点名的 size 与 mtime。ctime、设备号和 inode 不参与命中。 */
function fileIdentity(stampValue) {
  return stampValue ? { size: stampValue.size, mtime: stampValue.mtime } : null;
}

/** 两个身份都缺席才算相同；一边出现 WAL 或大小/时间变化都要重新双读。 */
function sameFileIdentity(left, right) {
  if (left === null || right === null) return left === right;
  return left.size === right.size && left.mtime === right.mtime;
}

function sameDatabaseSignature(cached, current) {
  return !!cached && !!current
    && sameFileIdentity(cached.db, current.db)
    && sameFileIdentity(cached.wal, current.wal);
}

/**
 * 读取 state.db 与 WAL 的 size+mtime。回滚日志存在时不给出可命中签名，
 * 随后仍走原来的捕获并拒绝。共享内存不参与双读，也不进签名。
 */
async function databaseSignature(root) {
  const database = path.join(root, '.awr', 'state.db');
  if (await stamp(root, `${database}-journal`, true)) return null;
  return {
    db: fileIdentity(await stamp(root, database, false)),
    wal: fileIdentity(await stamp(root, `${database}-wal`, true)),
  };
}

/** 按项目根记住上次成功快照。只在进程内，不写盘，不跨项目复用。 */
const snapshotCache = new Map();

/** 双读数据库和 WAL，检查日志存在性与前后身份，不对原库执行 SQLite 操作。 */
async function captureAttempt(root, options, attempt) {
  const database = path.join(root, '.awr', 'state.db');
  const names = [database, `${database}-wal`];
  if (await stamp(root, `${database}-journal`, true)) throw new DashboardError('ROLLBACK_JOURNAL', '', true);
  const before = await Promise.all(names.map((name, index) => stamp(root, name, index === 1)));
  const total = before.reduce((sum, item) => sum + (item?.size ?? 0n), 0n);
  if (total > BigInt(DATABASE_LIMIT)) throw new DashboardError('DATABASE_TOO_LARGE');
  const images = [];
  for (let index = 0; index < names.length; index += 1) {
    const image = before[index] === null ? null : await boundedRead(names[index], DATABASE_LIMIT, true, before[index]);
    if (image && BigInt(image.length) !== before[index].size) throw new DashboardError('CAPTURE_CONFLICT', '', true);
    images.push(image);
  }
  // 仅供专用夹具制造确定的捕获冲突；正式服务不接收或传入此钩子。
  if (options.onCaptureStep) await options.onCaptureStep({ step: 'afterFirstRead', attempt });
  for (let index = 0; index < names.length; index += 1) {
    if (images[index] !== null) {
      const second = await boundedRead(names[index], DATABASE_LIMIT, true, before[index]);
      if (!images[index].equals(second)) throw new DashboardError('CAPTURE_CONFLICT', '', true);
    }
  }
  const after = await Promise.all(names.map((name) => stamp(root, name, true)));
  if (before.some((item, index) => !sameStamp(item, after[index]))
    || await stamp(root, `${database}-journal`, true)) throw new DashboardError('CAPTURE_CONFLICT', '', true);
  return {
    images,
    signature: { db: fileIdentity(after[0]), wal: fileIdentity(after[1]) },
  };
}

/** 单次请求最多重试一次变化冲突；缺文件/拒绝访问返回固定错误。 */
async function captureDatabase(root, options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await captureAttempt(root, options, attempt);
    } catch (error) {
      if (error instanceof DashboardError && error.code === 'CAPTURE_CONFLICT' && attempt === 0) continue;
      if (error instanceof DashboardError) throw error;
      if (attempt === 0 && ['ENOENT', 'ESTALE'].includes(error.code)) continue;
      throw new DashboardError('DATABASE_UNAVAILABLE', '', ['ENOENT', 'EACCES', 'EBUSY', 'ESTALE'].includes(error.code));
    }
  }
}

/** 必需整数必须可安全序列化，不能把损坏值或浮点修订伪装为有效状态。 */
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new DashboardError('INCOMPATIBLE_PROJECTION');
  return value;
}

/** 校验结构性键与标识；不安全的结构不能仅遮蔽一处后在邻接列表泄露。 */
function identifier(value, ulid = false) {
  if (typeof value !== 'string' || !value || value.length > 512
    || /[\p{Cc}\p{Cf}]/u.test(value) || hasSensitiveContent(value)
    || (ulid && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value))) throw new DashboardError('UNSAFE_IDENTIFIER');
  return value;
}

/** 可选文字必须为字符串或 null；不对类型错误作隐式 String 转换。 */
function optionalText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new DashboardError('INCOMPATIBLE_PROJECTION');
  return value;
}

/** 校验官方数组字段，不丢弃不认识的条目或暗中截断验收要求。 */
function stringArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new DashboardError('INCOMPATIBLE_PROJECTION');
  return value;
}

/** 必需载荷是对象；解析错误只返回固定投影错误，不回显正文。 */
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new DashboardError('INCOMPATIBLE_PROJECTION');
  }
}

/** 核验已支持版本的归属、完整迁移序列及读取所需列，返回副本中的实际版本。 */
function validateSchema(db) {
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID
    || !SCHEMA_RELEASES.has(schemaVersion)) throw new DashboardError('UNSUPPORTED_SCHEMA');
  for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
    const object = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
    if (object?.type !== 'table') throw new DashboardError('UNSUPPORTED_SCHEMA');
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    if (expected.some((name) => !actual.has(name))) throw new DashboardError('UNSUPPORTED_SCHEMA');
  }
  const migrations = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  if (migrations.length !== schemaVersion || migrations.some((item, index) => item.version !== index + 1 || item.name !== MIGRATIONS[index])) {
    throw new DashboardError('UNSUPPORTED_SCHEMA');
  }
  return schemaVersion;
}

/** 创建自有稳定副本并在同一读事务查询；finally 只关闭/清理本轮创建的目录。 */
async function queryCopy(root, images) {
  const tempBase = await realpath(os.tmpdir());
  // 环境临时目录也可能位于所选项目内，或经链接指向项目内；在创建任何副本前拒绝。
  if (insideRoot(normalizedPath(root), normalizedPath(tempBase))) throw new DashboardError('UNSAFE_PATH');
  let directory;
  let db;
  try {
    directory = await mkdtemp(path.join(tempBase, 'awr-dashboard-'));
    await writeFile(path.join(directory, 'state.db'), images[0], { flag: 'wx', mode: 0o600 });
    if (images[1] !== null) await writeFile(path.join(directory, 'state.db-wal'), images[1], { flag: 'wx', mode: 0o600 });
    db = new DatabaseSync(path.join(directory, 'state.db'), { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN;');
    const schemaVersion = validateSchema(db);
    const projects = db.prepare('SELECT * FROM projects').all();
    if (projects.length !== 1) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    const project = projects[0];
    identifier(project.id, true);
    if (typeof project.root !== 'string' || normalizedPath(project.root) !== normalizedPath(root)
      || project.authority_mode !== 'source_first') throw new DashboardError('INCOMPATIBLE_PROJECTION');
    integer(project.project_revision);
    if (typeof project.name !== 'string') throw new DashboardError('INCOMPATIBLE_PROJECTION');
    if (project.current_branch_id !== null) {
      identifier(project.current_branch_id, true);
      if (!db.prepare("SELECT id FROM branches WHERE project_id=? AND id=? AND status='active'").get(project.id, project.current_branch_id)) {
        throw new DashboardError('INCOMPATIBLE_PROJECTION');
      }
    }
    // 数据集来自同一事务，不逐节点开库，不查询目标文件、会话结束状态或自由文本路径。
    const sources = db.prepare('SELECT * FROM sources WHERE project_id=? AND active=1 ORDER BY id').all(project.id);
    const orphan = db.prepare('SELECT w.id FROM work_items w LEFT JOIN sources s ON w.source_id=s.id AND w.project_id=s.project_id WHERE w.project_id=? AND w.active=1 AND s.id IS NULL LIMIT 1').get(project.id);
    if (orphan) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    const works = db.prepare('SELECT w.* FROM work_items w JOIN sources s ON w.source_id=s.id AND w.project_id=s.project_id WHERE w.project_id=? AND w.active=1 AND s.active=1 ORDER BY w.external_key').all(project.id);
    const edges = db.prepare("SELECT e.* FROM edges e JOIN sources s ON e.source_id=s.id AND e.project_id=s.project_id WHERE e.project_id=? AND e.active=1 AND s.active=1 AND e.from_kind='work_item' AND e.to_kind='work_item' AND e.relation='depends_on' ORDER BY e.from_key,e.to_key,e.id").all(project.id);
    const claims = db.prepare("SELECT * FROM claims WHERE project_id=? AND status='active' AND released_at IS NULL ORDER BY id").all(project.id);
    const evidence = db.prepare('SELECT * FROM evidence WHERE project_id=? AND active=1 AND work_item_id IS NOT NULL ORDER BY id').all(project.id);
    // 活动信号为可选能力；历史/简化投影缺少会话或事件列时，原图保持可读但不显示动画。
    let sessions = []; let bindings = []; let resumptions = [];
    const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
    const eventColumns = new Set(db.prepare('PRAGMA table_info(events)').all().map(column => column.name));
    if (['id', 'project_id', 'work_item_id', 'status', 'started_at', 'ended_at'].every(name => sessionColumns.has(name))
      && ['project_id', 'event_type', 'payload_json', 'project_revision'].every(name => eventColumns.has(name))) {
      try {
        sessions = db.prepare('SELECT id,work_item_id AS workId,status,started_at AS startedAt,ended_at AS endedAt FROM sessions WHERE project_id=?').all(project.id);
        const events = db.prepare(`SELECT event_type,payload_json,project_revision FROM events WHERE project_id=?
          AND event_type IN ('client.bound','client.updated','client.checkpointed','session.resumed','session.resumed_from','session.handoff_received')
          ORDER BY project_revision LIMIT 20001`).all(project.id);
        if (events.length > 20000 || sessions.length > 10000) throw new Error('activity_limit');
        const latest = new Map();
        for (const event of events) {
          const payload = JSON.parse(event.payload_json);
          if (event.event_type.startsWith('client.')) {
            const b = payload.binding;
            if (!b || typeof b.client !== 'string' || typeof b.external_session !== 'string' || typeof b.session_id !== 'string') continue;
            const key = JSON.stringify([b.client, b.external_session]); const previous = latest.get(key);
            const binding = { client: b.client, externalSession: b.external_session, sessionId: b.session_id };
            if (!previous || event.project_revision > previous.revision) latest.set(key, { revision: event.project_revision, bindings: [binding] });
            else if (event.project_revision === previous.revision) previous.bindings.push(binding);
          } else if (typeof payload.from_session_id === 'string' && typeof payload.to_session_id === 'string') {
            resumptions.push({ from: payload.from_session_id, to: payload.to_session_id });
          }
        }
        bindings = [...latest.values()].flatMap(item => item.bindings);
      } catch { sessions = []; bindings = []; resumptions = []; }
    }
    // 每项首次/最近活动时刻同样是可选能力：只聚合关联到工作项的事件，不读事件载荷。
    // work_items.updated_at 是重建投影的时刻，所有工作常常相同，因此不作为时间线依据。
    let activity = [];
    if (['project_id', 'work_item_id', 'created_at'].every(name => eventColumns.has(name))) {
      try {
        activity = db.prepare(`SELECT work_item_id AS workId, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt, COUNT(*) AS events
          FROM events WHERE project_id=? AND work_item_id IS NOT NULL GROUP BY work_item_id LIMIT 10001`).all(project.id);
        if (activity.length > 10000) throw new Error('activity_limit');
      } catch { activity = []; }
    }
    db.exec('COMMIT;');
    return { project, sources, works, edges, claims, evidence, schemaVersion, sessions, bindings, resumptions, activity };
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw new DashboardError('INVALID_DATABASE');
  } finally {
    try {
      if (db) db.close();
    } finally {
      // 目标必须是当前进程刚创建的专用目录，绝不接受源项目或外部参数作为删除路径。
      if (directory && path.dirname(directory) === tempBase && path.basename(directory).startsWith('awr-dashboard-')) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

/** 已知凭据文件不作为当前性读取目标；拒绝不是把其正文读出来再判断。 */
function credentialFile(filename) {
  const parts = filename.split(/[\\/]/).map((part) => part.toLowerCase());
  const name = parts.at(-1);
  return parts.includes('.ssh') || /^\.env(?:\.|$)/.test(name)
    || parts.includes('.aws') || parts.includes('.kube')
    || ['.envrc', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials'].includes(name)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx)$/.test(name)
    || /^(?:credentials?|secrets?|tokens?|passwords?)(?:\.[^.]+)?$/.test(name);
}

/** 有界双读权威文件，文件变化时只标未核验；不保存或回传原文。 */
async function readSourceFile(root, filename) {
  if (credentialFile(filename)) throw new DashboardError('UNSAFE_PATH');
  const before = await stamp(root, filename);
  if (before.size > BigInt(SOURCE_LIMIT)) throw new DashboardError('DATABASE_TOO_LARGE');
  const first = await boundedRead(filename, SOURCE_LIMIT, false, before);
  const second = await boundedRead(filename, SOURCE_LIMIT, false, before);
  const after = await stamp(root, filename);
  if (!sameStamp(before, after) || !first.equals(second) || BigInt(first.length) !== before.size) {
    throw new DashboardError('CAPTURE_CONFLICT', '', true);
  }
  return first;
}

/** 仅解析根内本地 file:// 来源，无查询、片段、网络共享或外部授权扩展。 */
function sourceFilename(root, value) {
  if (typeof value !== 'string' || !value.startsWith('file://')) throw new DashboardError('UNSAFE_PATH');
  const url = new URL(value);
  if (url.search || url.hash || url.hostname || url.username || url.password) throw new DashboardError('UNSAFE_PATH');
  const filename = path.resolve(fileURLToPath(url));
  if (!insideRoot(root, filename) || credentialFile(filename)) throw new DashboardError('UNSAFE_PATH');
  return filename;
}

/** 规范化当前注册，匹配官方 source_configuration 的 mapping_key/options/version。 */
function registeredMapping(root, spec, minimal) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).some((key) => !['domain', 'role', 'path', 'locator', 'adapter', 'options'].includes(key))
    || typeof spec.domain !== 'string' || !['primary', 'supporting'].includes(spec.role)
    || !ADAPTERS.has(spec.adapter) || Boolean(spec.path) === Boolean(spec.locator)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
  const original = spec.path ?? spec.locator;
  if (typeof original !== 'string' || hasSensitiveContent(spec)) throw new DashboardError('UNSAFE_PATH');
  let filename;
  if (spec.path) {
    if (spec.path.split(/[\\/]/).includes('..')) throw new DashboardError('UNSAFE_PATH');
    filename = path.resolve(root, spec.path);
    if (!insideRoot(root, filename) || credentialFile(filename)) throw new DashboardError('UNSAFE_PATH');
  } else filename = sourceFilename(root, spec.locator);
  const options = spec.options ?? {};
  if (!options || Array.isArray(options) || typeof options !== 'object') throw new DashboardError('INCOMPATIBLE_PROJECTION');
  const config = {
    mapping_key: `${spec.domain}|${original}`,
    adapter_options: options,
    adapter_version: ['markdown-ledger-v1', 'yaml-ledger-v1'].includes(spec.adapter) ? 4 : 2,
    ...(minimal ? { context_profile: 'minimal' } : {}),
  };
  return { domain: spec.domain, role: spec.role, locator: pathToFileURL(filename).href, adapter: spec.adapter, config };
}

/** 安全诊断总用固定文字；工作键先验证，危险源正文从不拼入 detail。 */
function diagnostic(code, workKey = null, origin = 'awr') {
  return { code, origin, workKey, detail: DIAGNOSTIC_TEXT[code] ?? '来源无法核验为当前版本。' };
}

/** 核对当前注册及原字节指纹；未知/漂移只降低当前性，不进行索引或写入。 */
async function inspectSources(root, rows) {
  const internal = new Map();
  for (const row of rows) {
    identifier(row.id, true);
    identifier(row.project_id, true);
    integer(row.revision);
    if (typeof row.locator !== 'string' || typeof row.fingerprint !== 'string'
      || typeof row.domain !== 'string' || typeof row.adapter !== 'string'
      || !['fresh', 'stale', 'unavailable'].includes(row.freshness)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    if (internal.has(row.id)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    internal.set(row.id, { row, config: parseObject(row.config_json), current: false, currentFingerprint: null, freshness: 'unverified', failure: null });
  }
  let mappings = [];
  let registryVerified = false;
  let registryFailure = null;
  try {
    const bytes = await readSourceFile(root, path.join(root, '.awr', 'project.toml'));
    const manifest = parseToml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const profile = manifest.project?.context_profile ?? 'standard';
    if (!manifest.project || !['standard', 'minimal'].includes(profile)
      || (manifest.project.authority_mode ?? 'source_first') !== 'source_first'
      || !Array.isArray(manifest.sources) || hasSensitiveContent(manifest)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    mappings = manifest.sources.map((spec) => registeredMapping(root, spec, profile === 'minimal'));
    const comparable = rows.map((row) => ({ domain: row.domain, role: row.role, locator: pathToFileURL(sourceFilename(root, row.locator)).href, adapter: row.adapter, config: parseObject(row.config_json) }));
    // 仅比较定位符时规范化 Windows 大小写/扩展前缀；原声明 mapping_key 和完整配置保持严格比较。
    const sorted = (items) => items.map((item) => stableJson({
      ...item, locator: normalizedPath(fileURLToPath(item.locator)),
    })).sort();
    registryVerified = new Set(sorted(mappings)).size === mappings.length
      && stableJson(sorted(mappings)) === stableJson(sorted(comparable));
    if (!registryVerified) registryFailure = 'SOURCE_REGISTRY_CHANGED';
  } catch (error) {
    registryFailure = error instanceof DashboardError ? error.code : 'SOURCE_REGISTRY_UNVERIFIED';
  }
  for (const source of internal.values()) {
    try {
      if (!registryVerified) throw new DashboardError('UNSAFE_PATH');
      const bytes = await readSourceFile(root, sourceFilename(root, source.row.locator));
      source.currentFingerprint = fingerprint(bytes);
      // 此处原源只用于字节指纹，不输出正文。显示敏感闸门逐工作载荷执行，
      // 不能因同源另一任务的文字而遮蔽不相关任务或伪造来源已过期。
      source.current = source.row.freshness === 'fresh' && source.currentFingerprint === source.row.fingerprint;
      source.freshness = source.current ? 'fresh' : 'stale';
      if (!source.current) source.failure = 'SOURCE_CHANGED';
    } catch (error) {
      source.failure = error instanceof DashboardError ? error.code : (error.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNVERIFIED');
      source.freshness = error.code === 'ENOENT' ? 'missing' : 'unverified';
    }
  }
  const sources = [...internal.values()].map((source) => ({
    id: source.row.id,
    locator: sanitizeText(source.row.locator),
    revision: source.row.revision,
    indexedFingerprint: sanitizeText(source.row.fingerprint),
    currentFingerprint: source.currentFingerprint,
    freshness: source.freshness,
  }));
  const result = { internal, sources, registryVerified, registryFailure, mappings, sourceFingerprint: '' };
  result.sourceFingerprint = sourceStateFingerprint(result);
  return result;
}

/** 当前注册与已索引配置共同参与内部指纹，稳定排序避免声明顺序/空白制造虚假漂移。 */
function sourceStateFingerprint(sourceInfo) {
  return fingerprint(Buffer.from(stableJson({
    registry: sourceInfo.mappings.map(stableJson).sort(), registryVerified: sourceInfo.registryVerified,
    registryFailure: sourceInfo.registryFailure,
    // 完整已索引配置仅进入散列输入，不加入对外返回的来源对象或快照。
    sources: [...sourceInfo.internal.values()].map((source) => ({ id: source.row.id, revision: source.row.revision,
      indexed: source.row.fingerprint, indexedConfig: source.config,
      current: source.currentFingerprint, failure: source.failure })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  })));
}

/** 载荷与行标识严格一致；来源修订漂移降低当前性，而不是偷偷采用当前源修订。 */
function sourceReference(reference, row, source) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || reference.source_id !== row.source_id || reference.source_revision !== row.source_revision
    || typeof reference.locator !== 'string' || typeof reference.source_fingerprint !== 'string') {
    throw new DashboardError('INCOMPATIBLE_PROJECTION');
  }
  integer(row.source_revision);
  optionalText(reference.pointer);
  optionalText(reference.section_fingerprint);
  for (const field of ['start_line', 'end_line']) if (reference[field] !== null && reference[field] !== undefined) integer(reference[field]);
  return source.current && row.source_revision === source.row.revision
    && reference.source_fingerprint === source.row.fingerprint && reference.locator === source.row.locator;
}

/** 所有载荷/边来源修订先核对，任一漂移使同来源的全部投影保守失去当前性。 */
function validateProjectionSources(data, sourceInfo) {
  for (const row of [...data.works, ...data.edges]) {
    const source = sourceInfo.internal.get(row.source_id);
    if (!source) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    const payload = row.payload_json === undefined ? null : parseObject(row.payload_json);
    if (payload) row.parsedPayload = payload;
    const reference = payload?.source_ref ?? parseObject(row.source_ref_json);
    if (payload && stableJson(reference) !== stableJson(parseObject(row.source_ref_json))) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    sourceReference(reference, row, source);
    if (row.source_revision !== source.row.revision || reference.source_fingerprint !== source.row.fingerprint
      || reference.locator !== source.row.locator) {
      source.current = false;
      source.freshness = 'stale';
      source.failure = 'SOURCE_PROJECTION_STALE';
    }
  }
  for (const source of sourceInfo.sources) source.freshness = sourceInfo.internal.get(source.id).freshness;
  sourceInfo.sourceFingerprint = sourceStateFingerprint(sourceInfo);
}

/** 按来源工作状态映射显示色类；就绪诊断不会把所有进行中工作误标为阻塞。 */
function displayStatus(work) {
  if (work.archived) return 'archived';
  if (['claimed', 'in_progress'].includes(work.status)) return 'in_progress';
  if (['draft', 'planned', 'ready'].includes(work.status)) return 'pending';
  return work.status;
}

/** 读取工作载荷及安全字段，完整危险载荷隐藏全部可选文字。 */
function buildWorks(rows, sourceInfo) {
  if (rows.length > 1000) throw new DashboardError('NODE_LIMIT');
  const works = new Map();
  const ids = new Set();
  for (const row of rows) {
    identifier(row.id, true);
    identifier(row.external_key);
    identifier(row.source_id, true);
    integer(row.revision, 1);
    if (works.has(row.external_key) || ids.has(row.id)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    ids.add(row.id);
    const payload = row.parsedPayload ?? parseObject(row.payload_json);
    if (payload.id !== row.id || payload.external_key !== row.external_key || payload.revision !== row.revision
      || !WORK_STATUSES.has(payload.status) || typeof payload.raw_status !== 'string'
      || typeof payload.title !== 'string' || typeof payload.summary !== 'string' || typeof payload.next_action !== 'string'
      || typeof payload.required !== 'boolean' || (payload.archived !== undefined && typeof payload.archived !== 'boolean')) {
      throw new DashboardError('INCOMPATIBLE_PROJECTION');
    }
    stringArray(payload.acceptance);
    stringArray(payload.tags);
    stringArray(payload.paths);
    for (const field of ['blocker', 'kind', 'priority', 'owner', 'milestone']) optionalText(payload[field]);
    if (payload.score !== null && payload.score !== undefined && !Number.isSafeInteger(payload.score)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    if (payload.evidence_level !== null && payload.evidence_level !== undefined
      && !['designed', 'implemented', 'locally_verified', 'real_environment_validated', 'release_candidate', 'released', 'unknown'].includes(payload.evidence_level)) {
      throw new DashboardError('INCOMPATIBLE_PROJECTION');
    }
    const source = sourceInfo.internal.get(row.source_id);
    if (!source) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    const current = sourceReference(payload.source_ref, row, source);
    const hidden = hasSensitiveContent(payload);
    const work = {
      id: row.id, key: row.external_key,
      title: hidden ? '敏感内容已隐藏' : payload.title,
      status: displayStatus(payload), rawStatus: hidden ? '敏感内容已隐藏' : payload.raw_status,
      priority: hidden ? null : optionalText(payload.priority), kind: hidden ? null : optionalText(payload.kind),
      owner: hidden ? null : optionalText(payload.owner), archived: payload.archived ?? false, missing: false,
      claims: [], ready: false, continuable: false, waiting: false,
      diagnostics: [], upstream: [], downstream: [],
      nextAction: hidden ? '' : payload.next_action, summary: hidden ? '' : payload.summary,
      acceptance: hidden ? [] : payload.acceptance, evidence: [], sourceId: row.source_id,
      canonicalStatus: payload.status, blocker: Boolean(payload.blocker?.trim()), current, hidden,
    };
    works.set(work.key, work);
  }
  if (works.size > 1000) throw new DashboardError('NODE_LIMIT');
  return works;
}

/** 读取反向显示边，保留可选依赖但只以必要边构建就绪邻接。 */
function buildEdges(rows, works, sourceInfo) {
  const edges = [];
  const ids = new Set();
  for (const row of rows) {
    identifier(row.id, true);
    identifier(row.from_key);
    identifier(row.to_key);
    identifier(row.source_id, true);
    integer(row.revision, 1);
    if (ids.has(row.id) || ![0, 1].includes(row.required)) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    ids.add(row.id);
    const source = sourceInfo.internal.get(row.source_id);
    if (!source) throw new DashboardError('INCOMPATIBLE_PROJECTION');
    const current = sourceReference(parseObject(row.source_ref_json), row, source);
    const edge = { id: row.id, from: row.to_key, to: row.from_key, required: row.required === 1,
      sourceId: row.source_id, satisfied: false, diagnostics: [], current };
    if (!current) edge.diagnostics.push(diagnostic('source_not_fresh', row.from_key));
    edges.push(edge);
    for (const key of [edge.from, edge.to]) {
      if (!works.has(key)) works.set(key, { id: `missing:${key}`, key, title: '缺失工作项', status: 'unknown', rawStatus: '',
        priority: null, kind: null, owner: null, archived: false, missing: true, claims: [], ready: false,
        continuable: false, waiting: false, diagnostics: [diagnostic('missing_dependency', key)],
        upstream: [], downstream: [], nextAction: '', summary: '', acceptance: [], evidence: [], sourceId: null,
        canonicalStatus: 'unknown', blocker: false, current: false, hidden: false });
    }
    if (edge.required) {
      works.get(edge.to).upstream.push(edge.from);
      works.get(edge.from).downstream.push(edge.to);
    }
    const prerequisite = works.get(edge.from);
    edge.satisfied = !prerequisite.missing && !prerequisite.archived
      && prerequisite.canonicalStatus === 'completed' && prerequisite.current && current;
  }
  for (const work of works.values()) {
    work.upstream = [...new Set(work.upstream)].sort();
    work.downstream = [...new Set(work.downstream)].sort();
  }
  return edges;
}

/** 认领按官方严格过期条件过滤，所有分支有效且不查询会话状态。 */
function attachClaims(rows, works, evaluatedAt) {
  const byId = new Map([...works.values()].filter((work) => !work.missing).map((work) => [work.id, work]));
  for (const row of rows) {
    identifier(row.id, true);
    identifier(row.work_item_id, true);
    identifier(row.session_id, true);
    if (row.branch_id !== null) identifier(row.branch_id, true);
    integer(row.acquired_at);
    if (row.expires_at !== null) integer(row.expires_at);
    if (row.expires_at !== null && row.expires_at <= evaluatedAt) continue;
    const work = byId.get(row.work_item_id);
    if (!work) continue;
    const secret = hasSensitiveContent(row.agent_id);
    work.hidden ||= secret;
    work.claims.push({ id: row.id, agentId: secret ? null : optionalText(row.agent_id),
      sessionId: work.hidden ? null : row.session_id, branchId: row.branch_id,
      acquiredAt: row.acquired_at, expiresAt: row.expires_at });
  }
}

/** 证据仅按项目与工作标识关联登记元数据，从不打开 locator 或执行 command。 */
function attachEvidence(rows, works) {
  const byId = new Map([...works.values()].filter((work) => !work.missing).map((work) => [work.id, work]));
  for (const row of rows) {
    const work = byId.get(row.work_item_id);
    if (!work) continue;
    identifier(row.id, true);
    const fields = { type: row.evidence_type, level: row.level, summary: row.summary, locator: row.locator,
      sha256: row.sha256, sourceSha: row.source_sha, command: row.command, payload: parseObject(row.payload_json) };
    if (hasSensitiveContent(fields)) work.hidden = true;
    if (row.verified_at !== null) integer(row.verified_at);
    if (['evidence_type', 'level', 'summary', 'locator'].some((field) => typeof row[field] !== 'string')) {
      throw new DashboardError('INCOMPATIBLE_PROJECTION');
    }
    work.evidence.push({ id: row.id, type: row.evidence_type, level: row.level, summary: row.summary,
      locator: row.locator, sha256: optionalText(row.sha256), sourceSha: optionalText(row.source_sha), verifiedAt: row.verified_at });
  }
}

/** 按工作标识写入活动时间范围；异常行整体放弃时间线，不让单行坏值伪造先后顺序。 */
function attachActivity(rows, works) {
  const byId = new Map([...works.values()].filter((work) => !work.missing).map((work) => [work.id, work]));
  for (const work of works.values()) work.activity = null;
  const valid = rows.every((row) => typeof row.workId === 'string' && Number.isSafeInteger(row.firstAt) && Number.isSafeInteger(row.lastAt)
    && row.firstAt >= 0 && row.firstAt <= row.lastAt && Number.isSafeInteger(row.events) && row.events > 0);
  if (!valid) return;
  for (const row of rows) {
    const work = byId.get(row.workId);
    if (work) work.activity = { firstAt: row.firstAt, lastAt: row.lastAt, events: row.events };
  }
}

/** 判定真正环成员：对每个必要闭包起点寻找返回自身路径，不把后续节点当环成员。 */
function cycleMembers(works) {
  const members = new Set();
  for (const root of works.keys()) {
    const pending = [...works.get(root).upstream];
    const visited = new Set();
    while (pending.length) {
      const key = pending.pop();
      if (key === root) { members.add(root); break; }
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push(...works.get(key).upstream);
    }
  }
  return members;
}

/** 去重传递必要依赖，分别诊断缺项、真正环成员及每条闭包边的当前性。 */
function deriveReadiness(works, edges, sourceInfo) {
  const cycles = cycleMembers(works);
  const neededEdges = new Map([...works.keys()].map((key) => [key, []]));
  for (const edge of edges) if (edge.required) neededEdges.get(edge.to).push(edge);
  for (const work of works.values()) {
    if (work.missing) continue;
    const findings = new Map();
    const add = (code, key = work.key, origin = 'awr') => findings.set(`${origin}|${code}|${key ?? ''}`, diagnostic(code, key, origin));
    if (!['planned', 'ready'].includes(work.canonicalStatus)) add(work.canonicalStatus === 'unknown' ? 'unknown_status' : 'status_not_selectable');
    if (work.archived) add('work_archived');
    if (work.blocker) add('active_blocker');
    if (!sourceInfo.registryVerified) add('source_registry_unverified', work.key, 'dashboard');
    if (work.hidden) add('sensitive_content_withheld', work.key, 'dashboard');
    if (!work.current) add('source_not_fresh');
    const pending = [work.key];
    const reachable = new Set();
    while (pending.length) {
      const key = pending.pop();
      if (reachable.has(key)) continue;
      reachable.add(key);
      if (cycles.has(key)) add('dependency_cycle', key);
      const dependency = works.get(key);
      if (key !== work.key) {
        if (dependency.missing) add('missing_dependency', key);
        else {
          if (!dependency.current) add('source_not_fresh', key);
          if (dependency.hidden) add('sensitive_content_withheld', key, 'dashboard');
          if (dependency.archived || dependency.canonicalStatus !== 'completed') {
            add(dependency.canonicalStatus === 'unknown' ? 'unknown_status' : 'dependency_not_completed', key);
          }
        }
      }
      for (const edge of neededEdges.get(key)) {
        if (!edge.current) add('source_not_fresh', key);
        pending.push(edge.from);
      }
    }
    if (work.claims.length) add('active_claim');
    work.diagnostics = [...findings.values()].sort((a, b) => `${a.code}|${a.workKey}` < `${b.code}|${b.workKey}` ? -1 : 1);
    work.ready = work.diagnostics.length === 0;
    work.continuable = !work.archived && !['completed', 'cancelled'].includes(work.canonicalStatus)
      && (['claimed', 'in_progress'].includes(work.canonicalStatus) || work.claims.length > 0);
    work.waiting = !work.archived && ['planned', 'ready'].includes(work.canonicalStatus) && !work.ready && !work.continuable;
    // 危险证据/认领同样隐藏整个工作项的可选文字；只保留安全结构和状态。
    if (work.hidden) {
      work.title = '敏感内容已隐藏'; work.rawStatus = '敏感内容已隐藏';
      work.priority = null; work.kind = null; work.owner = null; work.nextAction = ''; work.summary = '';
      work.acceptance = []; work.evidence = [];
      work.claims = work.claims.map((claim) => ({ ...claim, agentId: null, sessionId: null }));
    }
  }
}

/** 状态计数互斥，分类可重叠；取消/归档不进入完成进度分母。 */
function countWorks(works) {
  const counts = { total: 0, completed: 0, inProgress: 0, pending: 0, blocked: 0, cancelled: 0, archived: 0, unknown: 0,
    ready: 0, continuable: 0, waiting: 0, progress: { done: 0, total: 0, ratio: null } };
  const names = { completed: 'completed', in_progress: 'inProgress', pending: 'pending', blocked: 'blocked', cancelled: 'cancelled', archived: 'archived', unknown: 'unknown' };
  for (const work of works.values()) {
    if (work.missing) continue;
    counts.total += 1; counts[names[work.status]] += 1;
    if (work.ready) counts.ready += 1;
    if (work.continuable) counts.continuable += 1;
    if (work.waiting) counts.waiting += 1;
    if (!work.archived && work.canonicalStatus !== 'cancelled') {
      counts.progress.total += 1;
      if (work.canonicalStatus === 'completed') counts.progress.done += 1;
    }
  }
  if (counts.progress.total) counts.progress.ratio = counts.progress.done / counts.progress.total;
  return counts;
}

/** 构造唯一共享字段契约，不泄露用于核验的载荷、配置、命令或内部派生辅助字段。 */
function snapshotValue(root, data, sourceInfo, works, edges, evaluatedAt) {
  const nodes = [...works.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(({ canonicalStatus, blocker, current, hidden, ...node }) => node);
  const diagnostics = sourceInfo.registryVerified ? [] : [diagnostic('source_registry_unverified', null, 'dashboard')];
  if (sourceInfo.sources.some((source) => source.freshness !== 'fresh')) diagnostics.push(diagnostic('source_not_fresh', null, 'dashboard'));
  if (nodes.some((node) => node.diagnostics.some((item) => item.code === 'sensitive_content_withheld'))) {
    diagnostics.push(diagnostic('sensitive_content_withheld', null, 'dashboard'));
  }
  return { version: 1, project: { id: data.project.id, name: sanitizeText(data.project.name), root,
    awrVersion: SCHEMA_RELEASES.get(data.schemaVersion), schemaVersion: data.schemaVersion }, revision: data.project.project_revision,
    sourceFingerprint: sourceInfo.sourceFingerprint, updatedAt: Date.now(), evaluatedAt,
    readOnly: true, mode: 'live', sources: sourceInfo.sources, nodes,
    edges: edges.map(({ current, ...edge }) => edge), counts: countWorks(works), diagnostics };
}

/**
 * 编号分组在缓存之外计算：缓存只按数据库签名失效，而覆盖来自本看板登记清单，
 * 清单修改后即使数据库未变，下一次读取也必须采用新的分组名称与合并规则。
 */
function withLanes(snapshot, overrides) {
  snapshot.lanes = assignLanes(snapshot.nodes, overrides ?? {});
  return snapshot;
}

/**
 * 取出光环判定所需的库内行：会话、绑定、续接边，以及每个非缺失工作的资格字段。
 * 快照节点会剥掉 current/hidden，所以这些字段单独随缓存保存，命中时无需重读库。
 */
function agentActivityInput(data, works) {
  return { sessions: data.sessions, bindings: data.bindings, resumptions: data.resumptions,
    works: [...works.values()].filter((work) => !work.missing)
      .map(({ id, key, status, current, hidden }) => ({ id, key, status, current, hidden })) };
}

/**
 * 按本次原生观察和本次时间写入每个节点的 agentRunningUntil。
 * 光环由服务后台观察驱动而不是由库驱动，所以真实捕获和缓存命中都走这里；
 * 请求仅消费服务后台最近的完整观察，这里不启动进程、不读取原生日志或runner文件。
 */
function attachAgentRunning(nodes, activity, options) {
  const observation = options.agentObservationProvider?.() ?? options.agentObservation ?? null;
  const now = integer(typeof options.now === 'function' ? options.now() : options.now ?? Date.now());
  const running = runningWorkIds({ sessions: activity.sessions, bindings: activity.bindings, resumptions: activity.resumptions, observation, now });
  const eligible = new Map(activity.works.map((work) => [work.key, work]));
  for (const node of nodes) {
    const work = eligible.get(node.key);
    node.agentRunningUntil = work ? evaluateAgentRunning({ work, running, observation, now }) : null;
  }
}

/**
 * 取得单项目严格只读快照。原库仅有界读字节，SQLite 只打开自有稳定副本。
 * options.now 可注入毫秒数/函数；onCaptureStep 仅供专用夹具验证冲突，服务不暴露它。
 */
export async function readSnapshot(projectRoot, options = {}) {
  try {
    if (typeof projectRoot !== 'string' || !projectRoot || hasSensitiveContent(projectRoot)) throw new DashboardError('PROJECT_UNAVAILABLE');
    const resolved = path.resolve(projectRoot);
    const root = await realpath(resolved);
    if (normalizedPath(root) !== normalizedPath(resolved)) throw new DashboardError('PROJECT_UNAVAILABLE');
    await ensureLocalPath(root, root, false);
    const evaluatedAt = integer(typeof options.now === 'function' ? options.now() : options.now ?? Date.now());
    const cacheId = normalizedPath(root);
    // 捕获钩子只给冲突夹具；带钩子时不读缓存，也不把夹具中途改写的结果写进缓存。
    if (!options.onCaptureStep) {
      const current = await databaseSignature(root);
      const cached = snapshotCache.get(cacheId);
      if (sameDatabaseSignature(cached?.signature, current)) {
        // 命中只跳过读盘与查询；光环期限仍按缓存的库内行和本次观察重算，不随库签名冻结；分组在重算之后按本看板清单计算。
        const snapshot = structuredClone(cached.snapshot);
        attachAgentRunning(snapshot.nodes, cached.activity, options);
        return withLanes(snapshot, options.laneOverrides);
      }
    }
    const captured = await captureDatabase(root, options);
    const data = await queryCopy(root, captured.images);
    const sourceInfo = await inspectSources(root, data.sources);
    validateProjectionSources(data, sourceInfo);
    const works = buildWorks(data.works, sourceInfo);
    const edges = buildEdges(data.edges, works, sourceInfo);
    attachClaims(data.claims, works, evaluatedAt);
    attachEvidence(data.evidence, works);
    attachActivity(data.activity, works);
    deriveReadiness(works, edges, sourceInfo);
    const activity = agentActivityInput(data, works);
    const snapshot = snapshotValue(root, data, sourceInfo, works, edges, evaluatedAt);
    attachAgentRunning(snapshot.nodes, activity, options);
    if (!options.onCaptureStep) {
      snapshotCache.set(cacheId, { signature: captured.signature, snapshot: structuredClone(snapshot), activity });
    }
    return withLanes(snapshot, options.laneOverrides);
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw new DashboardError('SNAPSHOT_UNAVAILABLE', '', ['ENOENT', 'EACCES', 'EBUSY'].includes(error.code));
  }
}
