const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');

const publicDir = path.join(__dirname, '../public');
const executablePath = [process.env.WORKBENCH_BROWSER_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(file => file && fs.existsSync(file));
const entryPath = '00-test/canvas-focus';
const prototype = `<!doctype html><html><body>
  <h1 data-wb-element="heading">账户详情</h1>
  <button id="action" autofocus onclick="this.textContent='已点击'">确定</button>
  <dialog id="modal"><input id="dialogInput" autofocus></dialog>
  <script>
    function focusAction(dialog) {
      if (dialog === 'dynamic') {
        const modal = document.createElement('dialog');
        modal.innerHTML = '<input autofocus aria-label="费用承担比例">';
        document.body.append(modal); modal.showModal();
      }
      else if (dialog) document.getElementById('modal').showModal();
      else document.getElementById('action').focus();
      parent.postMessage({ fixtureFocus: true }, '*');
    }
    addEventListener('message', event => {
      if (event.data?.fixtureFocusRequest) setTimeout(() => focusAction(event.data.dialog), 40);
    });
  </script></body></html>`;
const fixtures = () => [
  { id: 'origin', name: '账户详情', x: 0, y: 0, width: 390, height: 600, html: prototype, source: '', route: '' },
  { id: 'next', name: '异步详情', x: 1100, y: 0, width: 390, height: 600, source: '', route: '',
    html: prototype.replace('</body>', '<script>setTimeout(() => focusAction(false), 80)</script></body>') },
];

// Serve the real editor and assets, but keep every API write in this fixture.
async function fixtureServer() {
  let workspace = { revision: 1, pages: fixtures() };
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/tree') return json({ modules: [{ module: '00-test', features: [{ path: entryPath, feature: '画布焦点回归' }] }] });
    if (url.pathname === '/api/design') {
      if (req.method === 'PUT') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const payload = JSON.parse(raw);
        assert.equal(payload.expectedRevision, workspace.revision);
        workspace = { revision: workspace.revision + 1, pages: payload.pages };
        writes.push(structuredClone(workspace));
      }
      return json({ entry: { path: entryPath, feature: '画布焦点回归', prototypes: [] }, workspace, canEdit: true, accessMode: 'team' });
    }
    if (url.pathname.startsWith('/api/')) { res.statusCode = 404; return json({ error: 'Unexpected fixture API' }); }
    const file = url.pathname === '/design' ? path.join(publicDir, 'design.html') : path.resolve(publicDir, '.' + url.pathname);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, writes, close: () => new Promise(resolve => server.close(resolve)) };
}

test('prototype autofocus cannot roll back canvas gestures; interactive views retain focus', {
  skip: executablePath ? false : 'Set WORKBENCH_BROWSER_EXECUTABLE to run browser regression', timeout: 30000,
}, async t => {
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  async function editor(t) {
    const server = await fixtureServer(); t.after(() => server.close());
    const context = await browser.newContext({ viewport: { width: 1450, height: 1000 } }); t.after(() => context.close());
    await context.addInitScript(({ entryPath }) => {
      if (location.pathname !== '/design') return;
      sessionStorage.setItem('requirementsPortal.designView.v1:' + entryPath, JSON.stringify({
        view: { x: 40, y: 100, scale: 1 }, selected: 'origin', selection: ['origin'], mode: 'select',
      }));
      window.fixtureFocusCount = 0;
      addEventListener('message', event => { if (event.data?.fixtureFocus) window.fixtureFocusCount++; });
    }, { entryPath });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(server.url + '/design?standalone=1&page=origin&path=' + encodeURIComponent(entryPath));
    await page.locator('.artboard[data-page=origin] iframe').waitFor();
    return { page, server };
  }
  const view = page => page.locator('#canvas').evaluate(el => {
    const matrix = new DOMMatrix(el.style.transform); return { x: matrix.e, y: matrix.f, scale: matrix.a };
  });
  async function focusDuringGesture(page, dialog = false) {
    const before = await page.evaluate(() => window.fixtureFocusCount);
    await page.locator('.artboard[data-page=origin] iframe').evaluate((frame, dialog) => frame.contentWindow.postMessage({ fixtureFocusRequest: true, dialog }, '*'), dialog);
    await page.waitForFunction(before => window.fixtureFocusCount > before, before);
  }

  await t.test('hand pan survives lazy-mounted autofocus and remembers the released position', async t => {
    const { page, server } = await editor(t);
    await page.locator('#panTool').click();
    const rect = await page.locator('#viewport').boundingBox(), before = await view(page);
    await page.mouse.move(rect.x + rect.width - 80, rect.y + 200); await page.mouse.down();
    await page.mouse.move(rect.x + 100, rect.y + 230, { steps: 20 });
    await page.waitForFunction(() => window.fixtureFocusCount > 0);
    const expected = { x: before.x - rect.width + 180, y: before.y + 30, scale: 1 };
    assert.deepEqual(await view(page), expected);
    await page.mouse.up(); assert.deepEqual(await view(page), expected);
    assert.equal(await page.locator('#viewport').evaluate(el => el === document.activeElement), true);
    await page.waitForFunction(({ entryPath, expected }) => {
      const saved = JSON.parse(sessionStorage.getItem('requirementsPortal.designView.v1:' + entryPath));
      return saved.view.x === expected.x && saved.view.y === expected.y;
    }, { entryPath, expected });
    assert.equal(server.writes.length, 0, 'Panning must not save business page positions');
  });

  await t.test('board drag survives native-dialog focus and commits one undoable move', async t => {
    const { page, server } = await editor(t), hit = page.locator('.artboard[data-page=origin] .artboard-hit');
    const rect = await hit.boundingBox();
    await page.mouse.move(rect.x + 60, rect.y + 60); await page.mouse.down();
    await page.mouse.move(rect.x + 160, rect.y + 100, { steps: 8 });
    await focusDuringGesture(page, true);
    assert.equal(server.writes.length, 0, 'In-progress drag must stay out of autosave');
    assert.equal(await page.locator('.artboard[data-page=origin]').evaluate(el => el.style.left), '100px');
    const saved = page.waitForResponse(r => r.url().includes('/api/design?') && r.request().method() === 'PUT');
    await page.mouse.up(); await saved;
    assert.deepEqual(server.writes.at(-1).pages.map(p => [p.id, p.x, p.y]), [['origin', 100, 40], ['next', 1100, 0]]);
    assert.equal(server.writes.at(-1).pages[0].html, prototype, 'Thumbnail focus isolation must not enter the saved HTML');
    const undone = page.waitForResponse(r => r.url().includes('/api/design?') && r.request().method() === 'PUT');
    await page.locator('#undoButton').click(); await undone;
    assert.equal(server.writes.at(-1).pages[0].x, 0);
    assert.equal(await page.locator('#undoButton').isDisabled(), true);
  });

  await t.test('Escape still cancels a pan', async t => {
    const { page, server } = await editor(t); await page.locator('#panTool').click();
    const rect = await page.locator('#viewport').boundingBox(), before = await view(page);
    await page.mouse.move(rect.x + 600, rect.y + 300); await page.mouse.down();
    await page.mouse.move(rect.x + 500, rect.y + 350, { steps: 5 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await view(page), before); assert.equal(server.writes.length, 0);
  });

  for (const method of ['hand', 'space']) await t.test(`${method} pan survives a dynamically created modal`, async t => {
    const { page, server } = await editor(t);
    if (method === 'hand') await page.locator('#panTool').click();
    else { await page.locator('#viewport').focus(); await page.keyboard.down('Space'); }
    const rect = await page.locator('#viewport').boundingBox(), before = await view(page);
    await page.mouse.move(rect.x + 600, rect.y + 300); await page.mouse.down();
    await page.mouse.move(rect.x + 450, rect.y + 350, { steps: 5 });
    await focusDuringGesture(page, 'dynamic');
    const modal = page.frameLocator('.artboard[data-page=origin] iframe').locator('dialog[open]');
    assert.equal(await modal.isVisible(), true, 'The dialog must still render in the thumbnail');
    assert.equal(await modal.evaluate(el => el.inert), true);
    const expected = { ...before, x: before.x - 150, y: before.y + 50 };
    assert.deepEqual(await view(page), expected);
    await page.mouse.move(rect.x + 400, rect.y + 370, { steps: 5 });
    await page.mouse.up(); if (method === 'space') await page.keyboard.up('Space');
    assert.deepEqual(await view(page), { ...before, x: before.x - 200, y: before.y + 70 });
    assert.equal(server.writes.length, 0);
  });

  await t.test('full preview and element editing stay interactive', async t => {
    const { page } = await editor(t);
    await page.locator('#previewButton').click();
    const preview = page.frameLocator('#fullPreview'); await preview.locator('#action').waitFor();
    assert.equal(await preview.locator('body').evaluate(el => el.inert), false);
    await preview.locator('#action').focus();
    assert.equal(await preview.locator('#action').evaluate(el => el === document.activeElement), true);
    await preview.locator('#action').press('Enter');
    assert.equal(await preview.locator('#action').innerText(), '已点击');
    await preview.locator('body').evaluate(() => focusAction('dynamic'));
    assert.equal(await preview.locator('dialog[open] input').evaluate(el => el === document.activeElement), true);
    assert.equal(await preview.locator('dialog[open]').evaluate(el => el.inert), false);
    await page.locator('#previewDialog [data-close]').first().click();
    await page.locator('#elementEditButton').click();
    const frame = page.frameLocator('.artboard[data-page=origin] iframe');
    await page.locator('body.element-mode').waitFor();
    assert.equal(await frame.locator('body').evaluate(el => el.inert), false);
  });
});
