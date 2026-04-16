# Copilot Sessions Keeper — User's Guide

## What It Does

Copilot Sessions Keeper automatically backs up your GitHub Copilot chat sessions from VS Code to local files. VS Code only keeps the last ~40 conversation turns per workspace — older exchanges are silently deleted. This extension captures them before they're lost.

Each session is saved as:
- **Markdown** (`.md`) — human-readable, Obsidian-compatible with YAML frontmatter
- **JSON** (`.json`) — full-fidelity structured data (optional)

## Installation

### From VSIX

```bash
git clone https://github.com/mrtuborg/copilot-sessions-keeper.git
cd copilot-sessions-keeper
npm install
npm run compile
npx vsce package --no-dependencies
code --install-extension copilot-sessions-keeper-0.1.0.vsix
```

Then reload VS Code.

### For Development

Open the project in VS Code and press `F5` to launch the Extension Development Host.

## How It Works

1. **Daily auto-backup**: On the first VS Code launch each day, all chat sessions are exported automatically.
2. **Manual backup**: Run `Copilot Sessions Keeper: Backup Now` from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) at any time.

Backups are **incremental** — unchanged source files are skipped using modification time tracking. Re-running is always safe (idempotent).

## Output

By default, backups are written to `~/copilot-sessions-keeper/`:

```
~/copilot-sessions-keeper/
├── 2026-04-10/
│   ├── github-actions-pipeline.md
│   ├── github-actions-pipeline.json
│   ├── debugging-typescript.md
│   └── debugging-typescript.json
├── 2026-04-13/
│   ├── accessing-lm-sessions.md
│   └── accessing-lm-sessions.json
└── _metadata.json
```

### Markdown Files

Markdown files include YAML frontmatter for use with Obsidian or other tools:

```yaml
---
title: "Debugging TypeScript Imports"
session_id: "a1b2c3d4-e5f6-..."
date: 2026-04-10T14:30:00.000Z
workspace: "/Users/vn/ws/my-project"
git_remote: "https://github.com/user/my-project"
---
```

The `git_remote` field is automatically resolved from the workspace folder's git origin remote. It only appears if the folder is a git repository with an `origin` remote configured.

The body contains each conversation turn:
- **Timestamp** — when the turn occurred
- **User** — your message
- **Thinking** — model's chain-of-thought (in a collapsible `<details>` block)
- **Assistant** — model's response

### Using with Obsidian

Point your Obsidian vault (or a subfolder) at the backup directory. The YAML frontmatter is parsed by Obsidian as properties, enabling:
- Searching by workspace, date, or repository
- Filtering with Dataview queries
- Linking sessions to project notes

Example Dataview query to list all sessions for a repository:

```dataview
TABLE date, title
FROM ""
WHERE git_remote = "https://github.com/user/my-project"
SORT date DESC
```

## Settings

Open VS Code Settings (`Cmd+,` / `Ctrl+,`) and search for "Copilot Sessions Keeper":

| Setting | Default | Description |
|---------|---------|-------------|
| **Backup Dir** | `~/copilot-sessions-keeper` | Where to save backups. Supports `~` for home directory. |
| **Enabled** | `true` | Enable/disable automatic daily backup. Manual backup command still works when disabled. |
| **Retention Days** | `0` (keep forever) | Auto-delete backup folders older than this many days. Set to `0` to keep everything. |
| **Output JSON** | `true` | Write a `.json` file for each session alongside the `.md`. Uncheck to produce Markdown only. |

### JSON-only Setting

All configuration keys are under `copilotSessionsKeeper`:

```json
{
    "copilotSessionsKeeper.backupDir": "~/Documents/copilot-backups",
    "copilotSessionsKeeper.enabled": true,
    "copilotSessionsKeeper.retentionDays": 90,
    "copilotSessionsKeeper.outputJson": false
}
```

## Git Repository Tracking

For workspace-scoped sessions, the extension runs `git remote get-url origin` in the workspace folder to resolve the repository URL. This is:
- **Automatic** — no configuration needed
- **Cached** — each workspace is resolved only once per export run
- **Normalized** — SSH URLs (`git@github.com:user/repo.git`) are converted to HTTPS (`https://github.com/user/repo`)
- **Optional** — if the folder isn't a git repo or has no origin remote, `git_remote` is simply omitted

## Schema Change Detection

VS Code's chat storage format is internal and can change between updates. The extension fingerprints the observed data structure on each run and alerts you if something new appears.

When a change is detected:
1. A warning notification appears
2. A diff report is written to the backup directory (e.g., `schema-change-2026-04-14.txt`)
3. Actions: **Open Report** (view the diff), **Accept New Schema** (update baseline), or **Dismiss**

This ensures the parser can be updated before any data is lost to format changes.

## Supported Session Types

| Type | Source | Description |
|------|--------|-------------|
| Workspace sessions | `workspaceStorage/<id>/chatSessions/*.jsonl` | Sessions from specific project windows |
| Empty-window sessions | `globalStorage/emptyWindowChatSessions/*.jsonl` | Sessions from windows with no folder open |
| Legacy sessions | `globalStorage/emptyWindowChatSessions/*.json` | Older format, no longer generated by VS Code |

## Supported Platforms

| Platform | VS Code Storage Path |
|----------|---------------------|
| **macOS** | `~/Library/Application Support/Code/User/` |
| **Linux** | `~/.config/Code/User/` |
| **Windows** | `%APPDATA%/Code/User/` |

## Troubleshooting

### No sessions exported

- Check that you have Copilot chat history in VS Code (open the Chat panel and verify conversations exist)
- Ensure `copilotSessionsKeeper.enabled` is `true`
- Run the manual backup command to see if any errors appear
- Check the Output panel (`View > Output`) and select "Log (Extension Host)" for warnings

### Backup runs but count is 0

- Sessions may have already been exported. The extension skips unchanged files.
- Try deleting `_metadata.json` from the backup directory to force a full re-export.

### Schema change warning

This is informational — your sessions were still exported. The warning means VS Code changed its internal format. Check the report to see what changed and update the extension if needed.

### Permission errors

Ensure the backup directory is writable. On macOS/Linux:

```bash
mkdir -p ~/copilot-sessions-keeper
chmod 755 ~/copilot-sessions-keeper
```
