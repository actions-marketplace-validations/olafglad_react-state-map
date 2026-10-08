import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '..');
const extensionTestsPath = path.resolve(here, 'suite', 'index.cjs');

// Work on a copy of the fixture: the suite applies refactors
const fixture = path.resolve(here, '..', '..', 'core', 'test-fixtures', 'modern-app');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-vscode-'));
fs.cpSync(fixture, workspace, { recursive: true });
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'reactStateMap.fixes.preview': false }));

try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // Short user-data dir: the IPC socket path must stay under ~103 chars on macOS/Linux
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'rsmud-'))}`],
    extensionTestsEnv: { RSM_WORKSPACE: workspace },
  });
} catch (err) {
  console.error('Integration tests failed', err);
  process.exit(1);
}
