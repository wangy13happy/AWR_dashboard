import { mkdir, mkdtemp, writeFile, readFile, readdir, lstat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 专用夹具生成合法长度的 ULID 形状标识，永不使用业务项目记录。 */
export function fixtureId(number) {
  return String(number).padStart(26, '0');
}

/** 夹具字节指纹按官方本地来源规则生成。 */
function sourceHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

// 关键表保留 v7 所需完整列。夹具不执行迁移，也不伪装成真实工程验收记录。
const SCHEMA = `
PRAGMA application_id=1096241713;
PRAGMA user_version=7;
CREATE TABLE projects(id TEXT PRIMARY KEY,external_key TEXT,name TEXT,root TEXT,authority_mode TEXT,current_branch_id TEXT,project_revision INTEGER);
CREATE TABLE sources(id TEXT PRIMARY KEY,project_id TEXT,domain TEXT,role TEXT,locator TEXT,format TEXT,adapter TEXT,revision INTEGER,fingerprint TEXT,freshness TEXT,active INTEGER,config_json TEXT);
CREATE TABLE work_items(id TEXT PRIMARY KEY,project_id TEXT,external_key TEXT,title TEXT,source_id TEXT,source_ref_json TEXT,source_revision INTEGER,revision INTEGER,active INTEGER,payload_json TEXT,updated_at INTEGER,kind TEXT,required INTEGER,raw_status TEXT,status TEXT,priority TEXT,milestone TEXT,score INTEGER,evidence_level TEXT,summary TEXT,next_action TEXT,blocker TEXT,acceptance_json TEXT,tags_json TEXT,paths_json TEXT);
CREATE TABLE edges(id TEXT PRIMARY KEY,project_id TEXT,from_kind TEXT,from_key TEXT,relation TEXT,to_kind TEXT,to_key TEXT,required INTEGER,source_id TEXT,source_ref_json TEXT,source_revision INTEGER,revision INTEGER,active INTEGER);
CREATE TABLE claims(id TEXT PRIMARY KEY,project_id TEXT,work_item_id TEXT,session_id TEXT,agent_id TEXT,branch_id TEXT,status TEXT,acquired_at INTEGER,expires_at INTEGER,released_at INTEGER,revision INTEGER);
CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT,work_item_id TEXT,external_key TEXT,evidence_type TEXT,level TEXT,summary TEXT,locator TEXT,sha256 TEXT,source_sha TEXT,command TEXT,scope_json TEXT,source_id TEXT,source_revision INTEGER,source_ref_json TEXT,branch_id TEXT,revision INTEGER,verified_at INTEGER,active INTEGER,payload_json TEXT);
CREATE TABLE branches(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,parent_branch_id TEXT,git_ref TEXT,fork_project_revision INTEGER,status TEXT,revision INTEGER);
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,status TEXT);
`;

/** 构造自有临时 v7 项目，返回写连接仅用于测试制造状态/日志变化。 */
export async function createReaderFixture(options = {}) {
  const tempBase = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempBase, 'awr-dashboard-test-'));
  await mkdir(path.join(root, '.awr'));
  const sources = options.sources ?? [
    { key: 'goal', domain: 'goal', filename: 'goals.md', adapter: 'markdown-heading-v1', text: '# Dedicated fixture goal\n' },
    { key: 'ledger', domain: 'ledger', filename: 'ledger.yaml', adapter: 'yaml-ledger-v1', text: 'work_items: []\n' },
  ];
  const profile = options.profile ?? 'minimal';
  const declarations = ['[project]', 'name = "Reader fixture"', 'authority_mode = "source_first"', `context_profile = ${JSON.stringify(profile)}`];
  const sourceRows = new Map();
  for (const [index, spec] of sources.entries()) {
    const filename = path.join(root, spec.filename);
    await mkdir(path.dirname(filename), { recursive: true });
    const bytes = Buffer.from(spec.text ?? '# source fixture\n');
    await writeFile(filename, bytes);
    const config = { mapping_key: `${spec.domain}|${spec.filename}`, adapter_options: spec.options ?? {},
      adapter_version: ['yaml-ledger-v1', 'markdown-ledger-v1'].includes(spec.adapter) ? 4 : 2,
      ...(profile === 'minimal' ? { context_profile: 'minimal' } : {}) };
    sourceRows.set(spec.key, { id: fixtureId(10 + index), locator: pathToFileURL(filename).href,
      fingerprint: sourceHash(bytes), revision: spec.revision ?? 1, spec, config });
    declarations.push('', '[[sources]]', `domain = ${JSON.stringify(spec.domain)}`, 'role = "primary"',
      `path = ${JSON.stringify(spec.filename)}`, `adapter = ${JSON.stringify(spec.adapter)}`, '[sources.options]');
    for (const [key, value] of Object.entries(spec.options ?? {})) declarations.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
  }
  const manifest = `${declarations.join('\n')}\n`;
  await writeFile(path.join(root, '.awr', 'project.toml'), manifest);
  const db = new DatabaseSync(path.join(root, '.awr', 'state.db'));
  if (options.wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec(SCHEMA);
  // 夹具初始化一次提交，避免大规模边界测试依赖上千次逐行磁盘同步。
  db.exec('BEGIN;');
  const projectId = fixtureId(1);
  db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?)').run(projectId, 'fixture', options.name ?? 'Reader fixture', root, 'source_first', null, 1);
  const migrations = ['catalog', 'domain', 'search', 'draft_work', 'workstreams', 'workstream_sessions', 'content_reviews'];
  for (const [index, name] of migrations.entries()) db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(index + 1, name, 100);
  for (const source of sourceRows.values()) {
    db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(source.id, projectId,
      source.spec.domain, 'primary', source.locator, source.spec.filename.endsWith('.yaml') ? 'yaml' : 'markdown',
      source.spec.adapter, source.revision, source.fingerprint, source.spec.freshness ?? 'fresh', source.spec.active ?? 1, JSON.stringify(source.config));
  }
  const workIds = new Map();
  const workSources = new Map();
  for (const [index, spec] of (options.works ?? [{ key: 'A', status: 'ready' }]).entries()) {
    const id = fixtureId(100 + index);
    const source = sourceRows.get(spec.source ?? 'ledger') ?? sourceRows.values().next().value;
    const reference = { source_id: source.id, locator: source.locator, source_revision: spec.sourceRevision ?? source.revision,
      source_fingerprint: source.fingerprint, pointer: '/work_items/0', start_line: null, end_line: null };
    const payload = { id, external_key: spec.key, revision: 1, source_ref: reference,
      title: spec.title ?? `Fixture ${spec.key}`, kind: 'implementation', owner: spec.owner ?? null,
      required: true, raw_status: spec.rawStatus ?? spec.status ?? 'ready', status: spec.status ?? 'ready',
      priority: 'P1', milestone: null, score: null, evidence_level: null, summary: 'Dedicated fixture',
      next_action: 'Continue fixture checks', blocker: spec.blocker ?? null, acceptance: ['Fixture acceptance'],
      tags: [], paths: [], ...(spec.archived === undefined ? {} : { archived: spec.archived }), ...(spec.payload ?? {}) };
    db.prepare('INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, spec.key,
      spec.columnTitle ?? payload.title, source.id, JSON.stringify(reference), spec.rowSourceRevision ?? reference.source_revision,
      1, spec.active ?? 1, JSON.stringify(payload), 100, 'implementation', 1, payload.raw_status,
      spec.columnStatus ?? payload.status, 'P1', null, null, null, payload.summary, payload.next_action,
      payload.blocker, JSON.stringify(payload.acceptance), '[]', '[]');
    workIds.set(spec.key, id); workSources.set(spec.key, source);
  }
  for (const [index, spec] of (options.edges ?? []).entries()) {
    const source = sourceRows.get(spec.source ?? 'ledger') ?? sourceRows.values().next().value;
    const reference = { source_id: source.id, locator: source.locator,
      source_revision: spec.sourceRevision ?? source.revision, source_fingerprint: source.fingerprint,
      pointer: '/work_items/0/depends_on', start_line: null, end_line: null, ...(spec.reference ?? {}) };
    db.prepare('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fixtureId(300 + index), projectId,
      'work_item', spec.from, 'depends_on', 'work_item', spec.to, spec.required === false ? 0 : 1,
      source.id, JSON.stringify(reference), spec.rowSourceRevision ?? reference.source_revision, 1, spec.active ?? 1);
  }
  for (const [index, spec] of (options.claims ?? []).entries()) {
    const sessionId = fixtureId(500 + index);
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionId, projectId, spec.sessionStatus ?? 'active');
    db.prepare('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(fixtureId(600 + index), projectId,
      workIds.get(spec.key), sessionId, spec.agent ?? 'fixture-agent', spec.branch === false ? null : fixtureId(700 + index),
      spec.status ?? 'active', spec.acquiredAt ?? 10, spec.expiresAt ?? null, spec.releasedAt ?? null, 1);
  }
  for (const [index, spec] of (options.evidence ?? []).entries()) {
    db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fixtureId(800 + index), projectId,
      workIds.get(spec.key), `E-${index}`, spec.type ?? 'test', spec.level ?? 'locally_verified',
      spec.summary ?? 'Fixture metadata', spec.locator ?? 'nonexistent-fixture-target.txt', spec.sha256 ?? null,
      spec.sourceSha ?? null, spec.command ?? null, '[]', null, null, null, null, 1, spec.verifiedAt ?? null, 1, JSON.stringify(spec.payload ?? {}));
  }
  db.exec('COMMIT;');
  if (options.wal) db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  return { root, db, projectId, sourceRows, workIds, workSources, manifest,
    dispose: async () => {
      // 连接关闭后只删夹具本轮创建的专用目录，不能接受外部项目路径。
      db.close();
      if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('awr-dashboard-test-')) throw new Error('Invalid fixture cleanup target');
      await rm(root, { recursive: true, force: true });
    } };
}

/** 在夹具写连接更新载荷并同步便捷列，供实时/WAL 测试制造受控提交。 */
export function updateFixtureWork(fixture, key, patch) {
  const row = fixture.db.prepare('SELECT payload_json FROM work_items WHERE external_key=?').get(key);
  const payload = { ...JSON.parse(row.payload_json), ...patch };
  fixture.db.prepare('UPDATE work_items SET payload_json=?,status=?,title=? WHERE external_key=?').run(JSON.stringify(payload), payload.status, payload.title, key);
  fixture.db.prepare('UPDATE projects SET project_revision=project_revision+1').run();
}

/** 记录完整夹具目录的字节/纳秒元数据，包含 DB、WAL、SHM 和权威源。 */
export async function fixtureFileBaseline(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename, { bigint: true });
      const record = { path: path.relative(root, filename).split(path.sep).join('/'),
        size: info.size.toString(), mtime: info.mtimeNs.toString(), ctime: info.ctimeNs.toString(), type: entry.isDirectory() ? 'directory' : 'file' };
      if (entry.isDirectory()) pending.push(filename);
      else record.sha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
      files.push(record);
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
