#!/usr/bin/env node

import { Command, Option } from 'commander';
import { analyzeCommand } from './commands/analyze.js';
import { checkCommand } from './commands/check.js';
import { fixCommand } from './commands/fix.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const version = getVersion();
const program = new Command();

program
  .name('react-state-map')
  .description('Visualize React state flow through static analysis')
  .version(version)
  // Program options only before a subcommand, so `check --format` doesn't collide with the default command's `-f`
  .enablePositionalOptions();

// Default command: interactive HTML / JSON graph
program
  .argument('[directory]', 'Directory to analyze', '.')
  .option('-o, --output <file>', 'Output file path', 'state-map.html')
  .option('-f, --format <format>', 'Output format (html, json)', 'html')
  .option('-w, --watch', 'Watch for file changes')
  .option('-t, --threshold <number>', 'Prop drilling threshold', '3')
  .option('--no-open', 'Do not open the output file in browser')
  .option('-e, --exclude <patterns...>', 'Glob patterns to exclude')
  .option('-i, --include <patterns...>', 'Glob patterns to include')
  .action(analyzeCommand);

// ---- check: CI gate
const check = program
  .command('check')
  .description('Analyze and report issues for CI (exit 1 when issues at/above --fail-on are found, 2 on errors)')
  .argument('[directory]', 'Directory to analyze', '.')
  .addOption(new Option('--format <format>', 'Output format (default: text, or github when GITHUB_ACTIONS=true)').choices(['text', 'json', 'github', 'sarif', 'markdown']))
  .addOption(new Option('--fail-on <severity>', 'Exit with 1 when a reported issue has this severity or higher').choices(['error', 'warning', 'info', 'none']).default('error'))
  .addOption(new Option('--min-severity <severity>', 'Lowest severity to report (hints are per-component details of drilling chains)').choices(['error', 'warning', 'info', 'hint']).default('info'))
  .option('-t, --threshold <number>', 'Prop drilling threshold (components in a chain)', '3')
  .option('-i, --include <patterns...>', 'Glob patterns to include')
  .option('-e, --exclude <patterns...>', 'Glob patterns to exclude')
  .option('--base <git-ref>', 'Only report issues that are new compared to this git ref (branch, tag or sha)')
  .option('--baseline <file>', 'JSON file with accepted insight ids to ignore')
  .option('--write-baseline <file>', 'Write the ids of all current insights to a baseline file and exit 0')
  .option('--max-issues <n>', 'Maximum issues to print in text output')
  .option('-o, --output <file>', 'Write the report to a file instead of stdout')
  .option('--no-summary', 'Do not append a job summary to $GITHUB_STEP_SUMMARY (github format)')
  .action((dir: string, opts) => checkCommand(dir, { ...opts, version }));
// Usage errors exit with 2 (help / version still exit 0)
check.exitOverride((err) => {
  process.exit(err.exitCode === 0 ? 0 : 2);
});

// ---- fix: preview / apply automatic refactors
program
  .command('fix')
  .description('List fixable issues or preview/apply a fix: `fix [dir] --list`, `fix [dir] <number|id> [--write]`')
  .argument('[args...]', '[directory] and/or fix id (drilling path id, insight id, or number from --list)')
  .option('-l, --list', 'List fixable prop-drilling routes and unused props')
  .option('--write', 'Write the changes to disk (default: print a unified diff)')
  .option('--react19', 'Generate React 19 `<Context value>` providers (default: auto-detect from package.json)')
  .option('--no-react19', 'Generate `<Context.Provider value>` providers')
  .option('-C, --dir <directory>', 'Directory to analyze (alternative to the positional argument)')
  .option('-t, --threshold <number>', 'Prop drilling threshold', '3')
  .option('-i, --include <patterns...>', 'Glob patterns to include')
  .option('-e, --exclude <patterns...>', 'Glob patterns to exclude')
  .action((args: string[], opts) => fixCommand(args, opts));

// ---- mcp: Model Context Protocol server for AI coding agents
program
  .command('mcp')
  .description('Run an MCP server over stdio so AI coding agents (Claude Code, Cursor, Copilot, …) can query the analysis')
  .argument('[directory]', 'Project directory to analyze', '.')
  .option('-t, --threshold <number>', 'Prop drilling threshold', '3')
  .option('-i, --include <patterns...>', 'Glob patterns to include')
  .option('-e, --exclude <patterns...>', 'Glob patterns to exclude')
  .option('--no-watch', 'Do not watch files for changes')
  .action(async (dir: string, opts) => {
    const { resolveRootDir } = await import('./shared/project.js');
    const { runMcpServer } = await import('./mcp/server.js');
    try {
      await runMcpServer(resolveRootDir(dir), { ...opts, version });
    } catch (error) {
      process.stderr.write(`[react-state-map] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  });

program.parseAsync().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
