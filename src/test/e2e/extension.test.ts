import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    exportAllSessions,
    _resetSchemaObserver,
} from '../../exporter';

/**
 * E2E tests for the Copilot Sessions Keeper extension.
 *
 * These tests run inside the VS Code Extension Host and validate
 * activation, commands, configuration, and schema-change behaviour.
 *
 * The test runner (runTest.ts) pre-populates a mock VS Code storage
 * tree with fixture session data and passes the path via the
 * CSK_TEST_STORAGE_ROOT environment variable.
 */

const STORAGE_ROOT = process.env.CSK_TEST_STORAGE_ROOT ?? '';

function createTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

suite('E2E: Extension Lifecycle', () => {

    // ── M-01 ────────────────────────────────────────────────────
    test('M-01: auto-backup on first day launch — sessions exported', async () => {
        // Simulate a fresh backup run (no lastBackupDate) against the
        // pre-populated mock storage.  We call exportAllSessions directly
        // because the extension has already activated by the time the
        // test suite runs.
        const backupDir = createTempDir('m01-');
        try {
            const result = await exportAllSessions(backupDir, STORAGE_ROOT);
            assert.ok(result.count > 0, `Expected exported sessions, got ${result.count}`);

            // Verify date-folder + .json + .md structure
            const entries = fs.readdirSync(backupDir);
            const dateFolder = entries.find(e => /^\d{4}-\d{2}-\d{2}$/.test(e));
            assert.ok(dateFolder, `Expected a date folder, got: ${entries}`);

            const files = fs.readdirSync(path.join(backupDir, dateFolder!));
            assert.ok(files.some(f => f.endsWith('.json')), 'Missing .json file');
            assert.ok(files.some(f => f.endsWith('.md')), 'Missing .md file');
        } finally {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }
    });

    // ── M-02 ────────────────────────────────────────────────────
    test('M-02: no duplicate backup same day — second run exports 0', async () => {
        const backupDir = createTempDir('m02-');
        try {
            const first = await exportAllSessions(backupDir, STORAGE_ROOT);
            assert.ok(first.count > 0);

            const second = await exportAllSessions(backupDir, STORAGE_ROOT);
            assert.strictEqual(second.count, 0, 'Second run should export 0 (idempotent)');
        } finally {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }
    });

    // ── M-03 ────────────────────────────────────────────────────
    test('M-03: manual backup command is registered and executable', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('copilotSessionsKeeper.backupNow'),
            'backupNow command should be registered'
        );

        // Execute the command — it should not throw.
        // (Without sessions at the hardcoded VSCODE_STORAGE path the
        // count may be 0, but the command completes without error.)
        await vscode.commands.executeCommand('copilotSessionsKeeper.backupNow');
    });

    // ── M-04 ────────────────────────────────────────────────────
    test('M-04: schema fingerprint is produced after export', async () => {
        const backupDir = createTempDir('m04-');
        try {
            const result = await exportAllSessions(backupDir, STORAGE_ROOT);
            const fp = result.schemaFingerprint;
            assert.ok(fp.jsonlKinds.length > 0, 'Expected JSONL kinds');
            assert.ok(fp.initKeys.length > 0, 'Expected init keys');
            assert.ok(fp.responsePartKinds.length > 0, 'Expected response part kinds');
        } finally {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }
    });

    // ── M-05 / M-06 ────────────────────────────────────────────
    // Schema alert UI interactions (Accept / Open Report) require
    // clicking notification buttons which cannot be automated via
    // the VS Code API.  These remain manual tests — run them via
    // the Extension Development Host (F5) and follow the steps in
    // docs/test-spec.md §4 (M-04 through M-06).

    // ── M-07 ────────────────────────────────────────────────────
    test('M-07: custom backup dir from configuration', async () => {
        const customDir = createTempDir('m07-custom-');
        const config = vscode.workspace.getConfiguration('copilotSessionsKeeper');

        // Save original value
        const original = config.get<string>('backupDir');

        try {
            await config.update('backupDir', customDir, vscode.ConfigurationTarget.Global);

            // Read back to confirm setting took effect
            const updated = vscode.workspace.getConfiguration('copilotSessionsKeeper');
            assert.strictEqual(updated.get<string>('backupDir'), customDir);

            // Run export directly to the custom dir with mock storage
            const result = await exportAllSessions(customDir, STORAGE_ROOT);
            assert.ok(result.count > 0, 'Expected exported sessions with custom dir');
            assert.ok(fs.readdirSync(customDir).length > 0, 'Custom dir should have output');
        } finally {
            // Restore original
            await config.update('backupDir', original, vscode.ConfigurationTarget.Global);
            fs.rmSync(customDir, { recursive: true, force: true });
        }
    });

    // ── M-08 ────────────────────────────────────────────────────
    test('M-08: disabled extension — enabled flag is respected', async () => {
        const config = vscode.workspace.getConfiguration('copilotSessionsKeeper');
        const originalEnabled = config.get<boolean>('enabled');

        try {
            await config.update('enabled', false, vscode.ConfigurationTarget.Global);

            // Verify the setting reads back as false
            const updated = vscode.workspace.getConfiguration('copilotSessionsKeeper');
            assert.strictEqual(updated.get<boolean>('enabled'), false);

            // When disabled, the activate() function skips automatic
            // backup.  We verify the configuration value is available
            // for the extension to check.  Full activation-path testing
            // requires a window reload (manual).
        } finally {
            await config.update('enabled', originalEnabled, vscode.ConfigurationTarget.Global);
        }
    });
});
