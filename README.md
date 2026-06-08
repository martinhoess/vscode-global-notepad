# Global Notepad

A dead-simple notepad that lives in the VSCode sidebar. The notes are stored
**globally** — the same text shows up in every window, folder, and workspace.

<img height="400" alt="image" src="https://github.com/user-attachments/assets/8755513f-124b-4901-9dea-1df8260c2411" />

## Features

- Sidebar panel (own icon in the Activity Bar) with a full-height text area.
- Auto-saves while you type (debounced) and immediately when the panel loses focus.
- Notes are stored in the extension's **global storage** directory, so they are
  shared across all workspaces and never end up in a project folder.
- Two commands (Command Palette):
  - `Global Notepad: Open Notes File in Editor`
  - `Global Notepad: Reveal Notes File on Disk`

## Where are the notes stored?

In a `notes.txt` inside VSCode's per-extension global storage:

| OS      | Path |
|---------|------|
| Windows | `%APPDATA%\Code\User\globalStorage\martinhoess.global-notepad\notes.txt` |
| macOS   | `~/Library/Application Support/Code/User/globalStorage/martinhoess.global-notepad/notes.txt` |
| Linux   | `~/.config/Code/User/globalStorage/martinhoess.global-notepad/notes.txt` |

(For VSCode Insiders / VSCodium the `Code` folder name differs accordingly.)

## Develop / run locally

```bash
npm install
npm run compile     # or: npm run watch
```

Then press `F5` in VSCode to launch an Extension Development Host with the
extension loaded. Look for the notepad icon in the Activity Bar.

## Package as a .vsix (optional)

```bash
npm install -g @vscode/vsce
vsce package
```

Install the resulting `.vsix` with **Extensions: Install from VSIX…** in the
Command Palette.

## License

MIT
