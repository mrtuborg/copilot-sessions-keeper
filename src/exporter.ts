import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
}

const VSCODE_STORAGE = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Code',
    'User'
);

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
 * Export all Copilot chat sessions to dated folders.
 * Returns the count and an observed schema fingerprint.
 */
export async function exportAllSessions(backupDir: string, storageRoot?: string): Promise<ExportResult> {
    fs.mkdirSync(backupDir, { recursive: true });
    _schemaObserver = new SchemaObserver();
    let count = 0;
    const root = storageRoot ?? VSCODE_STORAGE;

    // 1. Workspace-scoped sessions (chatSessions/*.jsonl)
    const wsRoot = path.join(root, 'workspaceStorage');
    if (fs.existsSync(wsRoot)) {
        for (const wsId of fs.readdirSync(wsRoot)) {
            const wsDir = path.join(wsRoot, wsId);
            const chatDir = path.join(wsDir, 'chatSessions');
            if (!fs.existsSync(chatDir)) { continue; }

            const workspace = readWorkspaceName(wsDir);

            for (const file of fs.readdirSync(chatDir)) {
                if (!file.endsWith('.jsonl')) { continue; }
                try {
                    const session = parseJsonl(path.join(chatDir, file), workspace);
                    if (session && session.turns.length > 0) {
                        writeSession(session, backupDir);
                        count++;
                    }
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
                let session: Session | null = null;
                if (file.endsWith('.json')) {
                    session = parseLegacyJson(filePath);
                } else if (file.endsWith('.jsonl')) {
                    session = parseJsonl(filePath, '(no workspace)');
                }
                if (session && session.turns.length > 0) {
                    writeSession(session, backupDir);
                    count++;
                }
            } catch (e) {
                console.warn(`[copilot-sessions-keeper] skipped ${file}: ${e}`);
            }
        }
    }

    return { count, schemaFingerprint: _schemaObserver.toFingerprint() };
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
        }
        // Skip mcpServersStarting, progressMessage, etc.
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

export function writeSession(session: Session, backupDir: string): void {
    const dateStr = session.creationDate
        ? new Date(session.creationDate).toISOString().slice(0, 10)
        : 'undated';
    const slug = slugify(session.title || session.sessionId);
    const outDir = path.join(backupDir, dateStr);

    fs.mkdirSync(outDir, { recursive: true });

    const jsonPath = path.join(outDir, `${slug}.json`);

    // If file already exists, skip (idempotent)
    if (fs.existsSync(jsonPath)) { return; }

    // JSON – full fidelity
    fs.writeFileSync(
        jsonPath,
        JSON.stringify(session, null, 2),
        'utf-8'
    );

    // Markdown – human readable
    fs.writeFileSync(
        path.join(outDir, `${slug}.md`),
        formatMarkdown(session),
        'utf-8'
    );
}

/* ------------------------------------------------------------------ */
/*  Markdown formatter                                                */
/* ------------------------------------------------------------------ */

export function formatMarkdown(session: Session): string {
    const lines: string[] = [];
    lines.push(`# ${session.title || '(untitled)'}`);
    lines.push('');
    lines.push(`**Workspace:** ${session.workspace}`);
    lines.push(`**Date:** ${session.creationDate ? new Date(session.creationDate).toISOString() : 'unknown'}`);
    lines.push(`**Session ID:** ${session.sessionId}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const turn of session.turns) {
        if (turn.user) {
            lines.push('## User');
            lines.push('');
            lines.push(turn.user);
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

export function readWorkspaceName(wsDir: string): string {
    try {
        const wsJson = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf-8'));
        const folder: string = wsJson.folder ?? '';
        return decodeURIComponent(folder.replace('file://', ''));
    } catch {
        return path.basename(wsDir);
    }
}
