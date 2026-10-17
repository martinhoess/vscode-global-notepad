// Part 1 runs the webview script from src/extension.ts against a stub textarea.
// Guards the sync path: an external update must not steal focus and must not
// bounce back as a save — including when the incoming text carries CRLF, which
// a real textarea silently normalises to LF.
// Part 2 loads the compiled out/extension.js against a stub `vscode` module and
// checks the host side: conflict detection, read errors and write errors.
//
//   npm run compile && node test/webview-sync.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
const script = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/)[1];

function makeTextarea() {
  const listeners = {};
  let value = '';
  return {
    get value() { return value; },
    // A textarea normalises CRLF to LF on assignment — the whole point of the test.
    set value(text) { value = String(text).replace(/\r\n/g, '\n'); },
    selectionStart: 0,
    selectionEnd: 0,
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    dispatch(type) { (listeners[type] || []).forEach((handler) => handler()); },
    select() {},
    setSelectionRange() {},
    focus() { sandbox.document.activeElement = this; },
    blur() {
      sandbox.document.activeElement = null;
      this.dispatch('blur');
    }
  };
}

const note = makeTextarea();
const status = makeTextarea();
const posted = [];
const windowListeners = [];

const sandbox = {
  setTimeout,
  clearTimeout,
  acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
  document: {
    activeElement: null,
    getElementById: (id) => (id === 'note' ? note : status),
    execCommand(command, _ui, text) {
      note.value = command === 'delete' ? '' : text;
      return true;
    }
  },
  window: { addEventListener: (_type, handler) => windowListeners.push(handler) }
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

const send = (message) => windowListeners.forEach((handler) => handler({ data: message }));
// Objects come from the vm context, so compare fields — not prototypes.
const savedTexts = () => posted.filter((message) => message.type === 'save').map((m) => m.text);

assert.strictEqual(posted.length, 1);
assert.strictEqual(posted[0].type, 'ready', 'webview announces itself on load');

send({ type: 'load', text: '' });

// Unfocused external update with CRLF: applied, no focus grab, no echo back.
send({ type: 'external', text: 'a\r\nb' });
assert.strictEqual(note.value, 'a\nb');
assert.strictEqual(sandbox.document.activeElement, null, 'external update must not steal focus');
assert.deepStrictEqual(savedTexts(), [], 'external update must not bounce back as a save');

// The field must count as clean afterwards, or every later blur re-saves it.
note.dispatch('blur');
assert.deepStrictEqual(savedTexts(), [], 'CRLF text must still leave the field clean');

// Focused, unchanged content: still nothing to save.
note.focus();
send({ type: 'external', text: 'a\nb' });
note.dispatch('blur');
assert.deepStrictEqual(savedTexts(), [], 'identical external update is a no-op');

// A real edit still saves.
note.focus();
note.value = 'typed';
note.dispatch('blur');
assert.deepStrictEqual(savedTexts(), ['typed'], 'local edit saves on blur');
assert.strictEqual(posted[posted.length - 1].base, 'a\nb', 'save carries the base it was edited from');
send({ type: 'saved' });

// An external update deferred mid-edit must not resurface after our own save.
note.focus();
note.value = 'mine';
send({ type: 'external', text: 'theirs' });
assert.strictEqual(note.value, 'mine', 'external update is deferred while dirty');
note.dispatch('blur'); // saves 'mine'
note.focus();
note.dispatch('blur'); // clean blur used to apply the stale pending text
assert.strictEqual(note.value, 'mine', 'deferred update must not apply while our save is unanswered');
send({ type: 'saved' });
note.focus();
note.dispatch('blur');
assert.strictEqual(note.value, 'mine', 'stale deferred update must not overwrite our save');
assert.deepStrictEqual(savedTexts(), ['typed', 'mine']);

// A failed save leaves the field dirty, so the next blur retries.
send({ type: 'error', base: 'typed' });
note.dispatch('blur');
assert.deepStrictEqual(savedTexts(), ['typed', 'mine', 'mine'], 'error makes the field dirty again');

console.log('ok — webview sync');

// ---- Part 2: extension host ------------------------------------------------
const Module = require('module');

class FileSystemError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const files = new Map();
const shown = [];
const watchHandlers = [];
let provider;
let readError = null;
let writeError = null;
let statError = null;

const vscodeStub = {
  FileSystemError,
  RelativePattern: class {},
  ViewColumn: { Beside: -2 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidChange: (handler) => watchHandlers.push(handler),
      onDidCreate: (handler) => watchHandlers.push(handler),
      dispose() {}
    }),
    fs: {
      async stat(uri) {
        if (statError) throw statError;
        if (!files.has(uri.path)) throw new FileSystemError('FileNotFound');
      },
      async readFile(uri) {
        if (readError) throw readError;
        if (!files.has(uri.path)) throw new FileSystemError('FileNotFound');
        return files.get(uri.path);
      },
      async writeFile(uri, data) {
        if (writeError) throw writeError;
        files.set(uri.path, Buffer.from(data));
      },
      async createDirectory() {}
    }
  },
  window: {
    registerWebviewViewProvider: (_id, p) => { provider = p; return { dispose() {} }; },
    showErrorMessage: (m) => { shown.push(m); return Promise.resolve(); },
    showWarningMessage: (m) => { shown.push(m); return Promise.resolve(); }
  },
  commands: { registerCommand: () => ({ dispose() {} }) }
};

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const extension = require(path.join(__dirname, '..', 'out', 'extension.js'));

const NOTES = '/storage/notes.txt';
const disk = () => files.get(NOTES).toString('utf8');

function makeView() {
  const out = [];
  let onMessage;
  const webview = {
    options: {},
    html: '',
    postMessage: (message) => { out.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler) => { onMessage = handler; }
  };
  provider.resolveWebviewView({ webview, onDidDispose() {} });
  return { out, receive: (message) => onMessage(message) };
}

(async () => {
  await extension.activate({
    globalStorageUri: { path: '/storage' },
    extensionUri: { path: '/ext' },
    subscriptions: []
  });
  assert.strictEqual(disk(), '', 'activation creates an empty notes file');

  const view = makeView();
  const other = makeView();
  await view.receive({ type: 'ready' });
  assert.deepStrictEqual(view.out.pop(), { type: 'load', text: '' });

  await view.receive({ type: 'save', text: 'a', base: '' });
  assert.strictEqual(disk(), 'a');
  assert.deepStrictEqual(view.out.pop(), { type: 'saved' });
  assert.deepStrictEqual(other.out.pop(), { type: 'external', text: 'a' }, 'other surfaces get the save');

  // Another window wrote in between: report, keep the other change on disk.
  files.set(NOTES, Buffer.from('theirs'));
  await view.receive({ type: 'save', text: 'mine', base: 'a' });
  assert.strictEqual(disk(), 'theirs', 'conflicting save must not overwrite');
  assert.deepStrictEqual(view.out.pop(), { type: 'error', base: 'theirs' });
  const conflictFiles = () => [...files.keys()].filter((k) => /\/notes\.conflict-[\dTZ-]+\.txt$/.test(k));
  assert.strictEqual(conflictFiles().length, 1, 'other version is kept in a conflict file');
  const kept = conflictFiles()[0];
  assert.ok(shown.pop().includes(kept.split('/').pop()), 'warning names the conflict file');

  // The next edit, based on the disk version, goes through — the other version stays safe.
  await view.receive({ type: 'save', text: 'mine', base: 'theirs' });
  assert.strictEqual(disk(), 'mine');
  assert.strictEqual(files.get(kept).toString('utf8'), 'theirs', 'conflict file still holds the other version');

  // CRLF on disk vs LF base from the textarea is not a conflict.
  files.set(NOTES, Buffer.from('x\r\ny'));
  await view.receive({ type: 'save', text: 'x\ny\nz', base: 'x\ny' });
  assert.strictEqual(disk(), 'x\ny\nz', 'line endings alone are no conflict');

  // Write failure: error shown, view told, disk and echo state untouched.
  writeError = new Error('EACCES: permission denied');
  view.out.length = 0;
  await view.receive({ type: 'save', text: 'lost?', base: 'x\ny\nz' });
  writeError = null;
  assert.strictEqual(disk(), 'x\ny\nz');
  assert.deepStrictEqual(view.out, [{ type: 'error', base: 'x\ny\nz' }], 'failed write reports, never "saved"');
  assert.match(shown.pop(), /could not save notes — EACCES/);
  assert.strictEqual(provider.currentText, 'x\ny\nz', 'failed write must not count as on disk');

  // A save queued behind the failed one still carries the failed text as base;
  // the disk matches what this view last wrote, so that is no conflict.
  await view.receive({ type: 'save', text: 'lost? no', base: 'lost?' });
  assert.strictEqual(disk(), 'lost? no', 'save after a failed write is not a false conflict');
  assert.strictEqual(conflictFiles().length, 1, 'no extra conflict file');
  assert.strictEqual(shown.length, 0, 'no warning');

  // Read failure other than FileNotFound: no 'load', no empty broadcast.
  readError = new FileSystemError('NoPermissions');
  const late = makeView();
  await late.receive({ type: 'ready' });
  assert.deepStrictEqual(late.out, [], 'unreadable notes must not load as empty');
  assert.match(shown.pop(), /could not read notes/);
  other.out.length = 0;
  for (const handler of watchHandlers) await handler();
  assert.deepStrictEqual(other.out, [], 'watcher sends nothing when the file is unreadable');
  readError = null;

  // A missing file still means "no notes yet".
  files.delete(NOTES);
  await late.receive({ type: 'ready' });
  assert.deepStrictEqual(late.out.pop(), { type: 'load', text: '' });

  // ensureNotesFile only creates a missing file; other errors are reported.
  files.set(NOTES, Buffer.from('keep me'));
  statError = new FileSystemError('Unavailable');
  await provider.ensureNotesFile();
  statError = null;
  assert.strictEqual(disk(), 'keep me', 'stat error must not blank the notes');
  assert.match(shown.pop(), /could not access notes/);

  console.log('ok — extension host');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
