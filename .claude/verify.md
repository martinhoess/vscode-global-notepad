# Verify — vscode-global-notepad

VS Code extension, TypeScript, no runtime dependencies. Nothing is deployed:
the artifact is a `.vsix` that gets installed into code-server on LXC 102.

## Commands

```bash
npm run compile              # tsc -p ./ — must exit 0, writes out/extension.js
node test/webview-sync.test.js   # webview sync regression, prints "ok — webview sync"
```

Both must pass before packaging. There is no watch/lint step and no test runner.

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
leaves the field clean even when the incoming text carries CRLF.
