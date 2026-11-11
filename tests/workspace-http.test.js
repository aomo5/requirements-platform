const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const assets = path.join(__dirname, '../public/assets');

test('LAN HTTP creates design and flow frames without crypto.randomUUID', async () => {
  const frames = [];
  const context = vm.createContext({
    crypto: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) },
    URL, URLSearchParams, Uint8Array, setTimeout, clearTimeout,
    location: { origin: 'http://192.168.0.245:8806' },
    window: { addEventListener() {} },
    document: { createElement() { return { setAttribute() {}, classList: { toggle() {}, add() {} } }; } }
  });
  const model = fs.readFileSync(path.join(assets, 'design-model.js'), 'utf8').replace(/export /g, '');
  const bridge = fs.readFileSync(path.join(assets, 'workspace-bridge.js'), 'utf8')
    .replace(/^import .*\n/, '').replace(/export /g, '');
  vm.runInContext(model + '\n' + bridge + '\nthis.makeHost = createWorkspaceHost;', context);
  const host = context.makeHost({ container: { append: frame => frames.push(frame) } });
  assert.equal(await host.show('design', { path: '40-支付结算/分账账户备注名修改' }), true);
  assert.equal(await host.show('flow', { path: '40-支付结算/分账账户备注名修改' }), true);
  assert.equal(frames.length, 2);
  const tokens = frames.map(f => new URL(f.src, 'http://192.168.0.245:8806').searchParams.get('shellToken'));
  assert.ok(tokens.every(token => /^page_[a-f0-9]{32}$/.test(token)));
  assert.notEqual(tokens[0], tokens[1]);
});
