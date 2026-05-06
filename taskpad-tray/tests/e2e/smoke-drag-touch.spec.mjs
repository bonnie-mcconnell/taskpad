import test from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'src');

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

let server;
let port;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const safeRel = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
    const filePath = path.join(root, safeRel);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    res.setHeader('Content-Type', contentType(filePath));
    res.end(fs.readFileSync(filePath));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function addTask(page, text) {
  await page.fill('#addInput', text);
  await page.click('#addSubmit');
}

test('desktop drag reorder smoke', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await addTask(page, 'Alpha');
  await addTask(page, 'Bravo');
  await addTask(page, 'Charlie');

  const items = page.locator('#listMust .task-item');
  await test.expect(items).toHaveCount(3);

  const first = items.nth(0);
  const second = items.nth(1);
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  if (!firstBox || !secondBox) throw new Error('Unable to measure task boxes');

  await page.mouse.move(firstBox.x + 18, firstBox.y + 18);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + 18, secondBox.y + secondBox.height + 20, { steps: 12 });
  await page.mouse.up();

  const texts = await page.locator('#listMust .task-text').allTextContents();
  assert.notDeepEqual(texts, ['Alpha', 'Bravo', 'Charlie']);
});

test('touch swipe delete smoke', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`);

  await addTask(page, 'Touch One');
  await addTask(page, 'Touch Two');

  const firstItem = page.locator('#listMust .task-item').first();
  await firstItem.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: 300, clientY: 220, pageX: 300, pageY: 220 }],
    changedTouches: [{ identifier: 1, clientX: 300, clientY: 220, pageX: 300, pageY: 220 }],
  });
  await firstItem.dispatchEvent('touchmove', {
    touches: [{ identifier: 1, clientX: 180, clientY: 220, pageX: 180, pageY: 220 }],
    changedTouches: [{ identifier: 1, clientX: 180, clientY: 220, pageX: 180, pageY: 220 }],
  });
  await firstItem.dispatchEvent('touchmove', {
    touches: [{ identifier: 1, clientX: 90, clientY: 220, pageX: 90, pageY: 220 }],
    changedTouches: [{ identifier: 1, clientX: 90, clientY: 220, pageX: 90, pageY: 220 }],
  });
  await firstItem.dispatchEvent('touchend', {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: 90, clientY: 220, pageX: 90, pageY: 220 }],
  });

  await page.waitForTimeout(700);
  await test.expect(page.locator('#listMust .task-item')).toHaveCount(1);

  await context.close();
});
