# Test Specification: Copilot Sessions Keeper

**Version:** 0.1.0
**Status:** Draft

---

## 1. Test Strategy

The extension has no network dependencies and operates on local files, making it well-suited for deterministic unit and integration testing with fixture data.

### Test Levels

| Level | Scope | Framework | Location |
|-------|-------|-----------|----------|
| Unit | Parsers, formatters, slug/helper functions | Mocha + assert | `src/test/unit/` |
| Integration | Full export pipeline with fixture sessions | Mocha + tmp dirs | `src/test/integration/` |
| Manual | Activation trigger, notifications, schema alerts | VS Code Extension Host | N/A |

### Test Data

Test fixtures should be real session files (anonymized) placed in `src/test/fixtures/`:

```
src/test/fixtures/
├── jsonl/
│   ├── simple-session.jsonl        # 1 turn, basic
│   ├── multi-turn-session.jsonl    # 5+ turns with thinking, code edits, tools
│   ├── no-title-session.jsonl      # Title derived from first user message
│   ├── empty-session.jsonl         # kind=0 only, no requests
│   └── malformed.jsonl             # Invalid JSON on line 3
├── legacy-json/
│   ├── single-request.json         # Legacy format with 1 request
│   └── multi-request.json          # Legacy format with 5+ requests
└── workspace.json                  # Mock workspace.json
```

---

## 2. Unit Tests

### 2.1 JSONL Parser (`parseJsonl`)

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-01 | Parse simple session | `simple-session.jsonl` | Session with 1 turn, correct title, sessionId, creationDate |
| U-02 | Parse multi-turn session | `multi-turn-session.jsonl` | All turns extracted with user + assistant text |
| U-03 | Title fallback to first user message | `no-title-session.jsonl` | Title = first 60 chars of first user input |
| U-04 | Empty session returns no turns | `empty-session.jsonl` | `session.turns.length === 0` |
| U-05 | Malformed line causes file skip | `malformed.jsonl` | `parseJsonl` throws; caller catches and skips the file (no per-line recovery). See E-07 |

### 2.2 Legacy JSON Parser (`parseLegacyJson`)

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-06 | Parse single request | `single-request.json` | 1 turn with user and assistant text |
| U-07 | Parse multi-request session | `multi-request.json` | All requests extracted |
| U-08 | customTitle is used | `single-request.json` | `session.title === data.customTitle` |
| U-09 | Missing customTitle fallback | JSON with no `customTitle` field | `session.title === ""` (empty string) |

### 2.3 Turn Extraction (`extractTurn`)

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-10 | User text from message parts | `{ message: { parts: [{ text: "hello" }] } }` | `turn.user === "hello"` |
| U-11 | Multiple user text parts joined | Two `text` parts | Joined with `\n` |
| U-12 | Thinking blocks separated | Response with `kind: "thinking"` | `turn.thinking` populated, not in `turn.assistant` |
| U-13 | Markdown content extracted | Response with `kind: undefined, value: "answer"` | `turn.assistant` contains "answer" |
| U-14 | Code edit placeholder | Response with `kind: "textEditGroup"` | `turn.assistant` contains `[code edit]` |
| U-15 | Tool invocation summary | Response with `kind: "toolInvocationSerialized"` | `turn.assistant` contains past-tense message |
| U-16 | Inline reference | Response with `kind: "inlineReference"` | `turn.assistant` contains backticked filename |
| U-17b | elicitationSerialized extracts message | Response with `kind: "elicitationSerialized"` | `turn.assistant` contains message |
| U-17c | codeblockUri extracts filename | Response with `kind: "codeblockUri"` | `turn.assistant` contains backticked basename |
| U-18 | Empty response | `response: []` | `turn.assistant === ""` |

### 2.4 Schema Fingerprinting

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-20 | Observer collects JSONL kinds | Process sessions with kinds 0,1,2 | `fp.jsonlKinds === [0,1,2]` |
| U-21 | Observer collects init keys | Parse kind=0 entry | `fp.initKeys` contains `sessionId`, `creationDate` etc. |
| U-22 | Observer collects response part kinds | Parse response | `fp.responsePartKinds` contains observed kinds |
| U-23 | Fingerprint to string is deterministic | Same input twice | Identical output strings |
| U-24 | diffFingerprints detects added keys | Old: `[a,b]`, New: `[a,b,c]` | Diff reports `added [c]` |
| U-25 | diffFingerprints detects removed keys | Old: `[a,b,c]`, New: `[a,b]` | Diff reports `removed [c]` |
| U-26 | diffFingerprints returns null on match | Same fingerprints | Returns `null` |
| U-27 | diffFingerprintsAdditionsOnly ignores removals | Stored has extras, current is subset | Returns `null` |
| U-27b | diffFingerprintsAdditionsOnly reports only additions | Current has new keys | Reports additions, not removals |
| U-28 | mergeFingerprints produces sorted union | Two overlapping fingerprints | Union of all keys, sorted |
| U-28b | mergeFingerprints is idempotent | Same fingerprint merged with itself | Identical output |
| U-29 | updateUsageStats bumps count and lastSeen | Observed fingerprint + today's date | count incremented, lastSeen updated |
| U-29b | updateUsageStats increments on subsequent runs | Two runs | count = 2 |
| U-29c | updateUsageStats preserves unobserved keys | Key not in current run | Historical stats unchanged |
| U-29d | formatUsageStats produces readable output | Stats with entries | Multi-line formatted string |
| U-29e | formatUsageStats handles empty stats | Empty stats | Returns placeholder |

### 2.5 Output Formatting

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-30 | Folder name format | Session dated 2026-04-13, title "My Topic" | Folder: `2026-04-13`, files: `my-topic.json`, `my-topic.md` |
| U-31 | Slug truncation | Title > 80 chars | Slug truncated to 80 chars |
| U-32 | Slug sanitization | Title with `special!@#chars` | Only lowercase alphanumeric and hyphens |
| U-33 | Undated session | `creationDate = 0` | Folder: `undated` |
| U-34 | Markdown structure | Session with 2 turns | YAML frontmatter with session_id, workspace, date; H1 title; 2 User/Assistant sections |
| U-35 | JSON structure | Parsed session | Valid JSON matching `Session` interface |

### 2.6 Helpers

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-40 | slugify basic | `"Hello World"` | `"hello-world"` |
| U-41 | slugify special chars | `"git reset --hard & push"` | `"git-reset-hard-push"` |
| U-42 | readWorkspaceName from workspace.json | Mock file with `folder` field | Decoded folder name |
| U-43 | readWorkspaceName fallback | Missing workspace.json | Returns directory basename |
| U-44 | getVscodeStoragePath platform path | Current platform | Path ends with platform-appropriate suffix |
| U-45 | getVscodeStoragePath includes homedir | Current platform | Path starts with homedir or APPDATA |

### 2.7 Git Remote Resolution

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-50 | normalizeGitUrl SSH format | `git@github.com:user/repo.git` | `https://github.com/user/repo` |
| U-51 | normalizeGitUrl HTTPS with .git | `https://github.com/user/repo.git` | `https://github.com/user/repo` |
| U-52 | normalizeGitUrl plain HTTPS | `https://github.com/user/repo` | unchanged |
| U-53 | resolveGitRemote non-existent path | non-existent dir | `undefined` |
| U-54 | resolveGitRemote non-git dir | temp dir with no .git | `undefined` |
| U-55 | resolveGitRemote caches results | same path called twice | `execSync` called only once |

### 2.8 YAML Escaping

| ID | Test Case | Input | Expected |
|----|-----------|-------|----------|
| U-60 | yamlEscape quotes | `He said "hello"` | `He said \"hello\"` |
| U-61 | yamlEscape backslash | `C:\Users\test` | `C:\\Users\\test` |
| U-62 | yamlEscape newline | `line1\nline2` | `line1\\nline2` |
| U-63 | yamlEscape tabs | `col1\tcol2` | `col1\\tcol2` |
| U-64 | yamlEscape combined | `"path\nto\tthing"` | All special chars escaped |

---

## 3. Integration Tests

| ID | Test Case | Setup | Expected |
|----|-----------|-------|----------|
| I-01 | Full pipeline: JSONL sessions | Create temp dir with mock chatSessions | Date folders appear in output dir with .json + .md files |
| I-02 | Full pipeline: Legacy JSON sessions | Create temp emptyWindowChatSessions dir | Sessions exported correctly |
| I-03 | Idempotency | Run export twice on same data | Second run exports 0 new sessions |
| I-04 | Mixed formats | Both JSONL and legacy JSON present | All sessions exported, no conflicts |
| I-05 | Schema fingerprint returned | Run export | `result.schemaFingerprint` has non-empty arrays |
| I-06 | Graceful skip on corrupt file | One good + one bad file | Good session exported, bad skipped |
| I-07 | Empty workspace storage | No chatSessions dirs | Returns `count: 0`, no errors |
| I-08 | Incremental backup: unchanged skipped | Run export twice, no file changes | Second run: `skippedUnchanged === 1` |
| I-09 | Incremental backup: modified re-parsed | Run export, touch source file, run again | File re-parsed (mtime changed) |
| I-10 | Metadata file persists | Run export | `_metadata.json` exists with numeric mtime values |

---

## 4. Manual / E2E Tests

These require running in the VS Code Extension Development Host.

| ID | Test Case | Steps | Expected |
|----|-----------|-------|----------|
| M-01 | Auto-backup on first day launch | 1. Clear `lastBackupDate` from state 2. Reload window | Info notification shows count, backup files created |
| M-02 | No duplicate backup same day | 1. Complete M-01 2. Reload window again | No notification, no new files |
| M-03 | Manual backup command | 1. Open Command Palette 2. Run "Backup Now" | Notification shows count |
| M-04 | Schema change alert | 1. Modify stored fingerprint in state 2. Run backup | Warning notification with 3 action buttons |
| M-05 | Accept New Schema | 1. Trigger M-04 2. Click "Accept" | No alert on next run |
| M-06 | Open Report | 1. Trigger M-04 2. Click "Open Report" | `schema-change-*.txt` opens in editor |
| M-07 | Custom backup dir | 1. Set `copilotSessionsKeeper.backupDir` to `/tmp/test-backup` 2. Run backup | Files appear in `/tmp/test-backup/` |
| M-08 | Disabled extension | 1. Set `enabled: false` 2. Reload | No auto-backup on startup |

---

## 5. Edge Cases

| ID | Test Case | Expected |
|----|-----------|----------|
| E-01 | Session with no user text (empty requests) | Turn skipped (not exported) |
| E-02 | Session with only thinking, no assistant text | Turn has `assistant: ""`, still exported if user text present |
| E-03 | Very long session title (>200 chars) | Slug truncated to 80 chars, no filesystem errors |
| E-04 | Session title with unicode / emoji | Slugified to ASCII-safe chars |
| E-05 | Backup dir on read-only filesystem | Error notification, graceful failure |
| E-06 | Concurrent VS Code windows | Each window may trigger backup; idempotency prevents duplicates |
| E-07 | Malformed JSON line in JSONL | Entire file skipped (`JSON.parse` throws, caught by caller). No partial session recovery |
| E-08 | File name collision (same date + same slug) | Second session exported with `-<sessionId[:8]>` suffix. Idempotent on re-run. |
| E-09 | Idempotency with JSON disabled | `outputJson: false`, run twice | Second run skips via MD frontmatter `session_id` match |
| E-10 | Corrupt JSON with valid MD | JSON file corrupt, MD exists with matching session_id | Session correctly identified as same via MD fallback |

---

## 5.1 Retention Policy Tests

| ID | Test Case | Expected |
|----|-----------|----------|
| R-01 | Folders older than retention period | Old folder deleted, recent folder kept |
| R-02 | Non-date folders and files | `undated`, `_metadata.json` untouched |
| R-03 | retentionDays = 0 | Nothing deleted |
| R-04 | Folders within retention window | 29-day-old kept, 31-day-old pruned |

---

## 6. Test Execution

```bash
# Unit + integration tests
npm test

# Watch mode during development
npm run test:watch

# E2E tests (launches VS Code Extension Host)
npm run test:e2e

# Manual tests
# Press F5 in VS Code to launch Extension Development Host
```

### `package.json` scripts

```json
{
  "scripts": {
    "test": "mocha --require ts-node/register 'src/test/unit/**/*.test.ts' 'src/test/integration/**/*.test.ts'",
    "test:watch": "mocha --watch --require ts-node/register 'src/test/**/*.test.ts'",
    "test:e2e": "npm run compile && node out/test/e2e/runTest.js"
  },
  "devDependencies": {
    "mocha": "^10.0.0",
    "ts-node": "^10.0.0",
    "@types/mocha": "^10.0.0",
    "@vscode/test-electron": "^2.3.0"
  }
}
```

> **Note:** Unit tests for `exporter.ts` functions (parsers, slugify, fingerprinting)
> do not depend on the `vscode` module and can run in plain Node.js.
> Only `extension.ts` tests require the Extension Host via `@vscode/test-electron`.
