# Copilot Sessions Keeper

A VS Code extension that automatically backs up GitHub Copilot chat sessions to local files — JSON for full fidelity, Markdown for human reading.

## Why

VS Code keeps only the last ~40 conversation turns per workspace in memory. Older exchanges are silently pruned. This extension captures sessions before they're lost and organizes them into date folders.

## Features

- **Daily auto-backup** — On the first VS Code launch each day, all chat sessions are exported
- **Manual backup** — Run `Copilot Sessions Keeper: Backup Now` from the Command Palette at any time
- **Dual format** — Each session is saved as both `.json` (full data) and `.md` (readable)
- **Idempotent** — Already-exported sessions are skipped; re-running is safe
- **Schema change detection** — Alerts you when VS Code updates change the chat storage format, so the parser can be updated before data is lost
- **Both session types** — Captures workspace-scoped sessions and empty-window (global) sessions

## Output Structure

```
~/copilot-sessions-keeper/
├── 2026-04-10/
│   ├── github-actions-pipeline-rewrite.json
│   ├── github-actions-pipeline-rewrite.md
│   ├── debugging-typescript-imports.json
│   └── debugging-typescript-imports.md
├── 2026-04-13/
│   ├── accessing-lm-sessions-in-vscode.json
│   └── accessing-lm-sessions-in-vscode.md
├── schema-change-2026-04-14.txt          ← only if format changed
└── ...
```

Folder naming: `YYYY-MM-DD/` (one folder per date, multiple sessions per folder)
File naming: `{topic-slug}.json`, `{topic-slug}.md`

## Installation

```bash
cd copilot-sessions-keeper
npm install
npm run compile
```

Then install the `.vsix`:

```bash
npm run package
code --install-extension copilot-sessions-keeper-0.1.0.vsix
```

Or for development, press `F5` in VS Code to launch the Extension Development Host.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `copilotSessionsKeeper.backupDir` | string | `~/copilot-sessions-keeper` | Backup output directory |
| `copilotSessionsKeeper.enabled` | boolean | `true` | Enable automatic daily backup |

## Commands

| Command | Description |
|---------|-------------|
| `Copilot Sessions Keeper: Backup Now` | Run an export immediately |

## Schema Change Detection

VS Code's chat storage format is internal and undocumented — it can change between updates. This extension fingerprints the observed data shape (JSONL entry kinds, object keys, response part types) and compares it against a stored baseline on each run.

When a change is detected:
1. A warning notification appears
2. A detailed diff report is written to the backup directory
3. You can choose to **Open Report**, **Accept New Schema** (update baseline), or **Dismiss**

See [docs/data-model.md](docs/data-model.md) for details on the storage format.

## Supported Platforms

- **macOS** — Primary target (reads from `~/Library/Application Support/Code/User/`)
- **Linux/Windows** — Requires updating the `VSCODE_STORAGE` path (see `src/exporter.ts`)

## Project Structure

```
copilot-sessions-keeper/
├── src/
│   ├── extension.ts      # Extension lifecycle, daily check, schema alerts
│   └── exporter.ts       # Session parsing, schema observation, file writing
├── docs/
│   ├── functional-spec.md
│   ├── test-spec.md
│   ├── data-model.md
│   └── adr.md            # Architecture Decision Records
├── CHANGELOG.md
├── package.json
└── tsconfig.json
```

## License

MIT
