import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const output = fileURLToPath(new URL('../verification/', import.meta.url));
const project = await realpath(path.resolve(process.argv[2] || ''));
const base = new URL(process.argv[3] || 'http://127.0.0.1:4317');
assert.equal(base.protocol, 'http:');
assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.pathname, '/');
assert.equal(base.search, '');
assert.equal(base.hash, '');
const startedAt = Date.now();

/** 只读取文件字节和元数据，不用SQLite打开任何被查看文件。 */
async function fingerprint(name) {
  try {
    const filename = path.join(project, ...name.split('/'));
    const info = await stat(filename);
    const bytes = await readFile(filename);
    return { name, size: info.size, mtimeMs: info.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return { name, missing: true };
    throw error;
  }
}

/** 记录治理目录中的文件与子目录清单，拒绝链接而不是沿链接读取其他项目。 */
async function inventory(relative = '.awr') {
  const items = [];
  for (const entry of await readdir(path.join(project, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), '只读验收不跟随治理目录中的链接');
    if (entry.isDirectory()) {
      items.push({ name, type: 'directory' }, ...await inventory(name));
    } else {
      assert.ok(entry.isFile(), '只读验收只检查普通文件');
      items.push({ type: 'file', ...await fingerprint(name) });
    }
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

/** 保存机器可读验收产物；所有写入仅在本看板项目的verification目录。 */
async function save(name, value) {
  await writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** 对当前真实浏览器快照只保留计数与当前性标记，不保存任务正文或原始载荷。 */
function snapshotSummary(snapshot) {
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.mode, 'live');
  assert.ok(Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges));
  return { revision: snapshot.revision, nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length,
    sourceFingerprint: snapshot.sourceFingerprint,
    sources: snapshot.sources.map(source => ({ id: source.id, freshness: source.freshness })),
    counts: snapshot.counts };
}

const original = JSON.parse(await readFile(path.join(output, 'live-before.json'), 'utf8'));
assert.equal(path.normalize(original.project), path.normalize(project));
const names = original.files.map(file => file.name);
const before = { project, capturedAt: Date.now(), method: 'file-bytes-only-no-sqlite-open',
  files: await Promise.all(names.map(fingerprint)), inventory: await inventory() };
await save('live-window-before.json', before);
let browser;
let failure = null;
let snapshots = [];
let pageErrors = [];
let screenshotSaved = false;
try {
  const health = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(8000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'ok');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 2300, height: 1308 }, timezoneId: 'Asia/Shanghai' });
  const pending = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.url() === new URL('/api/snapshot', base).href) {
      pending.push(response.json().then(snapshot => snapshots.push(snapshotSummary(snapshot))));
    }
  });
  await page.goto(new URL('/#view=graph', base).href);
  await expect(page.locator('[data-node-key]')).not.toHaveCount(0, { timeout: 10000 });
  await expect(page.getByTestId('demo-badge')).toBeHidden();
  // 在真实项目只查看，不制造状态或来源变化；连续覆盖至少两个5秒轮询周期。
  await page.waitForTimeout(10500);
  const activeCard = page.locator('.task-card.status-in_progress').first();
  if (await activeCard.count()) await activeCard.click();
  else await page.locator('[data-node-key]').first().click();
  await page.screenshot({ path: path.join(output, 'live-dashboard.png') });
  screenshotSaved = true;
  await Promise.all(pending);
  assert.ok(snapshots.length >= 3);
  assert.deepEqual(pageErrors, []);
} catch (error) {
  // 产物不回显请求正文、源码内容或未知异常；失败结果保留供排查，不伪装成通过。
  failure = error instanceof assert.AssertionError ? '实时查看验收断言未通过' : '实时查看验收未完成';
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
const after = { project, capturedAt: Date.now(), method: 'file-bytes-only-no-sqlite-open',
  files: await Promise.all(names.map(fingerprint)), inventory: await inventory() };
await save('live-window-after.json', after);
await save('live-after.json', { project, method: after.method, files: after.files });
const unchanged = JSON.stringify(before.files) === JSON.stringify(after.files)
  && JSON.stringify(before.inventory) === JSON.stringify(after.inventory);
const originalBaselineUnchanged = JSON.stringify(original.files) === JSON.stringify(after.files);
if (!unchanged) process.exitCode = 1;
const report = { passed: failure === null && unchanged, startedAt, verifiedAt: Date.now(), project,
  observationMs: Date.now() - startedAt, monitoredFiles: names.length,
  inventoryEntries: before.inventory.length, snapshotCount: snapshots.length, snapshots,
  noFileChanges: unchanged, originalBaselineUnchanged, pageErrors, screenshotSaved, failure,
  boundary: '正式稳定副本产品读取期间比对文件字节、大小、修改时间和治理目录清单；不追认最初缺少事前基线的直接SQLite诊断为零写入，不认证被查看项目完成或长期后台可靠性。' };
await save('live-readonly-results.json', report);
console.log(JSON.stringify({ passed: report.passed, snapshotCount: snapshots.length, noFileChanges: unchanged,
  originalBaselineUnchanged, inventoryEntries: before.inventory.length, unexpectedPageErrors: pageErrors.length }));
