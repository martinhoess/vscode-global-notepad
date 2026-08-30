// Runs the webview script from src/extension.ts against a stub textarea.
// Guards the sync path: an external update must not steal focus and must not
// bounce back as a save — including when the incoming text carries CRLF, which
// a real textarea silently normalises to LF.
//
//   node test/webview-sync.test.js

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

console.log('ok — webview sync');
