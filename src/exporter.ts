import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/** A single request–response turn in a session. */
export interface Turn {
    user: string;
    assistant: string;
    thinking: string;
    timestamp: number;
}

/** A fully parsed chat session. */
export interface Session {
    sessionId: string;
    title: string;
    creationDate: number;
    workspace: string;
    gitRemote?: string;
    turns: Turn[];
}

/**
 * Describes the observed shape of the chat session data.
 * When VS Code updates change the format, the fingerprint changes.
 */
export interface SchemaFingerprint {
    /** Sorted set of JSONL entry kinds seen (e.g. [0,1,2]) */
    jsonlKinds: number[];
    /** Sorted keys in kind=0 initialization object */
    initKeys: string[];
    /** Sorted keys in a request object (inside kind=2) */
    requestKeys: string[];
    /** Sorted set of response part kinds (e.g. ["thinking","markdownContent",...]) */
    responsePartKinds: string[];
    /** Sorted keys in legacy JSON session format */
    legacySessionKeys: string[];
    /** Sorted keys in a legacy request object */
    legacyRequestKeys: string[];
}

export interface ExportResult {
    count: number;
    schemaFingerprint: SchemaFingerprint;
    skippedUnchanged: number;
}

/* ------------------------------------------------------------------ */
/*  Schema usage statistics                                           */
/* ------------------------------------------------------------------ */

/** Per-key usage tracking: when we last saw it and how many runs included it. */
export interface KeyUsage {
    /** ISO date string (YYYY-MM-DD) of the last run that observed this key */
    lastSeen: string;
    /** Total number of export runs that observed this key */
    count: number;
}

/**
 * Tracks per-key usage across export runs so we can distinguish
 * "key removed from schema" from "key just not seen in this run."
 *
 * Each category maps key-name → { lastSeen, count }.
 */
export interface SchemaUsageStats {
    jsonlKinds: Record<string, KeyUsage>;
    initKeys: Record<string, KeyUsage>;
    requestKeys: Record<string, KeyUsage>;
    responsePartKinds: Record<string, KeyUsage>;
    legacySessionKeys: Record<string, KeyUsage>;
    legacyRequestKeys: Record<string, KeyUsage>;
}

/** Return a fresh empty stats object. */
export function emptyUsageStats(): SchemaUsageStats {
    return {
        jsonlKinds: {}, initKeys: {}, requestKeys: {},
        responsePartKinds: {}, legacySessionKeys: {}, legacyRequestKeys: {},
    };
}

/**
 * Merge a run's observed fingerprint into the cumulative usage stats.
 * Keys present in this run get their count incremented and lastSeen updated.
 * Keys NOT in this run are left unchanged (preserving their historical stats).
 */
export function updateUsageStats(
    stored: SchemaUsageStats,
    observed: SchemaFingerprint,
    today: string,
): SchemaUsageStats {
    const result: SchemaUsageStats = {
        jsonlKinds: { ...stored.jsonlKinds },
        initKeys: { ...stored.initKeys },
        requestKeys: { ...stored.requestKeys },
        responsePartKinds: { ...stored.responsePartKinds },
        legacySessionKeys: { ...stored.legacySessionKeys },
        legacyRequestKeys: { ...stored.legacyRequestKeys },
    };

    const bump = (map: Record<string, KeyUsage>, keys: (string | number)[]) => {
        for (const k of keys) {
            const key = String(k);
            const prev = map[key];
            map[key] = {
                lastSeen: today,
                count: (prev?.count ?? 0) + 1,
            };
        }
    };

    bump(result.jsonlKinds, observed.jsonlKinds);
    bump(result.initKeys, observed.initKeys);
    bump(result.requestKeys, observed.requestKeys);
    bump(result.responsePartKinds, observed.responsePartKinds);
    bump(result.legacySessionKeys, observed.legacySessionKeys);
    bump(result.legacyRequestKeys, observed.legacyRequestKeys);

    return result;
}

/**
 * Format usage stats as a human-readable summary for the schema report.
 * Shows each category with key, last-seen date, and observation count.
 */
export function formatUsageStats(stats: SchemaUsageStats): string {
    const lines: string[] = [];

    const section = (label: string, map: Record<string, KeyUsage>) => {
        const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) { return; }
        lines.push(`  ${label}:`);
        for (const [key, usage] of entries) {
            lines.push(`    ${key}: lastSeen=${usage.lastSeen}, count=${usage.count}`);
        }
    };

    section('JSONL kinds', stats.jsonlKinds);
    section('Init keys', stats.initKeys);
    section('Request keys', stats.requestKeys);
    section('Response part kinds', stats.responsePartKinds);
    section('Legacy session keys', stats.legacySessionKeys);
    section('Legacy request keys', stats.legacyRequestKeys);

    return lines.length > 0 ? lines.join('\n') : '(no stats)';
}

/**
 * Return the default VS Code user-data directory for the current platform.
 *   macOS  : ~/Library/Application Support/Code/User
 *   Linux  : ~/.config/Code/User
 *   Windows: %APPDATA%/Code/User
 */
export function getVscodeStoragePath(): string {
    switch (process.platform) {
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
        case 'win32':
            return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
        case 'linux':
        default:
            return path.join(os.homedir(), '.config', 'Code', 'User');
    }
}

const VSCODE_STORAGE = getVscodeStoragePath();

// Accumulates structural observations during a single export run.
let _schemaObserver: SchemaObserver;

export class SchemaObserver {
    readonly jsonlKinds = new Set<number>();
    readonly initKeys = new Set<string>();
    readonly requestKeys = new Set<string>();
    readonly responsePartKinds = new Set<string>();
    readonly legacySessionKeys = new Set<string>();
    readonly legacyRequestKeys = new Set<string>();

    observeJsonlKind(kind: number) { this.jsonlKinds.add(kind); }
    observeInitKeys(keys: string[]) { keys.forEach(k => this.initKeys.add(k)); }
    observeRequestKeys(keys: string[]) { keys.forEach(k => this.requestKeys.add(k)); }
    observeResponsePartKind(kind: string) { this.responsePartKinds.add(kind); }
    observeLegacySessionKeys(keys: string[]) { keys.forEach(k => this.legacySessionKeys.add(k)); }
    observeLegacyRequestKeys(keys: string[]) { keys.forEach(k => this.legacyRequestKeys.add(k)); }

    toFingerprint(): SchemaFingerprint {
        return {
            jsonlKinds: [...this.jsonlKinds].sort((a, b) => a - b),
            initKeys: [...this.initKeys].sort(),
            requestKeys: [...this.requestKeys].sort(),
            responsePartKinds: [...this.responsePartKinds].sort(),
            legacySessionKeys: [...this.legacySessionKeys].sort(),
            legacyRequestKeys: [...this.legacyRequestKeys].sort(),
        };
    }
}

/**
 * Reset the module-level schema observer. Needed for unit tests.
 */
export function _resetSchemaObserver(): SchemaObserver {
    _schemaObserver = new SchemaObserver();
    return _schemaObserver;
}

/**
 * Produce a stable string hash of a fingerprint for easy comparison.
 */
export function fingerprintToString(fp: SchemaFingerprint): string {
    return JSON.stringify(fp);
}

/**
 * Compare two fingerprints and return a human-readable diff of changes.
 * Returns null if they match.
 */
export function diffFingerprints(
    stored: SchemaFingerprint,
    current: SchemaFingerprint
): string | null {
    const diffs: string[] = [];

    const compare = (label: string, oldVal: (string | number)[], newVal: (string | number)[]) => {
        const oldSet = new Set(oldVal.map(String));
        const newSet = new Set(newVal.map(String));
        const added = [...newSet].filter(x => !oldSet.has(x));
        const removed = [...oldSet].filter(x => !newSet.has(x));
        if (added.length > 0) { diffs.push(`${label}: added [${added.join(', ')}]`); }
        if (removed.length > 0) { diffs.push(`${label}: removed [${removed.join(', ')}]`); }
    };

    compare('JSONL entry kinds', stored.jsonlKinds, current.jsonlKinds);
    compare('Init object keys', stored.initKeys, current.initKeys);
    compare('Request keys', stored.requestKeys, current.requestKeys);
    compare('Response part kinds', stored.responsePartKinds, current.responsePartKinds);
    compare('Legacy session keys', stored.legacySessionKeys, current.legacySessionKeys);
    compare('Legacy request keys', stored.legacyRequestKeys, current.legacyRequestKeys);

    return diffs.length > 0 ? diffs.join('\n') : null;
}

/**
 * Return only the additions in `current` that are not present in `stored`.
 * Removals are ignored because a single export run may not observe all
 * possible keys (not every session exercises every field).
 * Returns null if there are no additions.
 */
export function diffFingerprintsAdditionsOnly(
    stored: SchemaFingerprint,
    current: SchemaFingerprint
): string | null {
    const diffs: string[] = [];

    const compare = (label: string, oldVal: (string | number)[], newVal: (string | number)[]) => {
        const oldSet = new Set(oldVal.map(String));
        const added = newVal.map(String).filter(x => !oldSet.has(x));
        if (added.length > 0) { diffs.push(`${label}: added [${added.join(', ')}]`); }
    };

    compare('JSONL entry kinds', stored.jsonlKinds, current.jsonlKinds);
    compare('Init object keys', stored.initKeys, current.initKeys);
    compare('Request keys', stored.requestKeys, current.requestKeys);
    compare('Response part kinds', stored.responsePartKinds, current.responsePartKinds);
    compare('Legacy session keys', stored.legacySessionKeys, current.legacySessionKeys);
    compare('Legacy request keys', stored.legacyRequestKeys, current.legacyRequestKeys);

    return diffs.length > 0 ? diffs.join('\n') : null;
}

/**
 * Merge two fingerprints into a monotonic union. Each array in the
 * result contains the sorted union of entries from both inputs.
 * This ensures the stored fingerprint only grows over time, so keys
 * absent from a single partial run are never treated as removals.
 */
export function mergeFingerprints(
    a: SchemaFingerprint,
    b: SchemaFingerprint
): SchemaFingerprint {
    const mergeNumbers = (x: number[], y: number[]) =>
        [...new Set([...x, ...y])].sort((m, n) => m - n);
    const mergeStrings = (x: string[], y: string[]) =>
        [...new Set([...x, ...y])].sort();

    return {
        jsonlKinds: mergeNumbers(a.jsonlKinds, b.jsonlKinds),
        initKeys: mergeStrings(a.initKeys, b.initKeys),
        requestKeys: mergeStrings(a.requestKeys, b.requestKeys),
        responsePartKinds: mergeStrings(a.responsePartKinds, b.responsePartKinds),
        legacySessionKeys: mergeStrings(a.legacySessionKeys, b.legacySessionKeys),
        legacyRequestKeys: mergeStrings(a.legacyRequestKeys, b.legacyRequestKeys),
    };
}

/**
 * Export all Copilot chat sessions to dated folders.
 * Returns the count and an observed schema fingerprint.
 *
 * Tracks source file modification times in `_metadata.json` inside the
 * backup directory so unchanged files are skipped on subsequent runs.
 */
export async function exportAllSessions(backupDir: string, storageRoot?: string, options?: WriteOptions): Promise<ExportResult> {
    fs.mkdirSync(backupDir, { recursive: true });
    _schemaObserver = new SchemaObserver();
    let count = 0;
    let skippedUnchanged = 0;
    const root = storageRoot ?? VSCODE_STORAGE;
    const mtimeMap = loadMtimeMap(backupDir);
    const newMtimeMap: Record<string, number> = {};

    const processFile = (filePath: string, parse: () => Session | null) => {
        const mtime = fs.statSync(filePath).mtimeMs;
        newMtimeMap[filePath] = mtime;

        if (mtimeMap[filePath] === mtime) {
            skippedUnchanged++;
            return; // File unchanged since last export
        }

        const session = parse();
        if (session && session.turns.length > 0) {
            if (writeSession(session, backupDir, options)) {
                count++;
            }
        }
    };

    // 1. Workspace-scoped sessions (chatSessions/*.jsonl)
    const wsRoot = path.join(root, 'workspaceStorage');
    if (fs.existsSync(wsRoot)) {
        for (const wsId of fs.readdirSync(wsRoot)) {
            const wsDir = path.join(wsRoot, wsId);
            const chatDir = path.join(wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) { continue; }

            const workspace = readWorkspaceName(wsDir);
            const gitRemote = resolveGitRemote(workspace);

            for (const file of fs.readdirSync(chatDir)) {
                if (!file.endsWith('.jsonl')) { continue; }
                try {
                    const filePath = path.join(chatDir, file);
                    processFile(filePath, () => {
                        const session = parseJsonl(filePath, workspace);
                        if (session && gitRemote) { session.gitRemote = gitRemote; }
                        return session;
                    });
                } catch (e) {
                    console.warn(`[copilot-sessions-keeper] skipped ${file}: ${e}`);
                }
            }
        }
    }

    // 2. Empty-window sessions (emptyWindowChatSessions/*.json + *.jsonl)
    const emptyDir = path.join(root, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(emptyDir)) {
        for (const file of fs.readdirSync(emptyDir)) {
            const filePath = path.join(emptyDir, file);
            try {
                if (file.endsWith('.json')) {
                    processFile(filePath, () => parseLegacyJson(filePath));
                } else if (file.endsWith('.jsonl')) {
                    processFile(filePath, () => parseJsonl(filePath, '(no workspace)'));
                }
            } catch (e) {
                console.warn(`[copilot-sessions-keeper] skipped ${file}: ${e}`);
            }
        }
    }

    saveMtimeMap(backupDir, newMtimeMap);
    return { count, schemaFingerprint: _schemaObserver.toFingerprint(), skippedUnchanged };
}

/* ------------------------------------------------------------------ */
/*  JSONL parser (current format)                                     */
/* ------------------------------------------------------------------ */

export function parseJsonl(filePath: string, workspace: string): Session | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    let sessionId = '';
    let title = '';
    let creationDate = 0;
    const turns: Turn[] = [];

    let titleFound = false;

    for (const line of lines) {
        const entry = JSON.parse(line);
        const kind: number = entry.kind;
        const v = entry.v;

        _schemaObserver.observeJsonlKind(kind);

        if (kind === 0 && typeof v === 'object' && v !== null) {
            // Initialization
            _schemaObserver.observeInitKeys(Object.keys(v));
            sessionId = v.sessionId ?? path.basename(filePath, '.jsonl');
            creationDate = v.creationDate ?? 0;
        } else if (kind === 1 && typeof v === 'string' && !titleFound && v.length > 1) {
            // First non-trivial string mutation is the title
            title = v;
            titleFound = true;
        } else if (kind === 2 && Array.isArray(v)) {
            // Request array – each item is a request/response pair
            for (const req of v) {
                if (typeof req !== 'object' || req === null) { continue; }
                _schemaObserver.observeRequestKeys(Object.keys(req));
                const turn = extractTurn(req);
                if (turn && turn.user) {
                    turns.push(turn);
                }
            }
        }
    }

    if (!title && turns.length > 0) {
        title = turns[0].user.slice(0, 60);
    }

    return { sessionId, title, creationDate, workspace, turns };
}

/* ------------------------------------------------------------------ */
/*  Legacy JSON parser (older empty-window sessions)                  */
/* ------------------------------------------------------------------ */

export function parseLegacyJson(filePath: string): Session | null {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    _schemaObserver.observeLegacySessionKeys(Object.keys(data));
    const sessionId: string = data.sessionId ?? path.basename(filePath, '.json');
    const title: string = data.customTitle ?? '';
    const creationDate: number = data.creationDate ?? data.lastMessageDate ?? 0;
    const turns: Turn[] = [];

    for (const req of (data.requests ?? [])) {
        _schemaObserver.observeLegacyRequestKeys(Object.keys(req));
        const turn = extractTurn(req);
        if (turn && turn.user) {
            turns.push(turn);
        }
    }

    return { sessionId, title, creationDate, workspace: '(no workspace)', turns };
}

/* ------------------------------------------------------------------ */
/*  Extract a single turn from a request object                       */
/* ------------------------------------------------------------------ */

export function extractTurn(req: any): Turn | null {
    const msg = req.message ?? {};
    const parts: any[] = msg.parts ?? [];
    const userText = parts
        .filter((p: any) => typeof p === 'object' && p !== null && typeof p.text === 'string')
        .map((p: any) => p.text)
        .join('\n');

    const response: any[] = req.response ?? [];
    let assistantText = '';
    let thinkingText = '';

    for (const rp of response) {
        if (typeof rp !== 'object' || rp === null) { continue; }
        const rpKind: string | undefined = rp.kind;
        const value = rp.value ?? '';

        _schemaObserver.observeResponsePartKind(rpKind ?? '(no-kind)');

        if (rpKind === 'thinking') {
            if (typeof value === 'string' && value.length > 0) {
                thinkingText += value + '\n';
            }
        } else if (rpKind === 'markdownContent' || rpKind === undefined) {
            // Actual assistant response text
            if (typeof value === 'string' && value.length > 0) {
                assistantText += value;
            }
        } else if (rpKind === 'textEditGroup') {
            assistantText += '\n[code edit]\n';
        } else if (rpKind === 'inlineReference') {
            const uri = rp.inlineReference?.uri?.path ?? rp.inlineReference?.name ?? '';
            if (uri) {
                assistantText += `\`${path.basename(uri)}\``;
            }
        } else if (rpKind === 'toolInvocationSerialized') {
            const toolMsg = rp.pastTenseMessage?.value ?? rp.invocationMessage?.value ?? '';
            if (toolMsg) {
                assistantText += `\n> ${toolMsg}\n`;
            }
        } else if (rpKind === 'elicitationSerialized') {
            const message = rp.message?.value ?? rp.message ?? '';
            if (typeof message === 'string' && message.length > 0) {
                assistantText += `\n> ${message}\n`;
            }
        } else if (rpKind === 'codeblockUri') {
            const uri = rp.uri?.path ?? rp.uri ?? '';
            if (typeof uri === 'string' && uri.length > 0) {
                assistantText += `\`${path.basename(uri)}\``;
            }
        }
        // Skip mcpServersStarting, questionCarousel, undoStop, etc.
    }

    const timestamp: number = req.timestamp ?? 0;

    return {
        user: userText.trim(),
        assistant: assistantText.trim(),
        thinking: thinkingText.trim(),
        timestamp,
    };
}

/* ------------------------------------------------------------------ */
/*  Write session to disk                                             */
/* ------------------------------------------------------------------ */

export interface WriteOptions {
    /** When false, skip writing the JSON file. Defaults to true. */
    outputJson?: boolean;
    /** Prefix prepended to the workspace wiki-link in Markdown frontmatter. */
    workspacePrefix?: string;
}

export function writeSession(session: Session, backupDir: string, options?: WriteOptions): boolean {
    const dateStr = session.creationDate
        ? new Date(session.creationDate).toISOString().slice(0, 10)
        : 'undated';
    const baseSlug = slugify(session.title || session.sessionId);
    const outDir = path.join(backupDir, dateStr);

    fs.mkdirSync(outDir, { recursive: true });

    // Resolve the final slug: if a file already exists, check whether it
    // belongs to the same session (idempotent skip) or a different one
    // (collision → append a short session-id suffix).
    let slug = baseSlug;
    const jsonPath = path.join(outDir, `${slug}.json`);
    const mdPath = path.join(outDir, `${slug}.md`);

    if (fs.existsSync(jsonPath) || fs.existsSync(mdPath)) {
        let identified = false;

        // Try to identify the existing session via the JSON file
        if (fs.existsSync(jsonPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                if (existing.sessionId === session.sessionId) {
                    return false; // Same session — idempotent skip
                }
                identified = true; // JSON parsed — belongs to a different session
            } catch { /* corrupt file — fall through to MD check */ }
        }

        // Fallback: check MD header when JSON is absent or corrupt
        if (!identified && fs.existsSync(mdPath)) {
            const mdHead = fs.readFileSync(mdPath, 'utf-8').slice(0, 1024);
            if (mdHead.includes(`session_id: "${session.sessionId}"`)) {
                return false; // Same session — idempotent skip
            }
        }

        // Different session with the same slug — append session ID suffix
        const suffix = session.sessionId.slice(0, 8);
        slug = `${baseSlug}-${suffix}`;

        const altJsonPath = path.join(outDir, `${slug}.json`);
        const altMdPath = path.join(outDir, `${slug}.md`);
        if (fs.existsSync(altJsonPath) || fs.existsSync(altMdPath)) {
            return false; // Already exported with suffixed name
        }
    }

    // JSON – full fidelity (optional)
    if (options?.outputJson !== false) {
        fs.writeFileSync(
            path.join(outDir, `${slug}.json`),
            JSON.stringify(session, null, 2),
            'utf-8'
        );
    }

    // Markdown – human readable
    fs.writeFileSync(
        path.join(outDir, `${slug}.md`),
        formatMarkdown(session, options),
        'utf-8'
    );

    return true;
}

/* ------------------------------------------------------------------ */
/*  Markdown formatter                                                */
/* ------------------------------------------------------------------ */

export function formatMarkdown(session: Session, options?: WriteOptions): string {
    const lines: string[] = [];

    // YAML frontmatter for Obsidian
    lines.push('---');
    lines.push(`title: "${yamlEscape(session.title || '(untitled)')}"`);
    lines.push(`session_id: "${session.sessionId}"`);
    lines.push(`date: ${session.creationDate ? new Date(session.creationDate).toISOString() : 'unknown'}`);
    lines.push(`workspace: "[[${workspaceToWikiLink(session.workspace, options?.workspacePrefix)}]]"`);
    if (session.gitRemote) {
        lines.push(`git_remote: "${session.gitRemote}"`);
    }
    lines.push('---');
    lines.push('');
    lines.push(`# ${session.title || '(untitled)'}`);
    lines.push('');

    for (const turn of session.turns) {
        if (turn.timestamp) {
            lines.push(`*${new Date(turn.timestamp).toISOString()}*`);
            lines.push('');
        }

        if (turn.user) {
            lines.push('## User');
            lines.push('');
            lines.push(turn.user);
            lines.push('');
        }

        if (turn.thinking) {
            lines.push('<details>');
            lines.push('<summary>Thinking</summary>');
            lines.push('');
            lines.push(turn.thinking);
            lines.push('');
            lines.push('</details>');
            lines.push('');
        }

        if (turn.assistant) {
            lines.push('## Assistant');
            lines.push('');
            lines.push(turn.assistant);
            lines.push('');
        }

        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/** Escape a string for use inside a YAML double-quoted value. */
export function yamlEscape(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * Convert a workspace path to an Obsidian wiki-link target.
 * Strips the leading slash and replaces remaining slashes with hyphens.
 * e.g. "/Users/vn/ws/my-project" → "Users-vn-ws-my-project"
 */
export function workspaceToWikiLink(workspace: string, prefix?: string): string {
    const slug = workspace.replace(/^\//, '').replace(/\//g, '-');
    return prefix ? prefix + slug : slug;
}

export function readWorkspaceName(wsDir: string): string {
    try {
        const wsJson = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf-8'));
        const folder: string = wsJson.folder ?? '';
        return decodeURIComponent(folder.replace('file://', ''));
    } catch {
        return path.basename(wsDir);
    }
}

/**
 * Attempt to resolve the git remote URL for a workspace folder.
 * Returns a normalized HTTPS URL, or undefined if not a git repo.
 * Results are cached for the lifetime of the process.
 */
const _gitRemoteCache = new Map<string, string | undefined>();

export function resolveGitRemote(workspacePath: string): string | undefined {
    if (_gitRemoteCache.has(workspacePath)) {
        return _gitRemoteCache.get(workspacePath);
    }
    let result: string | undefined;
    try {
        if (fs.existsSync(workspacePath)) {
            const raw = execSync('git remote get-url origin', {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            result = normalizeGitUrl(raw);
        }
    } catch {
        // not a git repo or no origin remote
    }
    _gitRemoteCache.set(workspacePath, result);
    return result;
}

/** Convert SSH or git:// remote URLs to HTTPS form. */
export function normalizeGitUrl(url: string): string {
    // git@github.com:user/repo.git → https://github.com/user/repo
    const sshMatch = url.match(/^git@([^:]+):(.+?)(\.git)?$/);
    if (sshMatch) {
        return `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
    // Strip trailing .git from https URLs
    return url.replace(/\.git$/, '');
}

const MTIME_FILE = '_metadata.json';

export function loadMtimeMap(backupDir: string): Record<string, number> {
    const filePath = path.join(backupDir, MTIME_FILE);
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return {};
    }
}

export function saveMtimeMap(backupDir: string, map: Record<string, number>): void {
    fs.writeFileSync(path.join(backupDir, MTIME_FILE), JSON.stringify(map, null, 2), 'utf-8');
}

/**
 * Delete date-named backup folders older than `retentionDays`.
 * Only removes directories matching YYYY-MM-DD pattern.
 * Returns the number of folders deleted.
 */
export function pruneOldBackups(backupDir: string, retentionDays: number): number {
    if (retentionDays <= 0) { return 0; }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const entry of fs.readdirSync(backupDir)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) { continue; }

        const folderDate = new Date(entry + 'T00:00:00Z').getTime();
        if (isNaN(folderDate)) { continue; }

        if (folderDate < cutoff) {
            const folderPath = path.join(backupDir, entry);
            fs.rmSync(folderPath, { recursive: true, force: true });
            deleted++;
            console.log(`[copilot-sessions-keeper] pruned old backup: ${entry}`);
        }
    }

    return deleted;
}
