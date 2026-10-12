import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createDashboardServer } from '../src/server.js';
import { DashboardError } from '../src/safety.js';
import { createReaderFixture, fixtureFileBaseline } from './reader-fixture.mjs';

/** 创建仅属于测试的资源目录与随机本地端口，结束后关闭并删除自有夹具。 */
async function fixture(t, snapshotReader = async () => ({ version: 1, project: { id: 'p', name: '测试' }, readOnly: true, nodes: [], edges: [] }), options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'awr-dashboard-http-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>本地测试</title>');
  await writeFile(path.join(directory, 'styles.css'), 'body{color:blue}');
  await writeFile(path.join(directory, 'app.js'), 'void 0;');
  const registryPath = path.join(directory, 'projects.json');
  const registry = { version: 1, defaultProjectId: 'a', projects: [
    { id: 'a', name: '甲项目', root: path.join(directory, 'registered-a') },
    { id: 'b', name: '乙项目', root: path.join(directory, 'registered-b') },
  ] };
  if (options.registry) await writeFile(registryPath, JSON.stringify(registry));
  const errors = [];
  const server = createDashboardServer({
    projectRoot: options.registry ? registry.projects.find((entry) => entry.id === options.startupId)?.root : directory,
    ...(options.registry ? { registryPath } : {}), snapshotReader: options.actualReader ? undefined : snapshotReader,
    publicDirectory: directory, onError: code => errors.push(code),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // 目录来自本测试自己的mkdtemp；不接收项目路径或浏览器输入作为清理目标。
    await rm(directory, { recursive: true, force: true });
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, errors, directory, registryPath, registry };
}

/** 可控异步门闩使在途变更测试不依赖固定睡眠或复制真实项目的写入节奏。 */
function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

/** 从服务读最新公开名单，不在测试中猜清单修订生成形式或缓存旧版本。 */
async function list(base) {
  const response = await fetch(`${base}/api/projects`);
  assert.equal(response.status, 200);
  return response.json();
}

/** 请求只能带登记标识和本轮名单版本，实际路径永不进入网页参数。 */
function selectedUrl(base, id, registryRevision) {
  return `${base}/api/snapshot?${new URLSearchParams({ project: id, registry: registryRevision })}`;
}

/** 发送可指定Host的低层请求，以验证浏览器工具通常不会允许伪造的边界。 */
function rawRequest(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${pathname}`, { headers }, response => {
      let text = '';
      response.on('data', bytes => { text += bytes; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
  });
}

test('服务健康不等于数据库通过；固定快照和项目列表可读', async t => {
  const { base } = await fixture(t);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'ok');
  const response = await fetch(`${base}/api/snapshot`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).readOnly, true);
  assert.equal((await (await fetch(`${base}/api/projects`)).json()).projects.length, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('只允许GET且拒绝路径、查询、数据库下载和未知资源', async t => {
  const { base } = await fixture(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await fetch(`${base}/api/snapshot`, { method })).status, 405);
  }
  for (const name of ['?project=other', '?file=.awr/state.db', '?cmd=delete']) {
    assert.equal((await fetch(`${base}/api/snapshot${name}`)).status, 400);
  }
  for (const name of ['/.awr/state.db', '/reader.js', '/%2e%2e/.awr/state.db', '/missing']) {
    assert.equal((await fetch(`${base}${name}`)).status, 404);
  }
  for (const name of ['/', '/index.html', '/styles.css', '/app.js', '/vendor/dagre.js']) {
    assert.equal((await fetch(`${base}${name}`)).status, 200);
  }
});

test('拒绝域名重绑定、跨站和非精确同源Origin', async t => {
  const { base } = await fixture(t);
  assert.equal((await rawRequest(base, '/api/snapshot', { Host: 'outside.example' })).status, 403);
  for (const origin of ['https://outside.example', 'null', 'http://localhost:9', `${base}/path`]) {
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: { Origin: base } })).status, 200);
  assert.equal((await rawRequest(base, '/api/snapshot', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('同时请求共用一次读取，完成后新请求重读', async t => {
  let reads = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { base } = await fixture(t, async () => { reads += 1; await blocked; return { project: { id: 'p' } }; });
  const calls = [fetch(`${base}/api/snapshot`), fetch(`${base}/api/projects`)];
  await new Promise(resolve => setTimeout(resolve, 40));
  release();
  assert.deepEqual((await Promise.all(calls)).map(r => r.status), [200, 200]);
  assert.equal(reads, 1);
  await fetch(`${base}/api/snapshot`);
  assert.equal(reads, 2);
});

test('未知异常不泄露源内容或堆栈，产品错误保留安全代码', async t => {
  const { base, errors } = await fixture(t, async () => { throw new Error('private raw projection and stack'); });
  const response = await fetch(`${base}/api/snapshot`);
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /private raw|stack/);
  assert.equal(errors[0], 'snapshot_failed');
  const other = await fixture(t, async () => { throw new DashboardError('CAPTURE_CONFLICT', '', true); });
  const failure = await (await fetch(`${other.base}/api/snapshot`)).json();
  assert.equal(failure.error.code, 'CAPTURE_CONFLICT');
  assert.equal(failure.error.retryable, true);
});

test('超限响应明确失败，不返回截断图', async t => {
  const { base } = await fixture(t, async () => ({ nodes: 'x'.repeat(8 * 1024 * 1024) }));
  const response = await fetch(`${base}/api/snapshot`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'RESPONSE_TOO_LARGE');
});

test('固定名单无需读快照，成功身份附在顶层而数据库项目标识保持原样', async (t) => {
  let reads = 0;
  const { base } = await fixture(t, async () => { reads += 1; return { project: { id: 'database-p' }, readOnly: true }; });
  const projects = await list(base);
  assert.equal(reads, 0);
  assert.equal(projects.mode, 'fixed');
  assert.equal(projects.registryRevision, 'fixed');
  assert.equal(projects.defaultProjectId, 'default');
  assert.deepEqual(Object.keys(projects.projects[0]).sort(), ['id', 'name']);
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snapshot.selectedProjectId, 'default');
  assert.equal(snapshot.registryRevision, 'fixed');
  assert.equal(snapshot.project.id, 'database-p');
});

test('登记名单保留不可用条目且不读数据库，只选中的项目根进入读取器', async (t) => {
  const roots = [];
  const { base, registry } = await fixture(t, async (root) => { roots.push(root); return { project: { id: 'database-p' } }; }, { registry: true });
  const projects = await list(base);
  assert.equal(projects.mode, 'registry');
  assert.equal(projects.defaultProjectId, 'a');
  assert.deepEqual(projects.projects, registry.projects.map(({ id, name }) => ({ id, name })));
  assert.deepEqual(roots, []);
  assert.doesNotMatch(JSON.stringify(projects), /registered-a|registered-b|root|available|healthy/);
  const response = await fetch(selectedUrl(base, 'b', projects.registryRevision));
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.project.id, 'database-p');
  assert.equal(snapshot.selectedProjectId, 'b');
  assert.equal(snapshot.registryRevision, projects.registryRevision);
  assert.deepEqual(roots, [registry.projects[1].root]);
});

test('登记选择拒绝缺失重复多余参数、路径、未知标识与旧清单版本', async (t) => {
  let reads = 0;
  const { base } = await fixture(t, async () => { reads += 1; return {}; }, { registry: true });
  const { registryRevision } = await list(base);
  const invalid = ['', '?project=a', '?registry=v', '?project=a&project=b&registry=v', '?project=a&registry=v&registry=v',
    '?project=..%2Foutside&registry=v', '?project=C%3A%5Coutside&registry=v', '?project=a&registry=v&file=state.db'];
  for (const query of invalid) {
    const response = await fetch(`${base}/api/snapshot${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_SELECTION');
  }
  const unknown = await fetch(selectedUrl(base, 'unknown', registryRevision));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'PROJECT_NOT_REGISTERED');
  const outdated = await fetch(selectedUrl(base, 'a', 'old-revision'));
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).error.code, 'REGISTRY_CHANGED');
  assert.equal((await fetch(`${base}/api/projects?project=a`)).status, 400);
  assert.equal(reads, 0);
});

test('不同项目单飞隔离，同项目同版本并发共读，后续请求重新读取', async (t) => {
  const release = deferred();
  const startedA = deferred();
  const startedB = deferred();
  const received = deferred();
  const roots = [];
  const { server, base, registry } = await fixture(t, async (root) => {
    roots.push(root);
    (root.endsWith('registered-a') ? startedA : startedB).resolve();
    await release.promise;
    return { project: { id: path.basename(root) } };
  }, { registry: true });
  t.after(() => release.resolve());
  let requests = 0;
  server.on('request', (request) => { if (request.url.startsWith('/api/snapshot') && ++requests === 3) received.resolve(); });
  const current = await list(base);
  const calls = [fetch(selectedUrl(base, 'a', current.registryRevision)), fetch(selectedUrl(base, 'a', current.registryRevision)),
    fetch(selectedUrl(base, 'b', current.registryRevision))];
  await Promise.all([received.promise, startedA.promise, startedB.promise]);
  await list(base);
  release.resolve();
  const responses = await Promise.all(calls);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.deepEqual(roots.sort(), registry.projects.map((entry) => entry.root).sort());
  const values = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(values.map((snapshot) => snapshot.selectedProjectId), ['a', 'a', 'b']);
  await fetch(selectedUrl(base, 'a', current.registryRevision));
  assert.equal(roots.length, 3);
});

test('热增删改名即时列出，启动默认移除后为null，不回退第一条', async (t) => {
  const { base, registryPath, registry, directory } = await fixture(t, async () => ({}), { registry: true, startupId: 'b' });
  const first = await list(base);
  assert.equal(first.defaultProjectId, 'b');
  const changed = { ...registry, projects: [{ ...registry.projects[0], name: '改名甲' },
    { id: 'c', name: '新增丙', root: path.join(directory, 'registered-c') }] };
  await writeFile(registryPath, JSON.stringify(changed));
  const next = await list(base);
  assert.notEqual(next.registryRevision, first.registryRevision);
  assert.equal(next.defaultProjectId, null);
  assert.deepEqual(next.projects, changed.projects.map(({ id, name }) => ({ id, name })));
  await writeFile(registryPath, JSON.stringify({ version: 1, defaultProjectId: null, projects: [] }));
  assert.deepEqual((await list(base)).projects, []);
});

test('在途改映射与改名均拒绝旧结果，新项目版本不会加入旧单飞读取', async (t) => {
  for (const change of ['root', 'name']) {
    const started = deferred();
    const release = deferred();
    let reads = 0;
    const { base, registryPath, registry, directory } = await fixture(t, async (root) => {
      reads += 1;
      if (reads === 1) { started.resolve(); await release.promise; }
      return { project: { id: root }, secretOldMarker: reads === 1 ? 'old-result' : 'new-result' };
    }, { registry: true });
    t.after(() => release.resolve());
    const first = await list(base);
    const oldRequest = fetch(selectedUrl(base, 'a', first.registryRevision));
    await started.promise;
    const replacement = { ...registry, projects: registry.projects.map((entry) => entry.id !== 'a' ? entry
      : { ...entry, [change]: change === 'root' ? path.join(directory, 'new-a') : '新甲名称' }) };
    await writeFile(registryPath, JSON.stringify(replacement));
    const current = await list(base);
    const freshResponse = await fetch(selectedUrl(base, 'a', current.registryRevision));
    assert.equal(freshResponse.status, 200);
    assert.equal((await freshResponse.json()).registryRevision, current.registryRevision);
    assert.equal(reads, 2);
    release.resolve();
    const oldResponse = await oldRequest;
    assert.equal(oldResponse.status, 409);
    const failure = await oldResponse.text();
    assert.match(failure, /REGISTRY_CHANGED/);
    assert.doesNotMatch(failure, /old-result|secretOldMarker/);
  }
});

test('当前项目在途移除废止结果，重现同ID也不复活旧代际', async (t) => {
  const started = deferred();
  const release = deferred();
  const { base, registryPath, registry } = await fixture(t, async () => { started.resolve(); await release.promise; return { nodes: ['old-data'] }; }, { registry: true });
  t.after(() => release.resolve());
  const first = await list(base);
  const oldRequest = fetch(selectedUrl(base, 'a', first.registryRevision));
  await started.promise;
  await writeFile(registryPath, JSON.stringify({ ...registry, projects: [registry.projects[1]] }));
  const removed = await list(base);
  assert.equal((await fetch(selectedUrl(base, 'a', removed.registryRevision))).status, 404);
  await writeFile(registryPath, JSON.stringify(registry));
  const restored = await list(base);
  assert.notEqual(restored.registryRevision, first.registryRevision);
  release.resolve();
  const response = await oldRequest;
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /old-data/);
});

test('清单损坏停新读取，相同字节修复也废止在途授权且不泄露正文', async (t) => {
  const started = deferred();
  const release = deferred();
  let reads = 0;
  const { base, registryPath, registry } = await fixture(t, async () => {
    reads += 1;
    if (reads === 1) { started.resolve(); await release.promise; }
    return { project: { id: 'p' } };
  }, { registry: true });
  t.after(() => release.resolve());
  const first = await list(base);
  const oldRequest = fetch(selectedUrl(base, 'a', first.registryRevision));
  await started.promise;
  await writeFile(registryPath, '{"private_registry_text":');
  for (const url of [`${base}/api/projects`, selectedUrl(base, 'b', first.registryRevision)]) {
    const response = await fetch(url);
    assert.equal(response.status, 503);
    const error = await response.text();
    assert.match(error, /REGISTRY_INVALID/);
    assert.doesNotMatch(error, /private_registry_text/);
  }
  assert.equal(reads, 1);
  await writeFile(registryPath, JSON.stringify(registry));
  const restored = await list(base);
  assert.notEqual(restored.registryRevision, first.registryRevision);
  assert.equal((await fetch(selectedUrl(base, 'a', restored.registryRevision))).status, 200);
  assert.equal(reads, 2);
  release.resolve();
  assert.equal((await oldRequest).status, 409);
});

test('返回前首次发现清单损坏立即拒绝成功，不返回已读项目内容', async (t) => {
  const started = deferred();
  const release = deferred();
  const { base, registryPath } = await fixture(t, async () => { started.resolve(); await release.promise; return { oldData: 'unreturned-project-data' }; }, { registry: true });
  t.after(() => release.resolve());
  const current = await list(base);
  const pending = fetch(selectedUrl(base, 'a', current.registryRevision));
  await started.promise;
  // 不先读取名单，也不发其他请求；必须是快照返回前自己的授权核验发现损坏。
  await writeFile(registryPath, '{');
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /REGISTRY_INVALID/);
  assert.doesNotMatch(body, /unreturned-project-data|oldData/);
});

test('选中坏路径失败不影响其他项目，真实夹具列表和快照保持原目录不变', async (t) => {
  const project = await createReaderFixture();
  t.after(() => project.dispose());
  // 不注入读取器时走正式字节副本路径；只使用专用测试项目，不打开外部原数据库。
  const { base, registryPath, registry } = await fixture(t, undefined, { registry: true, actualReader: true });
  await writeFile(registryPath, JSON.stringify({ ...registry, projects: [{ ...registry.projects[0], root: project.root }, registry.projects[1]] }));
  const before = await fixtureFileBaseline(project.root);
  const current = await list(base);
  assert.deepEqual(await fixtureFileBaseline(project.root), before);
  const unavailable = await fetch(selectedUrl(base, 'b', current.registryRevision));
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /registered-b|stack/);
  const good = await fetch(selectedUrl(base, 'a', current.registryRevision));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).selectedProjectId, 'a');
  assert.deepEqual(await fixtureFileBaseline(project.root), before);
  assert.equal((await list(base)).projects.length, 2);
});

test('清单缺失和超限停新读取，不影响服务健康且恢复后可重新选择', async (t) => {
  let reads = 0;
  const { base, registryPath, registry } = await fixture(t, async () => { reads += 1; return {}; }, { registry: true });
  const first = await list(base);
  await rm(registryPath);
  const missing = await fetch(selectedUrl(base, 'a', first.registryRevision));
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'REGISTRY_UNAVAILABLE');
  await writeFile(registryPath, ' '.repeat(64 * 1024 + 1));
  const tooLarge = await fetch(`${base}/api/projects`);
  assert.equal(tooLarge.status, 503);
  assert.equal((await tooLarge.json()).error.code, 'REGISTRY_TOO_LARGE');
  assert.equal(reads, 0);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  await writeFile(registryPath, JSON.stringify(registry));
  const restored = await list(base);
  assert.equal((await fetch(selectedUrl(base, 'b', restored.registryRevision))).status, 200);
});

test('命令行只允许已登记启动默认，不用project参数扩大读取范围', async (t) => {
  const { registryPath, directory } = await fixture(t, undefined, { registry: true });
  const entry = fileURLToPath(new URL('../bin/awr-dashboard.mjs', import.meta.url));
  const run = promisify(execFile);
  const help = await run(process.execPath, ['--no-warnings', entry, '--help'], { windowsHide: true });
  assert.match(help.stdout, /--projects/);
  await assert.rejects(run(process.execPath, ['--no-warnings', entry, '--projects', registryPath, '--project', directory], { windowsHide: true }),
    (error) => error.code === 1 && /启动默认项目未登记/.test(error.stderr) && !error.stderr.includes(directory));
  await assert.rejects(run(process.execPath, ['--no-warnings', entry, '--projects', path.join(directory, 'missing.json')], { windowsHide: true }),
    (error) => error.code === 1 && /登记清单无法稳定读取/.test(error.stderr) && !error.stderr.includes('missing.json'));
});
