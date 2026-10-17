# Verify — vscode-global-notepad

VS Code extension, TypeScript, no runtime dependencies. Nothing is deployed:
the artifact is a `.vsix` that gets installed into code-server.

## Commands

```bash
npm run compile              # tsc -p ./ — must exit 0, writes out/extension.js
node test/webview-sync.test.js   # prints "ok — webview sync" and "ok — extension host"
```

Both must pass before packaging, in this order: the test loads `out/extension.js`. There is no watch/lint step and no test runner.

## Packaging and install

```bash
npx @vscode/vsce package                     # builds global-notepad-<version>.vsix
code-server --install-extension global-notepad-<version>.vsix
```

The install replaces the copy under
`~/.local/share/code-server/extensions/martinhoess.global-notepad-<version>/` and
needs a window reload in the browser to take effect. Bump `version` in
`package.json` first — code-server keeps the old directory otherwise.

## What the test covers

`test/webview-sync.test.js` extracts the inline webview script out of
`src/extension.ts` and runs it against a stub textarea. It asserts that an
external note update does not steal focus, does not echo back as a save, and
leaves the field clean even when the incoming text carries CRLF, that a
deferred external update can't overwrite the user's own save, and that a
failed save leaves the field dirty. A second part loads the compiled
`out/extension.js` against a stub `vscode` module and checks the host side:
a save over a newer disk version is reported as a conflict and the other
version is kept in `notes.conflict-<time>.txt` before the next edit overwrites
it, a save after a failed write is no false conflict, write errors are reported
to the user and the view, and a read or stat error other than "file not found"
never loads, broadcasts or writes empty notes.
