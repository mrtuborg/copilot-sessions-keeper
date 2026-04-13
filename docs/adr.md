# Architecture Decision Records

## ADR-001: Read files directly instead of using VS Code API

**Status:** Accepted
**Date:** 2026-04-13

**Context:** VS Code has no public API for reading chat session content. The internal `vscode-chat-session://` URI scheme is not accessible to extensions.

**Decision:** Read session files directly from disk using Node.js `fs` module. The storage locations are discovered by scanning `workspaceStorage/` and `globalStorage/emptyWindowChatSessions/`.

**Consequences:**
- Works without any VS Code API dependency for data access
- Breaks if VS Code changes storage paths or file format (mitigated by schema detection)
- macOS-specific paths hardcoded (Linux/Windows need path updates)

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
- A session that grows over time (new turns added) will NOT be re-exported after the initial backup. Incremental updates are a future consideration.

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
