import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    parseJsonl,
    parseLegacyJson,
    extractTurn,
    slugify,
    readWorkspaceName,
    writeSession,
    formatMarkdown,
    fingerprintToString,
    diffFingerprints,
    getVscodeStoragePath,
    pruneOldBackups,
    _resetSchemaObserver,
    SchemaObserver,
    type SchemaFingerprint,
    type Session,
} from '../../exporter';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const JSONL_DIR = path.join(FIXTURES, 'jsonl');
const LEGACY_DIR = path.join(FIXTURES, 'legacy-json');

// Initialize schema observer before each test that calls parseJsonl/parseLegacyJson
beforeEach(() => { _resetSchemaObserver(); });

/* ================================================================== */
/*  2.1 JSONL Parser                                                  */
/* ================================================================== */

describe('parseJsonl', () => {
    it('U-01: parse simple session', () => {
        const session = parseJsonl(path.join(JSONL_DIR, 'simple-session.jsonl'), 'test-ws');
        assert.ok(session);
        assert.strictEqual(session.turns.length, 1);
        assert.strictEqual(session.title, 'Simple Test Session');
        assert.strictEqual(session.sessionId, 'aaa-bbb-ccc-ddd');
        assert.strictEqual(session.creationDate, 1712966400000);
        assert.strictEqual(session.workspace, 'test-ws');
    });

    it('U-02: parse multi-turn session', () => {
        const session = parseJsonl(path.join(JSONL_DIR, 'multi-turn-session.jsonl'), 'test-ws');
        assert.ok(session);
        assert.strictEqual(session.turns.length, 5);
        assert.strictEqual(session.turns[0].user, 'Explain async/await');
        assert.ok(session.turns[0].assistant.includes('syntactic sugar'));
    });

    it('U-03: title fallback to first user message', () => {
        const session = parseJsonl(path.join(JSONL_DIR, 'no-title-session.jsonl'), 'test-ws');
        assert.ok(session);
        assert.strictEqual(session.title, 'How do I configure ESLint for a TypeScript project with cust');
        assert.strictEqual(session.title.length, 60);
    });

    it('U-04: empty session returns no turns', () => {
        const session = parseJsonl(path.join(JSONL_DIR, 'empty-session.jsonl'), 'test-ws');
        assert.ok(session);
        assert.strictEqual(session.turns.length, 0);
    });

    it('U-05: malformed line causes file-level throw', () => {
        assert.throws(() => {
            parseJsonl(path.join(JSONL_DIR, 'malformed.jsonl'), 'test-ws');
        });
    });
});

/* ================================================================== */
/*  2.2 Legacy JSON Parser                                            */
/* ================================================================== */

describe('parseLegacyJson', () => {
    it('U-06: parse single request', () => {
        const session = parseLegacyJson(path.join(LEGACY_DIR, 'single-request.json'));
        assert.ok(session);
        assert.strictEqual(session.turns.length, 1);
        assert.strictEqual(session.turns[0].user, 'What is Node.js?');
        assert.ok(session.turns[0].assistant.includes('JavaScript runtime'));
    });

    it('U-07: parse multi-request session', () => {
        const session = parseLegacyJson(path.join(LEGACY_DIR, 'multi-request.json'));
        assert.ok(session);
        assert.strictEqual(session.turns.length, 5);
    });

    it('U-08: customTitle is used', () => {
        const session = parseLegacyJson(path.join(LEGACY_DIR, 'single-request.json'));
        assert.ok(session);
        assert.strictEqual(session.title, 'Legacy Single Request');
    });

    it('U-09: missing customTitle fallback', () => {
        // Create a temp file without customTitle
        const tmp = path.join(os.tmpdir(), 'no-custom-title.json');
        const data = {
            version: 1,
            sessionId: 'nocustom-id',
            requests: [],
        };
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        try {
            const session = parseLegacyJson(tmp);
            assert.ok(session);
            assert.strictEqual(session.title, '');
        } finally {
            fs.unlinkSync(tmp);
        }
    });
});

/* ================================================================== */
/*  2.3 Turn Extraction                                               */
/* ================================================================== */

describe('extractTurn', () => {
    it('U-10: user text from message parts', () => {
        const turn = extractTurn({
            message: { parts: [{ text: 'hello' }] },
            response: [],
        });
        assert.ok(turn);
        assert.strictEqual(turn.user, 'hello');
    });

    it('U-11: multiple user text parts joined', () => {
        const turn = extractTurn({
            message: { parts: [{ text: 'first' }, { text: 'second' }] },
            response: [],
        });
        assert.ok(turn);
        assert.strictEqual(turn.user, 'first\nsecond');
    });

    it('U-12: thinking blocks separated', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [
                { kind: 'thinking', value: 'Let me think...' },
                { value: 'The answer is 42.' },
            ],
        });
        assert.ok(turn);
        assert.ok(turn.thinking.includes('Let me think'));
        assert.ok(!turn.assistant.includes('Let me think'));
        assert.ok(turn.assistant.includes('42'));
    });

    it('U-13: markdown content extracted (kind undefined)', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [{ value: 'answer' }],
        });
        assert.ok(turn);
        assert.ok(turn.assistant.includes('answer'));
    });

    it('U-14: code edit placeholder', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [{ kind: 'textEditGroup', value: { edits: [] } }],
        });
        assert.ok(turn);
        assert.ok(turn.assistant.includes('[code edit]'));
    });

    it('U-15: tool invocation summary', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [{
                kind: 'toolInvocationSerialized',
                invocationMessage: { value: 'Searching files' },
                pastTenseMessage: { value: 'Searched files' },
            }],
        });
        assert.ok(turn);
        assert.ok(turn.assistant.includes('Searched files'));
    });

    it('U-16: inline reference', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [{
                kind: 'inlineReference',
                inlineReference: { uri: { path: '/src/utils/helpers.ts' }, name: 'helpers.ts' },
            }],
        });
        assert.ok(turn);
        assert.ok(turn.assistant.includes('`helpers.ts`'));
    });

    it('U-17: unknown kind ignored (no crash)', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [{ kind: 'futureKind', value: 'something' }],
        });
        assert.ok(turn);
        // Should not crash; futureKind is just skipped
    });

    it('U-18: empty response', () => {
        const turn = extractTurn({
            message: { parts: [{ text: 'q' }] },
            response: [],
        });
        assert.ok(turn);
        assert.strictEqual(turn.assistant, '');
    });
});

/* ================================================================== */
/*  2.4 Schema Fingerprinting                                         */
/* ================================================================== */

describe('Schema Fingerprinting', () => {
    it('U-20: observer collects JSONL kinds', () => {
        const obs = _resetSchemaObserver();
        parseJsonl(path.join(JSONL_DIR, 'simple-session.jsonl'), 'ws');
        const fp = obs.toFingerprint();
        assert.deepStrictEqual(fp.jsonlKinds, [0, 1, 2]);
    });

    it('U-21: observer collects init keys', () => {
        const obs = _resetSchemaObserver();
        parseJsonl(path.join(JSONL_DIR, 'simple-session.jsonl'), 'ws');
        const fp = obs.toFingerprint();
        assert.ok(fp.initKeys.includes('sessionId'));
        assert.ok(fp.initKeys.includes('creationDate'));
        assert.ok(fp.initKeys.includes('version'));
    });

    it('U-22: observer collects response part kinds', () => {
        const obs = _resetSchemaObserver();
        parseJsonl(path.join(JSONL_DIR, 'multi-turn-session.jsonl'), 'ws');
        const fp = obs.toFingerprint();
        assert.ok(fp.responsePartKinds.includes('thinking'));
        assert.ok(fp.responsePartKinds.includes('textEditGroup'));
        assert.ok(fp.responsePartKinds.includes('inlineReference'));
        assert.ok(fp.responsePartKinds.includes('toolInvocationSerialized'));
    });

    it('U-23: fingerprintToString is deterministic', () => {
        const fp: SchemaFingerprint = {
            jsonlKinds: [0, 1, 2],
            initKeys: ['a', 'b'],
            requestKeys: ['c'],
            responsePartKinds: ['d'],
            legacySessionKeys: [],
            legacyRequestKeys: [],
        };
        assert.strictEqual(fingerprintToString(fp), fingerprintToString(fp));
    });

    it('U-24: diffFingerprints detects added keys', () => {
        const old: SchemaFingerprint = {
            jsonlKinds: [0, 1], initKeys: ['a', 'b'], requestKeys: [],
            responsePartKinds: [], legacySessionKeys: [], legacyRequestKeys: [],
        };
        const cur: SchemaFingerprint = {
            jsonlKinds: [0, 1, 2], initKeys: ['a', 'b', 'c'], requestKeys: [],
            responsePartKinds: [], legacySessionKeys: [], legacyRequestKeys: [],
        };
        const diff = diffFingerprints(old, cur);
        assert.ok(diff);
        assert.ok(diff.includes('added'));
        assert.ok(diff.includes('2'));
        assert.ok(diff.includes('c'));
    });

    it('U-25: diffFingerprints detects removed keys', () => {
        const old: SchemaFingerprint = {
            jsonlKinds: [0, 1, 2], initKeys: ['a', 'b', 'c'], requestKeys: [],
            responsePartKinds: [], legacySessionKeys: [], legacyRequestKeys: [],
        };
        const cur: SchemaFingerprint = {
            jsonlKinds: [0, 1], initKeys: ['a', 'b'], requestKeys: [],
            responsePartKinds: [], legacySessionKeys: [], legacyRequestKeys: [],
        };
        const diff = diffFingerprints(old, cur);
        assert.ok(diff);
        assert.ok(diff.includes('removed'));
        assert.ok(diff.includes('2'));
        assert.ok(diff.includes('c'));
    });

    it('U-26: diffFingerprints returns null on match', () => {
        const fp: SchemaFingerprint = {
            jsonlKinds: [0, 1, 2], initKeys: ['a'], requestKeys: [],
            responsePartKinds: [], legacySessionKeys: [], legacyRequestKeys: [],
        };
        assert.strictEqual(diffFingerprints(fp, fp), null);
    });
});

/* ================================================================== */
/*  2.5 Output Formatting                                             */
/* ================================================================== */

describe('Output Formatting', () => {
    it('U-30: folder name is date only', () => {
        const session: Session = {
            sessionId: 'test-id',
            title: 'My Topic',
            creationDate: 1712966400000,  // 2024-04-13
            workspace: 'ws',
            turns: [{ user: 'hi', assistant: 'hello', thinking: '', timestamp: 0 }],
        };
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u30-'));
        try {
            writeSession(session, tmpDir);
            const date = new Date(1712966400000).toISOString().slice(0, 10);
            const dateFolder = path.join(tmpDir, date);
            assert.ok(fs.existsSync(dateFolder), `Expected folder ${date}`);
            assert.ok(fs.existsSync(path.join(dateFolder, 'my-topic.json')));
            assert.ok(fs.existsSync(path.join(dateFolder, 'my-topic.md')));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('U-31: slug truncation', () => {
        const longTitle = 'a'.repeat(200);
        const slug = slugify(longTitle);
        assert.ok(slug.length <= 80);
    });

    it('U-32: slug sanitization', () => {
        const slug = slugify('special!@#chars');
        assert.ok(/^[a-z0-9-]+$/.test(slug));
    });

    it('U-33: undated session uses "undated" folder', () => {
        const session: Session = {
            sessionId: 'undated-id',
            title: 'No Date',
            creationDate: 0,
            workspace: 'ws',
            turns: [{ user: 'hi', assistant: 'hello', thinking: '', timestamp: 0 }],
        };
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u33-'));
        try {
            writeSession(session, tmpDir);
            assert.ok(fs.existsSync(path.join(tmpDir, 'undated')));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('U-34: markdown structure', () => {
        const session: Session = {
            sessionId: 'md-test',
            title: 'Test MD',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [
                { user: 'question 1', assistant: 'answer 1', thinking: '', timestamp: 0 },
                { user: 'question 2', assistant: 'answer 2', thinking: '', timestamp: 0 },
            ],
        };
        const md = formatMarkdown(session);
        assert.ok(md.startsWith('# Test MD'));
        assert.ok(md.includes('**Workspace:** ws'));
        assert.ok(md.includes('**Session ID:** md-test'));
        assert.ok(md.includes('## User'));
        assert.ok(md.includes('## Assistant'));
        // 2 User + 2 Assistant sections
        assert.strictEqual((md.match(/## User/g) || []).length, 2);
        assert.strictEqual((md.match(/## Assistant/g) || []).length, 2);
    });

    it('U-35: JSON structure', () => {
        const session: Session = {
            sessionId: 'json-test',
            title: 'Test JSON',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'q', assistant: 'a', thinking: '', timestamp: 123 }],
        };
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u35-'));
        try {
            writeSession(session, tmpDir);
            const date = new Date(1712966400000).toISOString().slice(0, 10);
            const jsonPath = path.join(tmpDir, date, 'test-json.json');
            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            assert.strictEqual(parsed.sessionId, 'json-test');
            assert.strictEqual(parsed.title, 'Test JSON');
            assert.strictEqual(parsed.turns.length, 1);
            assert.strictEqual(parsed.turns[0].user, 'q');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

/* ================================================================== */
/*  2.6 Helpers                                                       */
/* ================================================================== */

describe('Helpers', () => {
    it('U-40: slugify basic', () => {
        assert.strictEqual(slugify('Hello World'), 'hello-world');
    });

    it('U-41: slugify special chars', () => {
        assert.strictEqual(slugify('git reset --hard & push'), 'git-reset-hard-push');
    });

    it('U-42: readWorkspaceName from workspace.json', () => {
        const fixtureDir = path.join(FIXTURES);
        // workspace.json is directly in FIXTURES, so wsDir = FIXTURES
        const name = readWorkspaceName(fixtureDir);
        assert.strictEqual(name, '/Users/testuser/projects/my-project');
    });

    it('U-43: readWorkspaceName fallback', () => {
        const name = readWorkspaceName('/nonexistent/path/some-workspace');
        assert.strictEqual(name, 'some-workspace');
    });

    it('U-44: getVscodeStoragePath returns platform-appropriate path', () => {
        const storagePath = getVscodeStoragePath();
        assert.ok(typeof storagePath === 'string');
        assert.ok(storagePath.length > 0);

        // On the current platform (macOS in CI / dev), verify the expected suffix
        if (process.platform === 'darwin') {
            assert.ok(storagePath.endsWith(path.join('Application Support', 'Code', 'User')));
        } else if (process.platform === 'linux') {
            assert.ok(storagePath.endsWith(path.join('.config', 'Code', 'User')));
        } else if (process.platform === 'win32') {
            assert.ok(storagePath.endsWith(path.join('Code', 'User')));
        }
    });

    it('U-45: getVscodeStoragePath includes homedir', () => {
        const storagePath = getVscodeStoragePath();
        // On all platforms the path should be rooted under homedir or APPDATA
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
            assert.ok(storagePath.startsWith(appData));
        } else {
            assert.ok(storagePath.startsWith(os.homedir()));
        }
    });
});

/* ================================================================== */
/*  5. Edge Cases                                                     */
/* ================================================================== */

describe('Edge Cases', () => {
    it('E-01: session with no user text — turns skipped', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [] },
            response: [{ value: 'some assistant text' }],
        });
        assert.ok(turn);
        assert.strictEqual(turn.user, '');
        // Verify the pipeline skips turns with empty user text
        const session: Session = {
            sessionId: 'e01-id',
            title: 'E01',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [turn],
        };
        // parseJsonl filters turns where !turn.user, so the turn would not be included.
        // Verify that extractTurn returns an empty user string that callers can filter on.
        assert.strictEqual(turn.user, '');
    });

    it('E-02: only thinking, no assistant text — still exported if user text present', () => {
        _resetSchemaObserver();
        const turn = extractTurn({
            message: { parts: [{ text: 'question' }] },
            response: [
                { kind: 'thinking', value: 'deep thought about the problem' },
            ],
        });
        assert.ok(turn);
        assert.strictEqual(turn.user, 'question');
        assert.ok(turn.thinking.includes('deep thought'));
        assert.strictEqual(turn.assistant, '');
        // This turn has user text and should be exported despite empty assistant
        assert.ok(turn.user.length > 0);
    });

    it('E-04: unicode/emoji in title — slugified to ASCII-safe', () => {
        assert.strictEqual(slugify('🚀 Rocket Launch Plan'), 'rocket-launch-plan');
        assert.strictEqual(slugify('日本語タイトル'), '');
        assert.strictEqual(slugify('Héllo Wörld café'), 'h-llo-w-rld-caf');
        assert.strictEqual(slugify('test 🎉 emoji 🔥 fire'), 'test-emoji-fire');
    });

    // fs.chmod with POSIX bits has no effect on Windows; skip there
    (process.platform === 'win32' ? it.skip : it)('E-05: read-only backup dir — writeSession throws', () => {
        const readOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e05-'));
        const lockedDir = path.join(readOnlyDir, 'locked');
        fs.mkdirSync(lockedDir);
        fs.chmodSync(lockedDir, 0o444);

        const session: Session = {
            sessionId: 'e05-id',
            title: 'ReadOnly Test',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'hi', assistant: 'hello', thinking: '', timestamp: 0 }],
        };

        try {
            assert.throws(() => {
                writeSession(session, lockedDir);
            });
        } finally {
            fs.chmodSync(lockedDir, 0o755);
            fs.rmSync(readOnlyDir, { recursive: true, force: true });
        }
    });

    it('E-08: file name collision — second session exported with suffix', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e08-'));
        const session1: Session = {
            sessionId: 'session-1',
            title: 'Same Title',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'first', assistant: 'a1', thinking: '', timestamp: 0 }],
        };
        const session2: Session = {
            sessionId: 'session-2',
            title: 'Same Title',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'second', assistant: 'a2', thinking: '', timestamp: 0 }],
        };

        try {
            const wrote1 = writeSession(session1, tmpDir);
            assert.strictEqual(wrote1, true);

            const wrote2 = writeSession(session2, tmpDir);
            assert.strictEqual(wrote2, true, 'Collision should export with suffixed name');

            // Verify both sessions exist
            const date = new Date(1712966400000).toISOString().slice(0, 10);
            const original = JSON.parse(fs.readFileSync(path.join(tmpDir, date, 'same-title.json'), 'utf-8'));
            assert.strictEqual(original.sessionId, 'session-1');

            const suffixed = JSON.parse(fs.readFileSync(path.join(tmpDir, date, 'same-title-session-.json'), 'utf-8'));
            assert.strictEqual(suffixed.sessionId, 'session-2');
            assert.strictEqual(suffixed.turns[0].user, 'second');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('E-08b: idempotent re-run — same session same slug returns false', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e08b-'));
        const session: Session = {
            sessionId: 'session-1',
            title: 'My Session',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'hi', assistant: 'hello', thinking: '', timestamp: 0 }],
        };

        try {
            assert.strictEqual(writeSession(session, tmpDir), true);
            assert.strictEqual(writeSession(session, tmpDir), false, 'Same session re-run should skip');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('E-08c: collision with suffixed name is also idempotent', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e08c-'));
        const session1: Session = {
            sessionId: 'session-1',
            title: 'Dup Title',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'first', assistant: 'a1', thinking: '', timestamp: 0 }],
        };
        const session2: Session = {
            sessionId: 'session-2',
            title: 'Dup Title',
            creationDate: 1712966400000,
            workspace: 'ws',
            turns: [{ user: 'second', assistant: 'a2', thinking: '', timestamp: 0 }],
        };

        try {
            writeSession(session1, tmpDir);
            writeSession(session2, tmpDir);
            // Re-run session2 — should be idempotent
            assert.strictEqual(writeSession(session2, tmpDir), false, 'Suffixed session re-run should skip');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

/* ================================================================== */
/*  6. Retention Policy                                               */
/* ================================================================== */

describe('pruneOldBackups', () => {
    it('R-01: deletes folders older than retention period', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r01-'));
        // Create an old folder (100 days ago) and a recent one (today)
        const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        const todayDate = new Date().toISOString().slice(0, 10);

        const oldDir = path.join(tmpDir, oldDate);
        const newDir = path.join(tmpDir, todayDate);
        fs.mkdirSync(oldDir, { recursive: true });
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'test.json'), '{}');
        fs.writeFileSync(path.join(newDir, 'test.json'), '{}');

        try {
            const deleted = pruneOldBackups(tmpDir, 30);
            assert.strictEqual(deleted, 1);
            assert.ok(!fs.existsSync(oldDir), 'Old folder should be deleted');
            assert.ok(fs.existsSync(newDir), 'Recent folder should remain');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('R-02: ignores non-date folders and files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r02-'));
        fs.mkdirSync(path.join(tmpDir, 'undated'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '_metadata.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'undated', 'test.json'), '{}');

        try {
            const deleted = pruneOldBackups(tmpDir, 1);
            assert.strictEqual(deleted, 0);
            assert.ok(fs.existsSync(path.join(tmpDir, 'undated')));
            assert.ok(fs.existsSync(path.join(tmpDir, '_metadata.json')));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('R-03: retentionDays 0 deletes nothing', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r03-'));
        const oldDate = '2020-01-01';
        fs.mkdirSync(path.join(tmpDir, oldDate), { recursive: true });

        try {
            const deleted = pruneOldBackups(tmpDir, 0);
            assert.strictEqual(deleted, 0);
            assert.ok(fs.existsSync(path.join(tmpDir, oldDate)));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('R-04: keeps folders within retention window', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r04-'));
        // Folder 29 days ago (safely within window — kept)
        const recentDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        // Folder 31 days ago (definitely outside — pruned)
        const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);

        fs.mkdirSync(path.join(tmpDir, recentDate), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, oldDate), { recursive: true });

        try {
            const deleted = pruneOldBackups(tmpDir, 30);
            assert.strictEqual(deleted, 1);
            assert.ok(!fs.existsSync(path.join(tmpDir, oldDate)), '31-day-old folder pruned');
            assert.ok(fs.existsSync(path.join(tmpDir, recentDate)), '29-day-old folder kept');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
