import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
  const provider = new NotepadViewProvider(context);

  // Make sure the global storage dir + file exist so the file watcher has a
  // concrete target before any note is written.
  await provider.ensureNotesFile();
  provider.startWatching();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NotepadViewProvider.viewType, provider, {
      // Keep the textarea content alive when the view is hidden so the
      // caret position and unsaved keystrokes survive tab switches.
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('globalNotepad.openNotesFile', async () => {
      await provider.ensureNotesFile();
      const doc = await vscode.workspace.openTextDocument(provider.notesFile);
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('globalNotepad.revealNotesFile', async () => {
      await provider.ensureNotesFile();
      await vscode.commands.executeCommand('revealFileInOS', provider.notesFile);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('globalNotepad.openInEditor', () => provider.openInEditor())
  );
}

export function deactivate() {}

class NotepadViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'globalNotepad.view';

  /** Every live notepad surface — the sidebar view plus any editor-area panel. */
  private readonly webviews = new Set<vscode.Webview>();
  /** The editor-area panel, if one is currently open. */
  private panel?: vscode.WebviewPanel;
  private watcher?: vscode.FileSystemWatcher;

  /** Last content we know is on disk — used to ignore our own write echoes. */
  private currentText = '';

  public readonly notesFile: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.notesFile = vscode.Uri.joinPath(context.globalStorageUri, 'notes.txt');
  }

  /** Watch the global notes file so edits from another VSCode window show up live. */
  public startWatching(): void {
    const pattern = new vscode.RelativePattern(this.context.globalStorageUri, 'notes.txt');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onChange = async () => {
      const text = await this.read();
      // Same content we already hold (typically our own write echoing back) — ignore.
      if (text === this.currentText) return;
      this.currentText = text;
      this.broadcast({ type: 'external', text });
    };

    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.context.subscriptions.push(this.watcher);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    this.wire(webview);
    webviewView.onDidDispose(() => this.webviews.delete(webview));
  }

  /**
   * Open (or focus) the notepad as an editor tab beside the active editor.
   * Unlike the sidebar view it doesn't vanish when another activity-bar icon is
   * selected, and it can be pinned / split for a permanent on-screen spot.
   */
  public async openInEditor(): Promise<void> {
    await this.ensureNotesFile();

    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'globalNotepad.editor',
      'Notepad',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // Keep the textarea alive across tab switches, same as the sidebar view.
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'notepad.svg');
    // Cache the webview now: once the panel is disposed, the `panel.webview`
    // getter itself throws, so we must not read it from the dispose handler.
    const webview = panel.webview;
    this.panel = panel;

    this.wire(webview);
    panel.onDidDispose(() => {
      // Null the panel first; if anything below threw we'd otherwise keep a
      // stale, disposed panel and the next openInEditor() would reveal() it.
      this.panel = undefined;
      this.webviews.delete(webview);
    });
  }

  /** Attach our HTML + message protocol to a webview and register it for sync. */
  private wire(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webview.html = this.getHtml(webview);
    this.webviews.add(webview);

    webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready':
          this.currentText = await this.read();
          webview.postMessage({ type: 'load', text: this.currentText });
          break;
        case 'save': {
          const text = typeof message.text === 'string' ? message.text : '';
          // Record before writing so the watcher echo is recognised and skipped.
          this.currentText = text;
          await this.write(text);
          webview.postMessage({ type: 'saved' });
          // The watcher ignores our own write, so mirror the change to any other
          // notepad surfaces open in this same window directly.
          this.broadcast({ type: 'external', text }, webview);
          break;
        }
      }
    });
  }

  /** Post a message to every live notepad surface, optionally skipping one. */
  private broadcast(message: unknown, except?: vscode.Webview): void {
    for (const webview of this.webviews) {
      if (webview === except) continue;
      try {
        webview.postMessage(message);
      } catch {
        // Disposed between registration and now — drop it from the set.
        this.webviews.delete(webview);
      }
    }
  }

  public async ensureNotesFile(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(this.notesFile);
    } catch {
      await this.write('');
    }
  }

  private async read(): Promise<string> {
    try {
      const data = await vscode.workspace.fs.readFile(this.notesFile);
      return Buffer.from(data).toString('utf8');
    } catch {
      return '';
    }
  }

  private async write(text: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.notesFile, Buffer.from(text, 'utf8'));
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    body {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    #note {
      flex: 1 1 auto;
      width: 100%;
      box-sizing: border-box;
      resize: none;
      border: none;
      outline: none;
      padding: 8px;
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
      tab-size: 4;
    }
    #note::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    #status {
      flex: 0 0 auto;
      padding: 2px 8px;
      font-size: 11px;
      text-align: right;
      color: var(--vscode-descriptionForeground);
      opacity: 0;
      transition: opacity 0.15s ease;
      user-select: none;
    }
    #status.show {
      opacity: 1;
    }
  </style>
</head>
<body>
  <textarea id="note" spellcheck="false" placeholder="Global notes — shared across every workspace…"></textarea>
  <div id="status">Saved</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const note = document.getElementById('note');
    const status = document.getElementById('status');

    let saveTimer = null;
    let statusTimer = null;
    let ready = false;
    // True while we replace the text programmatically, so the resulting
    // 'input' event doesn't trigger a redundant save / re-broadcast.
    let applying = false;

    // Content currently believed to be in sync with disk. note.value differing
    // from this means the user has unsaved local edits ("dirty").
    let baseline = '';
    // An external change received while the user was actively editing here;
    // applied once they click away so we never clobber live keystrokes.
    let pendingExternal = null;

    function isDirty() {
      return note.value !== baseline;
    }

    function showStatus(text) {
      status.textContent = text;
      status.classList.add('show');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status.classList.remove('show'), 1200);
    }

    function save() {
      baseline = note.value;
      vscode.postMessage({ type: 'save', text: baseline });
    }

    function scheduleSave() {
      if (!ready) return;
      showStatus('Saving…');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 400);
    }

    function applyExternal(text) {
      replaceAllText(text);
      baseline = text;
      pendingExternal = null;
      showStatus('Updated');
    }

    // Replace the whole textarea content while keeping the native undo stack
    // intact. Assigning textarea.value directly wipes the browser undo history,
    // which makes Ctrl+Z behave erratically after a cross-window sync. Routing
    // the change through execCommand keeps it as a normal, undoable edit.
    function replaceAllText(text) {
      if (note.value === text) return;

      const wasFocused = document.activeElement === note;
      const selStart = note.selectionStart;
      const selEnd = note.selectionEnd;

      applying = true;
      note.focus();
      note.select();

      let ok = false;
      try {
        ok = text === ''
          ? document.execCommand('delete', false)
          : document.execCommand('insertText', false, text);
      } catch (e) {
        ok = false;
      }
      if (!ok || note.value !== text) {
        // Fallback: loses undo history, but only on platforms without execCommand.
        note.value = text;
      }
      applying = false;

      if (!wasFocused) {
        note.blur();
      } else {
        const start = Math.min(selStart, text.length);
        const end = Math.min(selEnd, text.length);
        try { note.setSelectionRange(start, end); } catch (e) { /* ignore */ }
      }
    }

    note.addEventListener('input', () => {
      if (applying) return;
      scheduleSave();
    });

    note.addEventListener('blur', () => {
      if (!ready) return;
      if (saveTimer) clearTimeout(saveTimer);
      if (isDirty()) {
        save();
      } else if (pendingExternal !== null) {
        applyExternal(pendingExternal);
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'load') {
        note.value = message.text || '';
        baseline = note.value;
        ready = true;
      } else if (message.type === 'saved') {
        showStatus('Saved');
      } else if (message.type === 'external') {
        const text = message.text || '';
        if (note.value === text) {
          baseline = text;
          return;
        }
        // Don't overwrite the user mid-edit; defer until they click away.
        if (document.activeElement === note && isDirty()) {
          pendingExternal = text;
          showStatus('Updated elsewhere');
        } else {
          applyExternal(text);
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
