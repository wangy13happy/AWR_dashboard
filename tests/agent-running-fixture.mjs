import { createReaderFixture, fixtureId } from './reader-fixture.mjs';

export const NATIVE_FIXTURE = '00000000-1111-2222-3333-444444444444';

/** 构造不登记runner目录的临时AWR投影；原生观察另行显式注入，不扫描真实进程。 */
export async function createRunningFixture({ now = Date.now(), expiresAt = now + 60000, claims = false } = {}) {
  const fixture = await createReaderFixture({ works: [{ key: 'A', status: 'in_progress' }],
    claims: claims ? [{ key: 'A', acquiredAt: now - 2000, expiresAt }] : [] });
  const session = fixtureId(500); const work = fixture.workIds.get('A');
  fixture.db.exec('ALTER TABLE sessions ADD COLUMN work_item_id TEXT; ALTER TABLE sessions ADD COLUMN started_at INTEGER; ALTER TABLE sessions ADD COLUMN ended_at INTEGER;');
  if (!claims) fixture.db.prepare('INSERT INTO sessions(id,project_id,status) VALUES(?,?,?)').run(session, fixture.projectId, 'active');
  fixture.db.prepare('UPDATE sessions SET work_item_id=?,started_at=?,ended_at=NULL').run(work, now - 2000);
  fixture.db.exec('CREATE TABLE events(project_id TEXT,event_type TEXT,payload_json TEXT,project_revision INTEGER);');
  fixture.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(fixture.projectId, 'client.bound',
    JSON.stringify({ binding: { client: 'codex', external_session: NATIVE_FIXTURE, session_id: session } }), 1);
  return { ...fixture, now, session,
    /** 仅声明本次临时夹具的原生观察，活动时间不从文件mtime或领取推断。 */
    observation(state = 'executing', sampledAt = now) {
      return { ok: true, sampledAt, processes: [{ pid: 73111, createdAt: now - 10000, client: 'codex', alive: true,
        sessions: [{ id: NATIVE_FIXTURE, state, startedAt: now - 1000 }] }] };
    } };
}
