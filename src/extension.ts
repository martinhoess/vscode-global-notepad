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
  /** Saves run one after another so a conflict check never races our own write. */
  private saveQueue: Promise<void> = Promise.resolve();
  /**
   * Last text each surface wrote successfully. Also accepted as "unchanged
   * disk" so a save queued behind a failed write isn't flagged as a conflict.
   * Not `currentText`: that follows foreign writes via the watcher too.
   */
  private readonly lastWritten = new WeakMap<vscode.Webview, string>();

  public readonly notesFile: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.notesFile = vscode.Uri.joinPath(context.globalStorageUri, 'notes.txt');
  }

  /** Watch the global notes file so edits from another VSCode window show up live. */
  public startWatching(): void {
    const pattern = new vscode.RelativePattern(this.context.globalStorageUri, 'notes.txt');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onChange = async () => {
      let text: string;
      try {
        text = await this.read();
      } catch {
        return; // unreadable right now — keep what the views show, never push ''
      }
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
          try {
            this.currentText = await this.read();
          } catch (err) {
            // Without 'load' the view never becomes ready, so it can't save an
            // empty field over notes we merely failed to read.
            vscode.window.showErrorMessage(`Global Notepad: could not read notes — ${reason(err)}`);
            break;
          }
          webview.postMessage({ type: 'load', text: this.currentText });
          break;
        case 'save':
          this.saveQueue = this.saveQueue.then(() => this.save(webview, message));
          await this.saveQueue;
          break;
      }
    });
  }

  /**
   * Write one surface's text. `base` is the content that surface last knew to
   * be on disk; if the disk has moved on since, someone else wrote in between.
   * Then their version is kept in a conflict file next to the notes and the
   * view is told, instead of silently overwriting their change.
   */
  private async save(webview: vscode.Webview, message: { text?: unknown; base?: unknown }): Promise<void> {
    const text = typeof message.text === 'string' ? message.text : '';
    const base = typeof message.base === 'string' ? message.base : '';
    const previous = this.currentText;
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      // Check right before writeFile: this read is the last await in between.
      // ponytail: another window's host can still write in that gap; the fs API
      // has no compare-and-swap, a lock file would be the upgrade path.
      const raw = await this.read();
      const disk = sameText(raw);
      const known = [base, text, this.lastWritten.get(webview)];
      if (!known.some((k) => k !== undefined && sameText(k) === disk)) {
        const kept = await this.keepConflict(raw);
        // The view falls back to the disk version as its base, so the user's
        // next save overwrites notes.txt — the other version is safe in `kept`.
        webview.postMessage({ type: 'error', base: disk });
        vscode.window.showWarningMessage(
          `Global Notepad: the notes were changed elsewhere since your last save. ` +
            `That version was kept as ${kept}; your text is saved over it with your next edit.`
        );
        return;
      }
      // Record before writing so the watcher echo is recognised and skipped.
      this.currentText = text;
      await vscode.workspace.fs.writeFile(this.notesFile, Buffer.from(text, 'utf8'));
      this.lastWritten.set(webview, text);
    } catch (err) {
      this.currentText = previous;
      webview.postMessage({ type: 'error', base });
      vscode.window.showErrorMessage(`Global Notepad: could not save notes — ${reason(err)}`);
      return;
    }
    webview.postMessage({ type: 'saved' });
    // The watcher ignores our own write, so mirror the change to any other
    // notepad surfaces open in this same window directly.
    this.broadcast({ type: 'external', text }, webview);
  }

  /**
   * Post a message to every live notepad surface, optionally skipping one.
   * Disposed surfaces are removed by their own onDidDispose handler, so the set
   * only ever holds live webviews here.
   */
  private broadcast(message: unknown, except?: vscode.Webview): void {
    for (const webview of this.webviews) {
      if (webview !== except) webview.postMessage(message);
    }
  }

  /** Store a version that lost a conflict next to the notes; returns its file name. */
  private async keepConflict(text: string): Promise<string> {
    const name = `notes.conflict-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, name);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    return name;
  }

  public async ensureNotesFile(): Promise<void> {
    try {
      await vscode.workspace.fs.stat(this.notesFile);
    } catch (err) {
      // Only create the file when it is really missing — never blank it over
      // an error that merely hides existing notes.
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        await this.write('');
      } else {
        vscode.window.showErrorMessage(`Global Notepad: could not access notes — ${reason(err)}`);
      }
    }
  }

  private async read(): Promise<string> {
    try {
      const data = await vscode.workspace.fs.readFile(this.notesFile);
      return Buffer.from(data).toString('utf8');
    } catch (err) {
      // Only a missing file means "no notes yet"; anything else (permissions,
      // I/O) must not masquerade as empty text that a save would then persist.
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return '';
      throw err;
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
    // Saves sent to the host and not yet answered with 'saved' / 'error'.
    let inFlight = 0;

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
      vscode.postMessage({ type: 'save', text: note.value, base: baseline });
      baseline = note.value;
      inFlight++;
    }

    function scheduleSave() {
      if (!ready) return;
      showStatus('Saving…');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 400);
    }

    function applyExternal(text) {
      replaceAllText(text);
      // Read the baseline back off the field instead of trusting the incoming
      // text: a textarea normalises CRLF to LF, so a file written with CRLF
      // would otherwise never match and leave the field permanently "dirty".
      baseline = note.value;
      pendingExternal = null;
      showStatus('Updated');
    }

    // Replace the whole textarea content. While the field has focus the change
    // goes through execCommand so the native undo stack survives — assigning
    // textarea.value directly wipes the browser undo history and makes Ctrl+Z
    // behave erratically after a cross-window sync. Without focus we assign
    // directly: focusing just to keep an undo entry would pull the caret out of
    // whatever the user is actually typing in, and the resulting blur would run
    // the blur handler mid-update against a stale baseline.
    function replaceAllText(text) {
      if (note.value === text) return;

      applying = true;
      if (document.activeElement === note) {
        const selStart = note.selectionStart;
        const selEnd = note.selectionEnd;
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

        const start = Math.min(selStart, note.value.length);
        const end = Math.min(selEnd, note.value.length);
        try { note.setSelectionRange(start, end); } catch (e) { /* ignore */ }
      } else {
        note.value = text;
      }
      applying = false;
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
      } else if (pendingExternal !== null && inFlight === 0) {
        // While a save is unanswered the deferred text is about to be
        // superseded ('saved') or kept in a conflict file ('error').
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
        inFlight = Math.max(0, inFlight - 1);
        // Our text is on disk now; the deferred one would only clobber it.
        pendingExternal = null;
        showStatus('Saved');
      } else if (message.type === 'error') {
        inFlight = Math.max(0, inFlight - 1);
        // Save failed or hit a conflict: fall back to what is on disk, so the
        // field counts as dirty again and the next blur / edit retries.
        baseline = message.base || '';
        showStatus('Not saved');
      } else if (message.type === 'external') {
        const text = message.text || '';
        if (note.value === text) {
          baseline = text;
          return;
        }
        // Never overwrite unsaved text (mid-edit, or left over from a failed
        // save); defer until it is saved or the user clicks away clean.
        if (isDirty()) {
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

/** A textarea normalises CR and CRLF to LF, so compare text the same way. */
function sameText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
