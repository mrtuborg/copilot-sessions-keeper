# Architecture Decision Records

## ADR-001: Read files directly instead of using VS Code API

**Status:** Accepted
**Date:** 2026-04-13

**Context:** VS Code has no public API for reading chat session content. The internal `vscode-chat-session://` URI scheme is not accessible to extensions.

**Decision:** Read session files directly from disk using Node.js `fs` module. The storage locations are discovered by scanning `workspaceStorage/` and `globalStorage/emptyWindowChatSessions/`.

**Consequences:**
- Works without any VS Code API dependency for data access
- Breaks if VS Code changes storage paths or file format (mitigated by schema detection)
- ~~macOS-specific paths hardcoded (Linux/Windows need path updates)~~ Resolved: `getVscodeStoragePath()` now detects macOS, Linux, and Windows paths automatically

---

## ADR-002: JSONL append-log parsing strategy

**Status:** Accepted
**Date:** 2026-04-13

**Context:** VS Code stores sessions as `.jsonl` append-only logs with three entry kinds (0=init, 1=mutation, 2=request-batch). Full conversation content is in kind=2 entries. Kind=1 entries are incremental mutations (title, state changes, editor selections).

**Decision:** Parse only kind=0 (metadata) and kind=2 (request/response pairs) for content extraction. Use the first non-trivial string in kind=1 as the session title. Ignore other kind=1 mutations.

**Consequences:**
- Simple, robust parsing
- Some metadata from mutations is lost (editor selections, state transitions) — acceptable for backup purposes

---

## ADR-003: Schema fingerprinting for forward compatibility

**Status:** Accepted
**Date:** 2026-04-13

**Context:** The VS Code chat storage format is undocumented and internal. It changes between VS Code versions without notice. A silent format change would cause the extension to produce incomplete or empty backups.

**Decision:** On each export run, observe the structural properties of all parsed data (JSONL kinds, object keys, response part kinds) and compare against a stored baseline. Alert the user when the shape changes.

**Consequences:**
- Early warning when format changes, before data is lost
- May produce false positives if a new session uses a previously unseen response part kind
- User chooses when to accept new schema baseline

---

## ADR-004: Idempotent export with file-existence check

**Status:** Accepted
**Date:** 2026-04-13

**Context:** The extension may run multiple times (manual trigger, multiple windows, re-activation). Re-exporting the same session should not create duplicates or overwrite data.

**Decision:** Each session maps to a date folder (`YYYY-MM-DD`) and a deterministic file name (`{slug}.json`). If the `.json` file already exists, skip the session. Multiple sessions from the same date share one folder.

**Consequences:**
- Simple and fast — no content comparison needed
- Date folders group related sessions for easier browsing
- ~~A session that grows over time (new turns added) will NOT be re-exported after the initial backup. Incremental updates are a future consideration.~~ Partially resolved: incremental backup via mtime tracking skips unchanged source files. Sessions updated since last export are re-parsed (but the existing output file prevents overwrite via idempotency check).
- ~~File name collision when two sessions share the same date and slug~~ Resolved: colliding sessions now get a `-<sessionId>` suffix appended to the slug.

---

## ADR-005: No native dependencies (no SQLite library)

**Status:** Accepted
**Date:** 2026-04-13

**Context:** Originally considered reading `state.vscdb` (SQLite) for session index data. This would require a native SQLite module or WASM wrapper.

**Decision:** Read session content directly from `.jsonl`/`.json` files, which contain the full conversation data. The SQLite `state.vscdb` only contains session metadata (index, titles) which can also be derived from the session files themselves.

**Consequences:**
- No native module compilation issues
- Extension works on any platform without binary distribution concerns
- Cannot access the session index metadata (timing stats, pending state) — acceptable for backup purposes

---

## ADR-006: Incremental backup via mtime tracking

**Status:** Accepted
**Date:** 2026-04-14

**Context:** Every export run re-reads and re-parses all session files, even though most are unchanged between runs. For users with many workspaces, this adds unnecessary I/O and CPU overhead.

**Decision:** Track source file modification times (`mtimeMs`) in a `_metadata.json` file inside the backup directory. On each run, skip files whose mtime matches the stored value.

**Consequences:**
- Significantly faster subsequent runs (only new/modified files are parsed)
- `_metadata.json` is a simple JSON map; no database needed
- If `_metadata.json` is deleted, the next run re-parses everything (graceful fallback)
- Cannot detect sessions deleted from VS Code storage (stale entries in metadata are harmless)

---

## ADR-007: Retention policy for old backups

**Status:** Accepted
**Date:** 2026-04-14

**Context:** Over months of use, the backup directory accumulates many date folders. Users may want automatic cleanup of old backups.

**Decision:** Add a `retentionDays` configuration setting (default `0` = keep forever). After each backup run, scan for `YYYY-MM-DD` folders older than the retention period and delete them. Non-date folders (`undated`, `_metadata.json`, schema reports) are never pruned.

**Consequences:**
- Disk usage is bounded for users who enable retention
- Default of `0` means no data loss for users who don't configure it
- Only date-named folders are affected; metadata and schema reports are preserved
