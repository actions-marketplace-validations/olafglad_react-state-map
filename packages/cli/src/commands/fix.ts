import { GraphQuery, planLiftToContext, planRemoveUnusedProp } from '@react-state-map/core';
import type { FixPlan } from '@react-state-map/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createParser, resolveRootDir } from '../shared/project.js';
import { formatFixTargets, resolveFixTarget, createUnifiedDiff, relPath } from '@react-state-map/core';

export interface FixOptions {
  list?: boolean;
  write?: boolean;
  react19?: boolean;
  dir?: string;
  threshold: string;
  include?: string[];
  exclude?: string[];
}

const err = (msg: string) => process.stderr.write(`${msg}\n`);

/**
 * `fix [dir] [id]` — a single argument is a directory when it exists, otherwise a fix id/index.
 */
function splitArgs(args: string[], options: FixOptions): { dir: string; id?: string } {
  if (options.dir) return { dir: options.dir, id: args[0] };
  if (args.length >= 2) return { dir: args[0]!, id: args[1] };
  if (args.length === 1) {
    const a = args[0]!;
    const looksLikeDir = fs.existsSync(a) && fs.statSync(a).isDirectory();
    return looksLikeDir ? { dir: a } : { dir: '.', id: a };
  }
  return { dir: '.' };
}

export function fixCommand(args: string[], options: FixOptions): void {
  try {
    process.exitCode = runFix(args, options);
  } catch (error) {
    err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

function runFix(args: string[], options: FixOptions): number {
  const { dir, id } = splitArgs(args, options);
  const rootDir = resolveRootDir(dir);
  const parser = createParser(rootDir, options);
  const { graph, errors } = parser.parse();
  if (errors.length) err(`warning: ${errors.length} file(s) could not be parsed`);
  const query = new GraphQuery(graph);

  if (options.list || !id) {
    process.stdout.write(formatFixTargets(query, graph) + '\n');
    if (!options.list && !id) err('\nRun `react-state-map fix <number|id>` to see the diff, add --write to apply it.');
    return 0;
  }

  const target = resolveFixTarget(query, graph, id);
  if (typeof target === 'string') {
    err(target);
    return 2;
  }

  let plan: FixPlan;
  if (target.kind === 'remove-unused-prop') {
    plan = planRemoveUnusedProp(parser.getProject(), target.insight);
  } else {
    const react19 = options.react19 ?? (parser.getReactMajor() ?? 0) >= 19;
    plan = planLiftToContext(parser.getProject(), graph, target.drillingPathId!, { react19 });
  }

  err(`${plan.title}${target.chain ? `  (${target.chain})` : ''}`);
  if (!plan.applicable) {
    err('Not applicable automatically:');
    for (const r of plan.reasons) err(`  - ${r}`);
    return 1;
  }
  for (const n of plan.notes) err(`  note: ${n}`);

  if (!options.write) {
    for (const e of plan.edits) {
      const rel = relPath(graph, e.filePath);
      process.stdout.write(createUnifiedDiff(e.isNew ? null : rel, rel, e.isNew ? '' : e.oldText, e.newText));
    }
    err(`\n${plan.edits.length} file(s) would change. Re-run with --write to apply, or pipe into \`git apply\`.`);
    return 0;
  }

  // Refuse to overwrite files that changed since they were analyzed
  for (const e of plan.edits) {
    const exists = fs.existsSync(e.filePath);
    if (e.isNew && exists) {
      err(`Refusing to write: ${e.filePath} already exists.`);
      return 1;
    }
    if (!e.isNew && (!exists || fs.readFileSync(e.filePath, 'utf-8') !== e.oldText)) {
      err(`Refusing to write: ${e.filePath} changed since it was analyzed. Re-run the command.`);
      return 1;
    }
  }
  for (const e of plan.edits) {
    fs.mkdirSync(path.dirname(e.filePath), { recursive: true });
    fs.writeFileSync(e.filePath, e.newText);
    const shown = path.relative(process.cwd(), e.filePath);
    process.stdout.write(`${e.isNew ? 'created' : 'updated'} ${shown.startsWith('..') ? e.filePath : shown}\n`);
  }
  err(`\nApplied. Review the changes (git diff) and run your type checker / tests.`);
  return 0;
}
