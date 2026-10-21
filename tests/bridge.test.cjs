// Regression checks use the real UI handlers with an in-memory DOM and filesystem.
// No user folders are opened or changed by these tests.
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');

class Element {
  constructor(tag = 'div', doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = [];
    this.nodeType = tag === '#text' ? 3 : 1;
    this.parentNode = null; this.attributes = {}; this.style = {};
    this.value = ''; this.disabled = false; this.checked = false; this._text = '';
    this.listeners = {};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'type') this.type = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  append(...children) { for (let child of children) { if (child == null) continue; if (typeof child === 'string') child = this.doc.createTextNode(child); child.parentNode = this; this.children.push(child); } }
  appendChild(c) { this.append(c); return c; }
  replaceChildren(...children) { this.children.forEach(c => c.parentNode = null); this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; this.removed = true; }
  attachShadow() { this.shadowRoot = new Element('shadow-root', this.doc); this.shadowRoot.host = this; return this.shadowRoot; }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  get parentElement() { return this.parentNode; }
  set innerHTML(value) {
    this.replaceChildren();
    // Support legacy template-based UI creation; final UI uses element APIs.
    for (const m of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) { const e = this.doc.createElement(m[1]); e.id = m[2]; this.append(e); }
  }
  getElementById(id) { return this.walk().find(e => e.id === id) || null; }
  walk() { return this.children.flatMap(c => [c, ...c.walk()]); }
  matches(selector) {
    selector = selector.trim();
    if (selector === 'pre code') return this.tagName === 'CODE' && this.parentNode?.tagName === 'PRE';
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === 'input[type="checkbox"]' || selector === 'input[type=checkbox]') return this.tagName === 'INPUT' && this.type === 'checkbox';
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) { const selectors = selector.split(','); return this.walk().filter(e => selectors.some(s => e.matches(s))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let e = this; while (e) { if (e.matches(selector)) return e; e = e.parentNode; } return null; }
  contains(other) { return other === this || this.walk().includes(other); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(event) { event.target ??= this; for (const f of this.listeners[event.type] || []) f(event); this['on' + event.type]?.(event); return true; }
  click() { this.doc.clicked.push(this); return this.onclick?.({ target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.doc.activeElement = this; }
  scrollIntoView() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 24, top: 24, width: 740, height: 600, right: 764, bottom: 624 }; }
}
function missing(path) { const e = new Error('Not found: ' + path); e.name = 'NotFoundError'; return e; }
class Directory {
  constructor(name, initial = {}, shared, prefix = '') {
    this.kind = 'directory'; this.name = name; this.prefix = prefix;
    this.shared = shared || { files: new Map(Object.entries(initial)), directories: new Set(['']), writeCount: new Map(), failures: null, beforeClose: null };
    for (const path of this.shared.files.keys()) {
      const parts = path.split('/'); while (parts.length > 1) { parts.pop(); this.shared.directories.add(parts.join('/') + '/'); }
    }
  }
  async requestPermission() { return 'granted'; }
  async queryPermission() { return 'granted'; }
  async isSameEntry(other) { return other.shared === this.shared && other.prefix === this.prefix; }
  async getDirectoryHandle(name, { create = false } = {}) {
    const prefix = this.prefix + name + '/';
    if (!this.shared.directories.has(prefix)) { if (!create) throw missing(prefix); this.shared.directories.add(prefix); }
    return new Directory(name, {}, this.shared, prefix);
  }
  async getFileHandle(name, { create = false } = {}) {
    const path = this.prefix + name, shared = this.shared;
    if (!shared.files.has(path)) { if (!create) throw missing(path); shared.files.set(path, ''); }
    return {
      kind: 'file', name,
      async getFile() { const contents = shared.files.get(path); if (contents == null) throw missing(path); return { size: Buffer.byteLength(contents), text: async () => contents, arrayBuffer: async () => new TextEncoder().encode(contents).buffer }; },
      async createWritable() {
        let contents = shared.files.get(path);
        return {
          async write(value) { contents = value; },
          async close() {
            const count = (shared.writeCount.get(path) || 0) + 1; shared.writeCount.set(path, count);
            await shared.beforeClose?.(path, count);
            if (shared.failures?.(path, count)) throw Error('Simulated write failure: ' + path);
            shared.files.set(path, contents);
          },
          async abort() {}
        };
      }
    };
  }
  async removeEntry(name) { const path = this.prefix + name; if (!this.shared.files.has(path)) throw missing(path); this.shared.files.delete(path); }
  async *entries() {
    const yielded = new Set();
    for (const path of this.shared.files.keys()) {
      if (!path.startsWith(this.prefix)) continue;
      const name = path.slice(this.prefix.length).split('/')[0]; if (yielded.has(name)) continue; yielded.add(name);
      yield [name, path.slice(this.prefix.length).includes('/') ? await this.getDirectoryHandle(name) : await this.getFileHandle(name)];
    }
  }
}
function harness() {
  const doc = { clicked: [], queries: [], activeElement: null, documentElement: { clientWidth: 1440 }, createElement(tag) { return new Element(tag, doc); }, createTextNode(t) { const e = new Element('#text', doc); e.textContent = t; return e; } };
  doc.body = new Element('body', doc); doc.getElementById = id => doc.body.getElementById(id);
  doc.querySelectorAll = selector => { doc.queries.push(selector); return doc.body.querySelectorAll(selector); };
  doc.querySelector = selector => doc.querySelectorAll(selector)[0] || null;
  doc.createRange = () => ({ node: null, selectNodeContents(node) { this.node = node; } });
  const blobs = [], clipboards = [], pickers = [];
  const window = { innerHeight: 900, addEventListener() {}, removeEventListener() {}, getSelection: () => ({ toString: () => '' }), showDirectoryPicker: async () => { if (!pickers.length) throw Error('No test picker result'); return pickers.shift(); } };
  const context = {
    document: doc, window, console, TextEncoder, TextDecoder, Blob, Map, Set, Date, JSON, AbortController,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    navigator: { clipboard: { async writeText(value) { clipboards.push(value); } } },
    confirm: () => true, alert() {}, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame(fn) { fn(); }, Event: class { constructor(type, attrs) { this.type = type; Object.assign(this, attrs); } }
  };
  vm.createContext(context);
  const instrumented = script.replace(/\}\)\(\);\s*$/, 'globalThis.__test = { parse };})();');
  vm.runInContext(instrumented, context);
  const root = doc.getElementById('argon-bridge').shadowRoot;
  const get = id => { const e = root.getElementById(id); assert.ok(e, 'Missing control #' + id); return e; };
  const click = async id => { await get(id).click(); };
  const status = () => get('status').textContent;
  const link = async dir => { pickers.push(dir); await click('link'); };
  const preview = async files => { get('source').value = JSON.stringify({ version: 1, files }); get('source').oninput?.(); await click('preview'); for (const box of get('changes').querySelectorAll('input')) if (!box.disabled) box.checked = true; };
  return { doc, root, context, blobs, clipboards, pickers, get, click, status, link, preview, parse: context.__test.parse, rerun() { vm.runInContext(script, context); } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('parser preserves hyphens/spaces and rejects duplicate, unsafe and ancestor paths', () => {
  const h = harness();
  assert.equal(h.parse('```js\n// FILE: src/my-file.js\nhello\n```')[0].path, 'src/my-file.js');
  assert.equal(h.parse('```html\n<!-- FILE: my page.html -->\nhello\n```')[0].path, 'my page.html');
  for (const path of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', '.git/config', 'CON.txt', 'a/../b', 'a.', '.env', 'secret.key']) {
    assert.throws(() => h.parse(JSON.stringify({ version: 1, files: [{ path, content: 'x' }] })), undefined, path);
  }
  assert.throws(() => h.parse(JSON.stringify({ version: 1, files: [{ path: 'a', content: '' }, { path: 'A', content: '' }] })));
  assert.throws(() => h.parse(JSON.stringify({ version: 1, files: [{ path: 'a', content: '' }, { path: 'a/b', content: '' }] })));
  assert.throws(() => h.parse(JSON.stringify({ version: 1, files: [{ path: 'a', content: '' }, { path: 'a-b', content: '' }, { path: 'a/b', content: '' }] })));
  assert.throws(() => h.parse('```js\n// FILE: x.js\nhello'));
});

test('parser preserves BOM and valid Unicode but rejects unpaired surrogates', () => {
  const h = harness();
  const manifest = content => JSON.stringify({ version: 1, files: [{ path: 'unicode.js', content }] });
  const valid = '\uFEFFconst message = "hello 🌍";\r\n';
  assert.equal(h.parse(manifest(valid))[0].content, valid);
  assert.throws(() => h.parse(manifest('\uD800')));
  assert.throws(() => h.parse(manifest('\uDFFF')));
});

test('file reads and undo preserve the UTF-8 BOM exactly', async () => {
  const h = harness(), before = '\uFEFForiginal\r\n', dir = new Directory('project', { 'bom.js': before });
  await h.link(dir); await h.preview([{ path: 'bom.js', content: '\uFEFFreplacement\r\n' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('bom.js'), '\uFEFFreplacement\r\n');
  await h.click('undo'); assert.equal(dir.shared.files.get('bom.js'), before);
  await h.click('export'); const backup = JSON.parse(await h.blobs.at(-1).text()); assert.equal(backup.batches[0].files[0].before, before);
});

test('rerunning preserves the existing panel and its state', async () => {
  const h = harness(), old = h.doc.getElementById('argon-bridge');
  h.get('source').value = 'keep me'; h.rerun();
  assert.ok(h.doc.getElementById('argon-bridge') === old, 'Rerun replaced the existing panel');
  assert.equal(h.get('source').value, 'keep me');
});

test('dragging keeps panel inside the viewport and ignores button presses', () => {
  const h = harness(), host = h.doc.getElementById('argon-bridge'), header = h.get('drag');
  header.onpointerdown({ button: 0, target: h.get('close'), pointerId: 1, clientX: 40, clientY: 40, preventDefault() {} });
  header.onpointermove({ pointerId: 1, clientX: 500, clientY: 400 }); assert.equal(host.style.left, undefined);
  header.onpointerdown({ button: 0, target: header, pointerId: 2, clientX: 40, clientY: 40, preventDefault() {} });
  header.onpointermove({ pointerId: 2, clientX: -10000, clientY: -10000 }); assert.equal(host.style.left, '8px'); assert.equal(host.style.top, '8px');
  header.onpointermove({ pointerId: 2, clientX: 10000, clientY: 10000 }); assert.equal(host.style.left, '692px'); assert.equal(host.style.top, '292px');
  header.onpointerup({ pointerId: 2 });
});

test('context sharing defaults to unchecked and never injects a page textarea', async () => {
  const h = harness(), dir = new Directory('project', { 'main.js': 'code', 'config.json': '{"password":"super-secret-thing"}', '.env': 'hidden' });
  const textarea = h.doc.createElement('textarea'); textarea.value = 'existing prompt'; h.doc.body.append(textarea);
  await h.link(dir); await h.click('scan');
  const checkboxes = h.get('files').querySelectorAll('input'); assert.equal(checkboxes.length, 2); assert.ok(checkboxes.every(x => !x.checked));
  checkboxes[0].checked = true; await h.click('copy'); assert.equal(h.clipboards.length, 1); assert.equal(textarea.value, 'existing prompt');
});

test('preview detects an external edit before applying', async () => {
  const h = harness(), dir = new Directory('project', { 'main.js': 'old' });
  await h.link(dir); await h.preview([{ path: 'main.js', content: 'replacement' }]);
  dir.shared.files.set('main.js', 'external'); await h.click('apply');
  assert.equal(dir.shared.files.get('main.js'), 'external'); assert.match(h.status(), /changed|conflict/i);
});

test('editing response after preview invalidates the pending apply', async () => {
  const h = harness(), dir = new Directory('project', { 'main.js': 'old' });
  await h.link(dir); await h.preview([{ path: 'main.js', content: 'replacement' }]);
  h.get('source').value = 'different answer'; h.get('source').oninput?.(); await h.click('apply');
  assert.equal(dir.shared.files.get('main.js'), 'old');
});

test('undo protects existing files edited after applying', async () => {
  const h = harness(), dir = new Directory('project', { 'main.js': 'old' });
  await h.link(dir); await h.preview([{ path: 'main.js', content: 'replacement' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('main.js'), 'replacement'); dir.shared.files.set('main.js', 'external');
  await h.click('undo'); assert.equal(dir.shared.files.get('main.js'), 'external'); assert.match(h.status(), /blocked|changed|conflict/i);
});

test('undo protects newly created files edited after applying', async () => {
  const h = harness(), dir = new Directory('project');
  await h.link(dir); await h.preview([{ path: 'new-file.js', content: 'replacement' }]); await h.click('apply');
  dir.shared.files.set('new-file.js', 'external'); await h.click('undo'); assert.equal(dir.shared.files.get('new-file.js'), 'external');
});

test('folder switching cannot redirect undo into the newly selected project', async () => {
  const h = harness(), first = new Directory('first', { 'main.js': 'first-original' }), second = new Directory('second', { 'main.js': 'second-original' });
  await h.link(first); await h.preview([{ path: 'main.js', content: 'first-applied' }]); await h.click('apply');
  await h.link(second); await h.click('undo');
  assert.equal(second.shared.files.get('main.js'), 'second-original'); assert.equal(first.shared.files.get('main.js'), 'first-original');
});

test('multiple apply batches retain every original and undo in reverse order', async () => {
  const h = harness(), dir = new Directory('project', { 'main.js': 'original' });
  await h.link(dir); await h.preview([{ path: 'main.js', content: 'first-change' }]); await h.click('apply');
  await h.preview([{ path: 'main.js', content: 'second-change' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('main.js'), 'second-change');
  await h.click('export'); const backup = JSON.parse(await h.blobs.at(-1).text());
  assert.equal(backup.batches.length, 2); assert.equal(backup.batches[0].files[0].before, 'original'); assert.equal(backup.batches[1].files[0].before, 'first-change');
  await h.click('undo'); assert.equal(dir.shared.files.get('main.js'), 'first-change');
  await h.click('undo'); assert.equal(dir.shared.files.get('main.js'), 'original');
});

test('page code import uses only fully selected blocks and preserves filenames', async () => {
  const h = harness();
  const oldPre = h.doc.createElement('pre'), oldCode = h.doc.createElement('code'); oldCode.textContent = '// FILE: old.js\nold answer'; oldPre.append(oldCode);
  const selectedPre = h.doc.createElement('pre'), selectedCode = h.doc.createElement('code'); selectedCode.textContent = '// FILE: src/my new-file.js\nselected answer'; selectedPre.append(selectedCode);
  h.doc.body.append(oldPre, selectedPre);
  h.context.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, toString: () => selectedCode.textContent, getRangeAt: () => ({ commonAncestorContainer: h.doc.body, compareBoundaryPoints: (type, contents) => contents.node === selectedPre ? (type === 0 ? -1 : 1) : 1 }) });
  await h.click('grab');
  const files = h.parse(h.get('source').value); assert.equal(files.length, 1); assert.equal(files[0].path, 'src/my new-file.js'); assert.match(files[0].content, /selected answer/);
});

test('page code import refuses an empty selection', async () => {
  const h = harness();
  const pre = h.doc.createElement('pre'), code = h.doc.createElement('code'); code.textContent = '// FILE: old.js\nold answer'; pre.append(code); h.doc.body.append(pre);
  h.context.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '', containsNode: () => false });
  await h.click('grab'); assert.equal(h.get('source').value, ''); assert.match(h.status(), /select/i);
});

test('page code import refuses a partial rendered code selection', async () => {
  const h = harness(), pre = h.doc.createElement('pre'), code = h.doc.createElement('code');
  code.textContent = '// FILE: partial.js\nfirst line\nlast line'; pre.append(code); h.doc.body.append(pre);
  h.context.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, toString: () => '// FILE: partial.js\nfirst', getRangeAt: () => ({ commonAncestorContainer: h.doc.body, compareBoundaryPoints: type => type === 0 ? -1 : -1 }) });
  await h.click('grab'); assert.equal(h.get('source').value, ''); assert.match(h.status(), /FILE|manifest|select/i);
});

test('failed batch attempts rollback and retains recovery originals', async () => {
  const h = harness(), dir = new Directory('project', { 'a.js': 'a-before', 'b.js': 'b-before' });
  dir.shared.failures = (path, count) => path === 'b.js' && count === 1;
  await h.link(dir); await h.preview([{ path: 'a.js', content: 'a-after' }, { path: 'b.js', content: 'b-after' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('a.js'), 'a-before'); assert.equal(dir.shared.files.get('b.js'), 'b-before');
  await h.click('export'); assert.ok(h.blobs.length); const backup = JSON.parse(await h.blobs.at(-1).text());
  const serial = JSON.stringify(backup); assert.ok(serial.includes('a-before')); assert.ok(serial.includes('b-before'));
});

test('rollback failure is reported and recovery data remains available', async () => {
  const h = harness(), dir = new Directory('project', { 'a.js': 'a-before', 'b.js': 'b-before' });
  dir.shared.failures = (path, count) => path === 'b.js' || (path === 'a.js' && count > 1);
  await h.link(dir); await h.preview([{ path: 'a.js', content: 'a-after' }, { path: 'b.js', content: 'b-after' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('a.js'), 'a-after'); assert.match(h.status(), /recovery|failed|could not/i);
  assert.doesNotMatch(h.status(), /(?:all |original )?contents restored|failed & rolled back/i);
  await h.click('export'); const serial = await h.blobs.at(-1).text(); assert.ok(serial.includes('a-before')); assert.ok(serial.includes('b-before'));
});

test('rollback preserves external edits made while another write failed', async () => {
  const h = harness(), dir = new Directory('project', { 'a.js': 'a-before', 'b.js': 'b-before' });
  dir.shared.beforeClose = (path, count) => { if (path === 'b.js' && count === 1) dir.shared.files.set('a.js', 'external-edit-during-apply'); };
  dir.shared.failures = (path, count) => path === 'b.js' && count === 1;
  await h.link(dir); await h.preview([{ path: 'a.js', content: 'a-after' }, { path: 'b.js', content: 'b-after' }]); await h.click('apply');
  assert.equal(dir.shared.files.get('a.js'), 'external-edit-during-apply'); assert.match(h.status(), /recovery|changed|differs|conflict/i);
  await h.click('export'); assert.ok((await h.blobs.at(-1).text()).includes('a-before'));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + String(error.stack).slice(0, 1600)); }
  }
  console.log(`${tests.length - failed}/${tests.length} safety checks passed.`); if (failed) process.exitCode = 1;
})();
