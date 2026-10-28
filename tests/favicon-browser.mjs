import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createDashboardServer } from '../src/server.js';
import { createVisualFixture } from './visual-fixture.mjs';
import { readSnapshot } from '../src/reader.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const channel = process.env.FAVICON_BROWSER_CHANNEL ?? 'chrome';
assert.ok(['chrome', 'msedge'].includes(channel));
const output = path.join(root, 'verification/dashboard-favicon/browser', channel);
const requests = [];
const errors = [];
let fixture, server, browser;

/** 解码同源图标并在真实16/32像素画布绘制，核对兜底图片和矢量图形可显示。 */
async function decodeIcons(page) {
  return page.evaluate(async () => {
    const result = [];
    for (const name of ['favicon.svg', 'favicon-32.png', 'favicon.ico']) {
      const image = new Image();
      image.src = `/${name}`;
      await image.decode();
      for (const size of [16, 32]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        result.push({ name, size, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
          opaquePixels: [...pixels].filter((value, index) => index % 4 === 3 && value > 0).length });
      }
    }
    return result;
  });
}

try {
  await mkdir(output, { recursive: true });
  fixture = await createVisualFixture();
  server = createDashboardServer({ projectRoot: fixture.root, snapshotReader: async project => {
    const snapshot = await readSnapshot(project);
    snapshot.mode = 'demo';
    return snapshot;
  } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  assert.ok(![4317, 8765].includes(port));
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ channel, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator('[data-node-key]')).toHaveCount(23);
  assert.equal(await page.title(), 'AWR 只读依赖进度图');
  const links = await page.locator('link[rel="icon"]').evaluateAll(nodes =>
    nodes.map(node => ({ href: node.getAttribute('href'), type: node.type, sizes: node.sizes.value })));
  assert.deepEqual(links.map(link => link.href), ['/favicon.ico', '/favicon-32.png', '/favicon.svg']);
  // 记录真正服务器响应，而非只验证HTML源码中存在链接。
  for (const [name, type] of [['favicon.svg', 'image/svg+xml'], ['favicon-32.png', 'image/png'], ['favicon.ico', 'image/x-icon']]) {
    const response = await page.request.get(`${base}/${name}`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()['content-type'], type);
    assert.deepEqual(await response.body(), await readFile(path.join(root, 'public', name)));
    requests.push({ method: 'GET', url: `${base}/${name}`, status: response.status(), contentType: response.headers()['content-type'], bytes: (await response.body()).length });
  }
  const decoded = await decodeIcons(page);
  assert.equal(decoded.length, 6);
  assert.ok(decoded.every(entry => entry.opaquePixels > entry.size * entry.size * 0.7));
  await page.screenshot({ path: path.join(output, 'dashboard.png') });
  // 尺寸样张只证明实际像素绘制；标签栏证据由独立可见浏览器窗口截图提供。
  const cells = ['#f1f3f4', '#202124'].flatMap(background => [16, 32].flatMap(size =>
    ['favicon.svg', 'favicon-32.png', 'favicon.ico'].map(name =>
      `<div style="background:${background};color:${background === '#202124' ? '#fff' : '#111'};padding:16px"><p>${name} · ${size}px</p><img src="/${name}" width="${size}" height="${size}"></div>`))).join('');
  await page.setViewportSize({ width: 900, height: 580 });
  await page.setContent(`<html><head><title>图标实际像素样张</title></head><body style="margin:0;font:14px sans-serif"><main style="display:grid;grid-template-columns:repeat(6,1fr)">${cells}</main></body></html>`);
  await page.locator('img').evaluateAll(async images => Promise.all(images.map(image => image.decode())));
  await page.locator('main').screenshot({ path: path.join(output, 'sizes-light-dark.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, browser: browser.version(),
    channel, deviceScaleFactor: 1, links, decoded,
    checks: ['页面图标引用与原标题', '三种格式实际响应状态、媒体类型和原字节', '三种格式在16/32像素解码绘制', '浅深背景原尺寸截图', '页面无脚本异常'],
    actualTabBarVerifiedByThisScript: false, pageErrors: errors }, null, 2));
  console.log('通过：5类图标专项检查，含6种格式/尺寸组合；真实标签栏另行取证。');
} finally {
  await browser?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await fixture?.dispose();
}
