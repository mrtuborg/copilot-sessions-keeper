import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

/**
 * Pre-populate a mock VS Code storage tree with fixture session data
 * so the extension has sessions to export during E2E tests.
 */
function setupMockStorage(userDataDir: string, fixturesDir: string): void {
    // Workspace-scoped sessions: workspaceStorage/<hash>/chatSessions/*.jsonl
    const wsId = 'e2e-test-workspace';
    const chatDir = path.join(userDataDir, 'User', 'workspaceStorage', wsId, 'chatSessions');
    fs.mkdirSync(chatDir, { recursive: true });

    fs.copyFileSync(
        path.join(fixturesDir, 'workspace.json'),
        path.join(userDataDir, 'User', 'workspaceStorage', wsId, 'workspace.json')
    );

    for (const file of ['simple-session.jsonl', 'multi-turn-session.jsonl']) {
        fs.copyFileSync(
            path.join(fixturesDir, 'jsonl', file),
            path.join(chatDir, file)
        );
    }

    // Empty-window sessions: globalStorage/emptyWindowChatSessions/*.json
    const emptyDir = path.join(userDataDir, 'User', 'globalStorage', 'emptyWindowChatSessions');
    fs.mkdirSync(emptyDir, { recursive: true });

    fs.copyFileSync(
        path.join(fixturesDir, 'legacy-json', 'single-request.json'),
        path.join(emptyDir, 'legacy-session.json')
    );
}

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './index');

    // Create a temp user-data directory with fixture session data
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csk-e2e-'));
    const fixturesDir = path.resolve(__dirname, '../fixtures');
    setupMockStorage(userDataDir, fixturesDir);

    // Pass the storage root to the test process via env
    process.env.CSK_TEST_STORAGE_ROOT = path.join(userDataDir, 'User');
    process.env.CSK_TEST_USER_DATA_DIR = userDataDir;

    try {
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                '--user-data-dir', userDataDir,
                '--disable-extensions',
            ],
        });
    } finally {
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('Failed to run E2E tests:', err);
    process.exit(1);
});
