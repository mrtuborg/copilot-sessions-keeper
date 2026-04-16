import * as vscode from 'vscode';
import {
    exportAllSessions,
    fingerprintToString,
    diffFingerprints,
    diffFingerprintsAdditionsOnly,
    mergeFingerprints,
    updateUsageStats,
    emptyUsageStats,
    formatUsageStats,
    pruneOldBackups,
    type SchemaFingerprint,
    type SchemaUsageStats,
    type ExportResult,
    type WriteOptions,
} from './exporter';
import * as path from 'path';
import * as os from 'os';

const SCHEMA_STATE_KEY = 'knownSchemaFingerprint';
const SCHEMA_USAGE_KEY = 'schemaUsageStats';

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('copilotSessionsKeeper');
    const enabled = config.get<boolean>('enabled', true);

    // Register manual command
    context.subscriptions.push(
        vscode.commands.registerCommand('copilotSessionsKeeper.backupNow', async () => {
            const backupDir = getBackupDir();
            await runBackup(context, backupDir, 'manual');
        })
    );

    // Auto-backup on first session of the day
    if (enabled) {
        const tryDailyBackup = () => {
            const lastBackup = context.globalState.get<string>('lastBackupDate');
            const today = new Date().toISOString().slice(0, 10);

            if (lastBackup !== today) {
                const backupDir = getBackupDir();
                runBackup(context, backupDir, 'auto').then(async (count) => {
                    if (count > 0) {
                        await context.globalState.update('lastBackupDate', today);
                        vscode.window.showInformationMessage(
                            `Copilot Sessions Keeper: exported ${count} sessions to ${backupDir}`
                        );
                    }
                });
            }
        };

        // Run immediately on activation
        tryDailyBackup();

        // Re-check every hour for long-running sessions that span midnight
        const timer = setInterval(tryDailyBackup, 60 * 60 * 1000);
        context.subscriptions.push({ dispose: () => clearInterval(timer) });
    }
}

function getBackupDir(): string {
    const config = vscode.workspace.getConfiguration('copilotSessionsKeeper');
    const configured = config.get<string>('backupDir', '');
    if (configured) {
        return configured.replace(/^~/, os.homedir());
    }
    return path.join(os.homedir(), 'copilot-sessions-keeper');
}

async function runBackup(context: vscode.ExtensionContext, backupDir: string, trigger: string): Promise<number> {
    try {
        const outputJson = vscode.workspace.getConfiguration('copilotSessionsKeeper')
            .get<boolean>('outputJson', true);
        const result: ExportResult = await exportAllSessions(backupDir, undefined, { outputJson });
        console.log(`[copilot-sessions-keeper] ${trigger}: exported ${result.count} sessions, skipped ${result.skippedUnchanged} unchanged`);

        // Schema change detection — only when files were actually parsed
        // (if all files were skipped via mtime, the fingerprint is empty
        // and would falsely report "everything removed")
        const fp = result.schemaFingerprint;
        const hasParsedData = fp.jsonlKinds.length > 0 || fp.legacySessionKeys.length > 0;
        if (hasParsedData) {
            await checkSchemaChange(context, fp, backupDir);
        }

        // Retention policy
        const retentionDays = vscode.workspace.getConfiguration('copilotSessionsKeeper')
            .get<number>('retentionDays', 0);
        if (retentionDays > 0) {
            const deleted = pruneOldBackups(backupDir, retentionDays);
            if (deleted > 0) {
                console.log(`[copilot-sessions-keeper] pruned ${deleted} old backup folder(s)`);
            }
        }

        return result.count;
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[copilot-sessions-keeper] ${trigger} backup failed:`, msg);
        vscode.window.showErrorMessage(`Copilot Sessions Keeper failed: ${msg}`);
        return 0;
    }
}

/**
 * Compare the observed schema fingerprint against the stored one.
 * On first run, store it silently. On change, warn the user and
 * write a diff report to the backup directory.
 *
 * The stored fingerprint is a monotonic union across all runs.
 * Only genuinely new keys/kinds trigger an alert — keys absent
 * from a single run are not treated as removals (a partial run
 * may not observe every possible field).
 */
async function checkSchemaChange(
    context: vscode.ExtensionContext,
    current: SchemaFingerprint,
    backupDir: string
): Promise<void> {
    const stored = context.globalState.get<SchemaFingerprint>(SCHEMA_STATE_KEY);
    const today = new Date().toISOString().slice(0, 10);

    // Update per-key usage stats (always, even on first run)
    const prevStats = context.globalState.get<SchemaUsageStats>(SCHEMA_USAGE_KEY) ?? emptyUsageStats();
    const updatedStats = updateUsageStats(prevStats, current, today);
    await context.globalState.update(SCHEMA_USAGE_KEY, updatedStats);

    if (!stored) {
        // First run — save baseline
        await context.globalState.update(SCHEMA_STATE_KEY, current);
        console.log('[copilot-sessions-keeper] Schema fingerprint baseline stored');
        return;
    }

    // Only additions matter — removals could just be a partial observation
    const additions = diffFingerprintsAdditionsOnly(stored, current);

    // Always merge current observations into the stored baseline so it
    // grows monotonically (keys seen once are remembered forever).
    const merged = mergeFingerprints(stored, current);
    await context.globalState.update(SCHEMA_STATE_KEY, merged);

    if (!additions) {
        return; // No new keys/kinds
    }

    // Schema expanded — build a diff report
    const reportPath = path.join(backupDir, `schema-change-${today}.txt`);
    const report = [
        'Copilot Sessions Keeper — Data Model Change Detected',
        `Date: ${new Date().toISOString()}`,
        '',
        'The structure of VS Code chat session files has changed',
        '(likely after a VS Code or Copilot Chat extension update).',
        '',
        'The backup extension may need updating to handle new fields',
        'or format changes. Review the changes below:',
        '',
        '=== NEW KEYS/KINDS ===',
        additions,
        '',
        '=== FULL DIFF (including removals from this run, possibly just partial observation) ===',
        diffFingerprints(stored, current) ?? '(none)',
        '',
        '=== KEY USAGE STATS (lastSeen, observation count) ===',
        formatUsageStats(updatedStats),
        '',
        '=== PREVIOUS FINGERPRINT ===',
        JSON.stringify(stored, null, 2),
        '',
        '=== CURRENT FINGERPRINT (this run) ===',
        JSON.stringify(current, null, 2),
        '',
        '=== MERGED FINGERPRINT (stored) ===',
        JSON.stringify(merged, null, 2),
    ].join('\n');

    const fs = await import('fs');
    fs.writeFileSync(reportPath, report, 'utf-8');

    const action = await vscode.window.showWarningMessage(
        'Copilot Sessions Keeper: New keys detected in chat data model! ' +
        'The backup parser may need updating. See the report for details.',
        'Open Report',
        'Dismiss'
    );

    if (action === 'Open Report') {
        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc);
    }
}

export function deactivate() {}
