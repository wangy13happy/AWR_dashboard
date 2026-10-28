import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from './reader.js';
import { DashboardError, sanitizeText } from './safety.js';
import { readProjectRegistry, normalizedProjectRoot, isRegisteredProjectId } from './registry.js';

const WORKSPACE = fileURLToPath(new URL('../', import.meta.url));
const RESPONSE_LIMIT = 8 * 1024 * 1024;

/** 为所有响应设置本地只读应用的安全边界，禁止缓存、嵌入和外部资源。 */
function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  // 卡片位置由本地脚本动态设置；允许本地样式属性，但不允许内联脚本或外部连接。
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'none'");
}

/** 序列化有界响应；不通过截断制造完整图的假象。 */
function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > RESPONSE_LIMIT) {
    throw new DashboardError('RESPONSE_TOO_LARGE', '看板数据超过响应上限，未返回截断图。');
  }
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(bytes);
}

/** 只输出安全的产品错误，未知异常不带原文、堆栈、SQL或文件内容。 */
function publicError(error) {
  if (error instanceof DashboardError) {
    return {
      code: /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : 'snapshot_failed',
      message: sanitizeText(error.message, '读取被安全策略拒绝。').slice(0, 300),
      retryable: error.retryable === true,
    };
  }
  return { code: 'snapshot_failed', message: '无法读取所选项目，请检查项目和数据库状态。', retryable: true };
}

/** 校验回环地址、精确同源和浏览器跨站信息，防止网页借本地服务读取项目。 */
function requestIsLocal(request, port) {
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) { allowed.add('127.0.0.1'); allowed.add('localhost'); }
  if (!allowed.has(host)) return false;
  const origin = request.headers.origin;
  // localhost 和 127.0.0.1 都可打开，但有 Origin 时仍要求与本次 Host 精确同源。
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const fetchSite = request.headers['sec-fetch-site'];
  return fetchSite === undefined || ['none', 'same-origin', 'same-site'].includes(fetchSite);
}

/**
 * 创建登记或固定项目的只读服务。网页只能传登记标识，不能提供任意文件路径。
 * 服务不后台遍历项目；名单不读数据库，只有所选项目请求会读取稳定副本。
 */
export function createDashboardServer({ registryPath, projectRoot, snapshotReader = readSnapshot, publicDirectory, onError = () => {}, agentObserver = null }) {
  const registryMode = registryPath !== undefined;
  if (!registryMode && typeof projectRoot !== 'string') throw new DashboardError('PROJECT_UNAVAILABLE');
  const staticRoot = publicDirectory ?? path.join(WORKSPACE, 'public');
  // 固定路由映射；请求路径从不参与文件路径拼接，因此不能下载项目数据库或源文件。
  const staticFiles = new Map([
    ['/', [path.join(staticRoot, 'index.html'), 'text/html; charset=utf-8']],
    ['/index.html', [path.join(staticRoot, 'index.html'), 'text/html; charset=utf-8']],
    ['/styles.css', [path.join(staticRoot, 'styles.css'), 'text/css; charset=utf-8']],
    ['/app.js', [path.join(staticRoot, 'app.js'), 'text/javascript; charset=utf-8']],
    // 图标仍使用精确白名单；静态请求不读取项目，也不开放任意文件或目录。
    ['/favicon.svg', [path.join(staticRoot, 'favicon.svg'), 'image/svg+xml']],
    ['/favicon-32.png', [path.join(staticRoot, 'favicon-32.png'), 'image/png']],
    ['/favicon.ico', [path.join(staticRoot, 'favicon.ico'), 'image/x-icon']],
    ['/vendor/dagre.js', [path.join(WORKSPACE, 'node_modules/@dagrejs/dagre/dist/dagre.min.js'), 'text/javascript; charset=utf-8']],
  ]);
  const inFlight = new Map();
  let registryTail = Promise.resolve();
  let observedFingerprint = null;
  let registryEpoch = 0;
  let startupDefaultId;

  /** 串行观察清单，任一已检测变化/错误推进代际；修复为原字节也不复活旧在途授权。 */
  function observeRegistry() {
    if (!registryMode) return Promise.resolve({ mode: 'fixed', registryRevision: 'fixed', defaultProjectId: 'default',
      projects: [{ id: 'default', name: sanitizeText(path.basename(projectRoot), '当前项目'), root: projectRoot }] });
    const observation = registryTail.then(async () => {
      try {
        const value = await readProjectRegistry(registryPath);
        if (observedFingerprint !== value.fingerprint) {
          observedFingerprint = value.fingerprint;
          registryEpoch += 1;
        }
        // 启动覆盖仅认定已登记身份；后续移除默认条目返回null，不切换到别的项目。
        if (projectRoot !== undefined && startupDefaultId === undefined) {
          startupDefaultId = value.projects.find((entry) => normalizedProjectRoot(entry.root) === normalizedProjectRoot(projectRoot))?.id ?? null;
        }
        const preferred = projectRoot === undefined ? value.defaultProjectId : startupDefaultId;
        return { mode: 'registry', registryRevision: `${value.fingerprint}.${registryEpoch}`,
          defaultProjectId: value.projects.some((entry) => entry.id === preferred) ? preferred : null, projects: value.projects };
      } catch (error) {
        observedFingerprint = null;
        registryEpoch += 1;
        throw error;
      }
    });
    // 失败不阻塞后续修复观察，但也不保留旧名单供任何新读取授权。
    registryTail = observation.catch(() => {});
    return observation;
  }

  /** 合并同项目同清单版本的进行中读取；不同项目/代际绝不共享全局当前项目。 */
  function obtainSnapshot(entry, registryRevision) {
    const key = JSON.stringify([entry.id, registryRevision]);
    if (!inFlight.has(key)) {
      const read = Promise.resolve().then(() => snapshotReader(entry.root, { agentObservationProvider: () => agentObserver?.latest() ?? null,
        laneOverrides: entry.lanes ?? null })).finally(() => {
        if (inFlight.get(key) === read) inFlight.delete(key);
      });
      inFlight.set(key, read);
    }
    return inFlight.get(key);
  }

  /** 仅接受两项各一次的有界选择参数，不接受路径、命令、多余字段或隐式选项目。 */
  function selectionArguments(url) {
    const params = url.searchParams;
    if ([...params.keys()].some((key) => !['project', 'registry'].includes(key))
      || params.getAll('project').length !== 1 || params.getAll('registry').length !== 1
      || !isRegisteredProjectId(params.get('project')) || !params.get('registry') || params.get('registry').length > 160) {
      throw new DashboardError('INVALID_SELECTION', '请使用当前登记名单中的项目标识与清单版本。');
    }
    return { id: params.get('project'), registryRevision: params.get('registry') };
  }

  /** 请求开始及返回前重新核对授权，已检测的改名/增删/改映射/错误均废止旧响应。 */
  async function selectedSnapshot(url) {
    const selected = registryMode ? selectionArguments(url) : { id: 'default', registryRevision: 'fixed' };
    const registry = await observeRegistry();
    if (registry.registryRevision !== selected.registryRevision) throw new DashboardError('REGISTRY_CHANGED', '项目登记名单已变化，请重新读取名单后选择。', true);
    const entry = registry.projects.find((project) => project.id === selected.id);
    if (!entry) throw new DashboardError('PROJECT_NOT_REGISTERED', '该项目已不在当前登记名单中，请重新选择。');
    let snapshot;
    let failure;
    try { snapshot = await obtainSnapshot(entry, registry.registryRevision); }
    catch (error) { failure = error; }
    const current = await observeRegistry();
    const currentEntry = current.projects.find((project) => project.id === selected.id);
    if (current.registryRevision !== registry.registryRevision || !currentEntry
      || currentEntry.root !== entry.root || currentEntry.name !== entry.name) {
      throw new DashboardError('REGISTRY_CHANGED', '项目登记名单已变化，旧读取结果未返回，请重新选择。', true);
    }
    if (failure) throw failure;
    // 数据库内project.id不改写；登记选择身份是独立的顶层字段，供网页拒绝串项目响应。
    return { ...snapshot, selectedProjectId: selected.id, registryRevision: registry.registryRevision };
  }

  /** 名单仅公开标识和名称，不输出根路径或未经验证的可用性，不触发任一项目数据库读取。 */
  async function projectList() {
    const before = await observeRegistry();
    const current = await observeRegistry();
    if (current.registryRevision !== before.registryRevision) throw new DashboardError('REGISTRY_CHANGED', '项目登记名单正在变化，请重新读取。', true);
    return { version: 1, mode: current.mode, registryRevision: current.registryRevision,
      defaultProjectId: current.defaultProjectId, projects: current.projects.map(({ id, name }) => ({ id, name })), updatedAt: Date.now() };
  }

  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const address = server.address();
      if (!address || typeof address === 'string' || !requestIsLocal(request, address.port)) {
        sendJson(response, 403, { version: 1, error: { code: 'local_request_required', message: '仅允许本地同源查看。', retryable: false }, updatedAt: Date.now() });
        return;
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        sendJson(response, 405, { version: 1, error: { code: 'method_not_allowed', message: '看板只有查看接口。', retryable: false }, updatedAt: Date.now() });
        return;
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
        sendJson(response, 400, { version: 1, error: { code: 'invalid_request', message: '请求格式无效。', retryable: false }, updatedAt: Date.now() });
        return;
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if ([...url.searchParams].length && !(registryMode && url.pathname === '/api/snapshot')) {
        sendJson(response, 400, { version: 1, error: { code: 'query_not_allowed', message: '本次启动的项目已固定，不接受路径或查询参数。', retryable: false }, updatedAt: Date.now() });
        return;
      }
      if (url.pathname === '/api/health') {
        sendJson(response, 200, { version: 1, service: 'ok', projectConfigured: true, updatedAt: Date.now() });
        return;
      }
      if (url.pathname === '/api/projects') {
        sendJson(response, 200, await projectList());
        return;
      }
      if (url.pathname === '/api/snapshot') {
        sendJson(response, 200, await selectedSnapshot(url));
        return;
      }
      const resource = staticFiles.get(url.pathname);
      if (!resource) {
        sendJson(response, 404, { version: 1, error: { code: 'not_found', message: '没有这个查看入口。', retryable: false }, updatedAt: Date.now() });
        return;
      }
      const bytes = await readFile(resource[0]);
      if (bytes.length > RESPONSE_LIMIT) throw new DashboardError('RESOURCE_TOO_LARGE', '页面资源超过上限。');
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { 'Content-Type': resource[1] });
        response.end(bytes);
      }
    } catch (error) {
      const safe = publicError(error);
      onError(safe.code);
      const status = safe.code === 'INVALID_SELECTION' ? 400 : safe.code === 'PROJECT_NOT_REGISTERED' ? 404 : safe.code === 'REGISTRY_CHANGED' ? 409 : 503;
      if (!response.headersSent) sendJson(response, status, { version: 1, error: safe, updatedAt: Date.now() });
      else response.destroy();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  // 入口显式传入服务专属观察器；库级夹具不隐式扫描全机，服务关闭即清空并结束探针。
  server.agentObserverStopped = Promise.resolve();
  server.once('listening', () => agentObserver?.start());
  server.once('close', () => { server.agentObserverStopped = agentObserver?.stop() ?? Promise.resolve(); });
  return server;
}
