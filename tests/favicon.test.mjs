import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDashboardServer } from '../src/server.js';

const publicRoot = new URL('../public/', import.meta.url);

/** 启动仅返回静态产品资源的随机回环服务；任何项目读取都令测试失败。 */
async function staticFixture(t) {
  const server = createDashboardServer({
    projectRoot: 'unused-static-fixture',
    snapshotReader: () => assert.fail('图标请求不应读取项目'),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('页面声明矢量优先、尺寸明确的图标兜底，保留原标题', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const links = [...html.matchAll(/<link\s[^>]*rel="icon"[^>]*>/g)].map(match => match[0]);
  assert.equal(links.length, 3);
  assert.match(links[0], /href="\/favicon\.ico" sizes="16x16 32x32"/);
  assert.match(links[1], /type="image\/png" href="\/favicon-32\.png" sizes="32x32"/);
  assert.match(links[2], /type="image\/svg\+xml" href="\/favicon\.svg" sizes="any"/);
  assert.match(html, /<title>AWR 只读依赖进度图<\/title>/);
});

test('实际图标资源返回200、正确媒体类型及原字节，保留静态安全边界', async t => {
  const base = await staticFixture(t);
  for (const [name, type] of [['favicon.svg', 'image/svg+xml'], ['favicon-32.png', 'image/png'], ['favicon.ico', 'image/x-icon']]) {
    const response = await fetch(`${base}/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), type, name);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(name, publicRoot)));
  }
  // 加入图标不能扩大既有路径、方法和同源授权；拒绝把静态入口当任意下载入口。
  assert.equal((await fetch(`${base}/favicon.svg`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/favicon.svg`, { headers: { Origin: 'https://outside.example' } })).status, 403);
  assert.equal((await fetch(`${base}/favicon.svg?file=.awr/state.db`)).status, 400);
  assert.equal((await fetch(`${base}/favicon-other.png`)).status, 404);
});

test('PNG尺寸和双尺寸ICO目录绑定完整，图标只含本地无文字矢量图形', async () => {
  const png = await readFile(new URL('favicon-32.png', publicRoot));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  const ico = await readFile(new URL('favicon.ico', publicRoot));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  let expectedOffset = 38;
  for (const [index, size] of [16, 32].entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size);
    assert.equal(ico[entry + 1], size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset);
    const layer = ico.subarray(offset, offset + length);
    assert.equal(layer.readUInt32BE(16), size);
    assert.equal(layer.readUInt32BE(20), size);
    if (size === 32) assert.deepEqual(layer, png);
    expectedOffset += length;
  }
  assert.equal(expectedOffset, ico.length);
  const svg = await readFile(new URL('favicon.svg', publicRoot), 'utf8');
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.doesNotMatch(svg, /<(?:text|script|image|foreignObject)\b|\bon\w+=|\bhref=/i);
});
