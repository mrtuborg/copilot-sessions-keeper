import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    exportAllSessions,
    _resetSchemaObserver,
} from '../../exporter';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function createTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a mock VS Code storage tree inside a temp dir.
 * Returns { storageRoot, backupDir }
 */
function setupMockStorage(opts: {
    jsonlFiles?: Record<string, string>;
    legacyJsonFiles?: Record<string, string>;
    workspaceJson?: string;
}): { storageRoot: string; backupDir: string } {
    const storageRoot = createTempDir('integ-storage-');
    const backupDir = createTempDir('integ-backup-');

    if (opts.jsonlFiles) {
        const wsId = 'test-workspace-hash';
        const chatDir = path.join(storageRoot, 'workspaceStorage', wsId, 'chatSessions');
        fs.mkdirSync(chatDir, { recursive: true });

        if (opts.workspaceJson) {
            fs.writeFileSync(
                path.join(storageRoot, 'workspaceStorage', wsId, 'workspace.json'),
                opts.workspaceJson, 'utf-8'
            );
        }

        for (const [name, content] of Object.entries(opts.jsonlFiles)) {
            fs.writeFileSync(path.join(chatDir, name), content, 'utf-8');
        }
    }

    if (opts.legacyJsonFiles) {
        const emptyDir = path.join(storageRoot, 'globalStorage', 'emptyWindowChatSessions');
        fs.mkdirSync(emptyDir, { recursive: true });

        for (const [name, content] of Object.entries(opts.legacyJsonFiles)) {
            fs.writeFileSync(path.join(emptyDir, name), content, 'utf-8');
        }
    }

    return { storageRoot, backupDir };
}

function cleanup(...dirs: string[]) {
    for (const d of dirs) {
        fs.rmSync(d, { recursive: true, force: true });
    }
}

describe('Integration Tests', () => {
    it('I-01: full pipeline — JSONL sessions', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
            workspaceJson: '{"folder":"file:///Users/test/project"}',
        });
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result.count, 1);

            // Check output structure: date folder with .json + .md
            const entries = fs.readdirSync(backupDir);
            assert.ok(entries.length >= 1);
            const dateFolder = entries.find(e => /^\d{4}-\d{2}-\d{2}$/.test(e));
            assert.ok(dateFolder, `Expected a date folder, got: ${entries}`);

            const files = fs.readdirSync(path.join(backupDir, dateFolder!));
            assert.ok(files.some(f => f.endsWith('.json')));
            assert.ok(files.some(f => f.endsWith('.md')));
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-02: full pipeline — legacy JSON sessions', async () => {
        const legacyContent = fs.readFileSync(path.join(FIXTURES, 'legacy-json', 'single-request.json'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            legacyJsonFiles: { 'legacy1.json': legacyContent },
        });
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result.count, 1);

            const entries = fs.readdirSync(backupDir);
            const dateFolder = entries.find(e => /^\d{4}-\d{2}-\d{2}$/.test(e));
            assert.ok(dateFolder);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-03: idempotency — second run exports 0 new sessions', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
        });
        try {
            const result1 = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result1.count, 1);

            const result2 = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result2.count, 0);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-04: mixed formats — both JSONL and legacy JSON', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const legacyContent = fs.readFileSync(path.join(FIXTURES, 'legacy-json', 'single-request.json'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
            legacyJsonFiles: { 'legacy1.json': legacyContent },
        });
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result.count, 2);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-05: schema fingerprint returned with non-empty arrays', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
        });
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            const fp = result.schemaFingerprint;
            assert.ok(fp.jsonlKinds.length > 0);
            assert.ok(fp.initKeys.length > 0);
            assert.ok(fp.requestKeys.length > 0);
            assert.ok(fp.responsePartKinds.length > 0);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-06: graceful skip on corrupt file', async () => {
        const goodContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const badContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'malformed.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: {
                'good.jsonl': goodContent,
                'bad.jsonl': badContent,
            },
        });
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            // Good session exported, bad one skipped
            assert.strictEqual(result.count, 1);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-07: empty workspace storage — returns count 0', async () => {
        const storageRoot = createTempDir('integ-empty-');
        const backupDir = createTempDir('integ-backup-empty-');
        try {
            const result = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(result.count, 0);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-08: incremental backup — unchanged files skipped on second run', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
            workspaceJson: '{"folder":"file:///Users/test/project"}',
        });
        try {
            const first = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(first.count, 1);
            assert.strictEqual(first.skippedUnchanged, 0);

            // Second run: file hasn't changed → skipped via mtime
            const second = await exportAllSessions(backupDir, storageRoot);
            assert.strictEqual(second.count, 0);
            assert.strictEqual(second.skippedUnchanged, 1);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-09: incremental backup — modified file is re-parsed', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
        });
        try {
            await exportAllSessions(backupDir, storageRoot);

            // Touch the source file to change its mtime
            const chatDir = path.join(storageRoot, 'workspaceStorage', 'test-workspace-hash', 'chatSessions');
            const sessionPath = path.join(chatDir, 'session1.jsonl');
            const now = new Date();
            fs.utimesSync(sessionPath, now, now);

            const second = await exportAllSessions(backupDir, storageRoot);
            // File was re-parsed (mtime changed), but session already
            // exists on disk so writeSession returns false → count 0
            assert.strictEqual(second.count, 0);
            assert.strictEqual(second.skippedUnchanged, 0);
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });

    it('I-10: metadata file persists across runs', async () => {
        const jsonlContent = fs.readFileSync(path.join(FIXTURES, 'jsonl', 'simple-session.jsonl'), 'utf-8');
        const { storageRoot, backupDir } = setupMockStorage({
            jsonlFiles: { 'session1.jsonl': jsonlContent },
        });
        try {
            await exportAllSessions(backupDir, storageRoot);

            const metadataPath = path.join(backupDir, '_metadata.json');
            assert.ok(fs.existsSync(metadataPath), '_metadata.json should exist');

            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            const keys = Object.keys(metadata);
            assert.strictEqual(keys.length, 1);
            assert.ok(typeof metadata[keys[0]] === 'number', 'mtime should be a number');
        } finally {
            cleanup(storageRoot, backupDir);
        }
    });
});
