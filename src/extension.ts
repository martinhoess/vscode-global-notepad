import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const provider = new NotepadViewProvider(context);

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
}

export function deactivate() {}

class NotepadViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'globalNotepad.view';

  private view?: vscode.WebviewView;
  public readonly notesFile: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.notesFile = vscode.Uri.joinPath(context.globalStorageUri, 'notes.txt');
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'ready':
          webviewView.webview.postMessage({ type: 'load', text: await this.read() });
          break;
        case 'save':
          await this.write(typeof message.text === 'string' ? message.text : '');
          webviewView.webview.postMessage({ type: 'saved' });
          break;
      }
    });
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

    function showStatus(text) {
      status.textContent = text;
      status.classList.add('show');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status.classList.remove('show'), 1200);
    }

    function save() {
      vscode.postMessage({ type: 'save', text: note.value });
    }

    function scheduleSave() {
      if (!ready) return;
      showStatus('Saving…');
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 400);
    }

    note.addEventListener('input', scheduleSave);

    // Flush immediately on blur so notes are never lost when the view hides.
    note.addEventListener('blur', () => {
      if (!ready) return;
      if (saveTimer) clearTimeout(saveTimer);
      save();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'load') {
        note.value = message.text || '';
        ready = true;
      } else if (message.type === 'saved') {
        showStatus('Saved');
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
