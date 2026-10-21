'use strict';
// Validates extension packaging and the real service worker using simulated Chrome APIs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const files = new Set();
function referencedFile(relative) {
  assert.equal(typeof relative, 'string');
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(root + path.sep), 'Referenced file must stay inside the extension: ' + relative);
  assert.ok(fs.statSync(target).isFile(), 'Missing extension asset: ' + relative);
  files.add(relative);
  return target;
}
assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
assert.ok(manifest.name && manifest.description);
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'clipboardWrite', 'scripting'].sort());
assert.ok(!manifest.host_permissions?.length, 'Use click-scoped activeTab instead of persistent website grants');
assert.ok(!manifest.content_scripts?.length, 'The bridge should open on toolbar click, not automatically on every page');
assert.ok(!manifest.action?.default_popup, 'The toolbar click handler owns the action');
const workerPath = referencedFile(manifest.background.service_worker);
referencedFile('bridge.js');
for (const [size, relative] of Object.entries(manifest.icons || {})) {
  const icon = fs.readFileSync(referencedFile(relative));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Icons must be valid PNG files');
  assert.equal(icon.readUInt32BE(16), Number(size), 'Icon width should match its manifest size');
  assert.equal(icon.readUInt32BE(20), Number(size), 'Icon height should match its manifest size');
}
for (const relative of Object.values(manifest.action.default_icon || {})) referencedFile(relative);
if (manifest.action.default_popup) referencedFile(manifest.action.default_popup);
assert.ok(!/unsafe-eval|unsafe-inline|https?:/.test(JSON.stringify(manifest.content_security_policy || {})), 'Extension CSP must not allow remote/evaluated code');
const worker = fs.readFileSync(workerPath, 'utf8');
assert.ok(!/\b(?:eval|new\s+Function)\s*\(/.test(worker), 'Worker must use packaged scripts');

function harness({ failInjection = false } = {}) {
  let handler;
  const calls = { injection: [], badges: [], titles: [], colors: [], errors: [] };
  const chrome = {
    action: {
      onClicked: { addListener(fn) { handler = fn; } },
      async setBadgeText(value) { calls.badges.push(plain(value)); },
      async setBadgeBackgroundColor(value) { calls.colors.push(plain(value)); },
      async setTitle(value) { calls.titles.push(plain(value)); }
    },
    scripting: { async executeScript(value) {
      calls.injection.push(plain(value));
      if (failInjection) throw Error('Simulated Chrome injection failure');
      return [{ frameId: 0, result: undefined }];
    } },
    runtime: { lastError: undefined, getURL(relative) { return 'chrome-extension://test/' + relative; } }
  };
  const context = vm.createContext({ chrome, URL, console: { info() {}, log() {}, warn() {}, error(...args) { calls.errors.push(args.map(String).join(' ')); } }, setTimeout, clearTimeout });
  vm.runInContext(worker, context, { filename: workerPath });
  assert.equal(typeof handler, 'function', 'Register chrome.action.onClicked');
  return { calls, async click(tab) { await handler(tab); await new Promise(resolve => setImmediate(resolve)); } };
}

(async () => {
  const passed = [];
  const test = async (name, fn) => { await fn(); passed.push(name); console.log('PASS ' + name); };
  await test('Manifest V3 package has required local assets and click-scoped permissions', async () => assert.ok(files.size >= 2));
  await test('toolbar click on AI Studio injects only the packaged bridge into that tab', async () => {
    const h = harness();
    await h.click({ id: 41, url: 'https://aistudio.google.com/prompts/test' });
    assert.equal(h.calls.injection.length, 1);
    const injection = h.calls.injection[0];
    assert.deepEqual(injection.target, { tabId: 41 });
    assert.deepEqual(injection.files, ['bridge.js']);
    assert.ok(!injection.world || injection.world === 'ISOLATED', 'Keep project state in the isolated extension world');
    assert.equal(h.calls.badges.at(-1)?.text || '', '', 'Clear any previous error badge after launch');
  });
  await test('unsupported or restricted pages do not receive the bridge', async () => {
    for (const url of ['chrome://extensions', 'https://example.com', 'https://aistudio.google.com.evil.example/prompts', 'http://aistudio.google.com/prompts/test']) {
      const h = harness(); await h.click({ id: 42, url });
      assert.equal(h.calls.injection.length, 0, url);
      assert.ok(h.calls.badges.some(b => b.text), 'Show a visible status on an unsupported page');
      assert.ok(h.calls.titles.some(t => /AI Studio|aistudio/i.test(t.title)), 'Tell the user which site to open');
    }
  });
  await test('missing tab information is handled without injection or rejection', async () => {
    for (const tab of [{ id: 1 }, { url: 'https://aistudio.google.com/' }, {}]) {
      const h = harness(); await h.click(tab); assert.equal(h.calls.injection.length, 0);
    }
  });
  await test('Chrome injection failures produce an error badge instead of an uncaught rejection', async () => {
    const h = harness({ failInjection: true }); await h.click({ id: 43, url: 'https://aistudio.google.com/' });
    assert.equal(h.calls.injection.length, 1);
    assert.ok(h.calls.badges.some(b => b.text));
    assert.ok(h.calls.titles.some(t => /error|fail|reload|refresh|unable|could not/i.test(t.title)), 'Provide a useful failure tooltip');
  });
  console.log(`${passed.length}/${passed.length} extension package checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
