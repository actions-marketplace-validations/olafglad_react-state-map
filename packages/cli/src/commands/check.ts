import { GraphQuery } from '@react-state-map/core';
import type { Insight, InsightSeverity, StateFlowGraph, ParseError } from '@react-state-map/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createParser, resolveRootDir, parseThreshold } from '../shared/project.js';
import { gitTopLevel, resolveBaseCommit, withWorktree } from '../shared/git.js';
import { listFixTargets } from '@react-state-map/core';
import {
  SEVERITIES,
  severityRank,
  renderText,
  renderJson,
  renderGithub,
  renderMarkdown,
  renderSarif,
  type CheckReport,
  type DrillingChain,
} from '../check/reporters.js';

export interface CheckOptions {
  format?: string;
  failOn: string;
  minSeverity: string;
  threshold: string;
  include?: string[];
  exclude?: string[];
  base?: string;
  baseline?: string;
  writeBaseline?: string;
  maxIssues?: string;
  output?: string;
  summary?: boolean;
  version?: string;
}

const FORMATS = ['text', 'json', 'github', 'sarif', 'markdown'] as const;
type Format = typeof FORMATS[number];

/** Thrown for usage / analysis problems → exit code 2 */
export class CheckUsageError extends Error {}

const log = (msg: string) => process.stderr.write(`${msg}\n`);

function analyzeDir(rootDir: string, options: CheckOptions): { graph: StateFlowGraph; errors: ParseError[] } {
  const parser = createParser(rootDir, options);
  const { graph, errors } = parser.parse();
  return { graph, errors };
}

function readBaseline(file: string): Set<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new CheckUsageError(`Cannot read baseline "${file}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).ids ?? (raw as Record<string, unknown>).insights)
      : undefined;
  if (!Array.isArray(list)) throw new CheckUsageError(`Baseline "${file}" must be a JSON array of insight ids`);
  return new Set(list.map(x => (typeof x === 'string' ? x : (x as { id?: string })?.id)).filter((x): x is string => typeof x === 'string'));
}

function drillingChains(graph: StateFlowGraph, reportedIds: Set<string>): DrillingChain[] {
  const query = new GraphQuery(graph);
  return listFixTargets(query, graph)
    .filter(t => t.kind === 'lift-to-context')
    .map(t => {
      const p = graph.propDrillingPaths.find(d => d.id === t.drillingPathId);
      return {
        values: t.values ?? [],
        chain: t.chain ?? '',
        components: p?.path.length ?? 0,
        id: t.drillingPathId ?? t.insight.id,
        isNew: reportedIds.has(t.insight.id),
      };
    })
    .sort((a, b) => b.components - a.components);
}

export async function runCheck(directory: string | undefined, options: CheckOptions): Promise<number> {
  // ---- Validate options
  const format = (options.format ?? (process.env.GITHUB_ACTIONS === 'true' ? 'github' : 'text')) as Format;
  if (!FORMATS.includes(format)) throw new CheckUsageError(`Unknown --format "${options.format}" (expected ${FORMATS.join(', ')})`);
  const failOn = options.failOn as InsightSeverity | 'none';
  if (failOn !== 'none' && !['error', 'warning', 'info'].includes(failOn)) {
    throw new CheckUsageError(`Unknown --fail-on "${options.failOn}" (expected error, warning, info or none)`);
  }
  const minSeverity = options.minSeverity as InsightSeverity;
  if (!SEVERITIES.includes(minSeverity)) throw new CheckUsageError(`Unknown --min-severity "${options.minSeverity}" (expected ${SEVERITIES.join(', ')})`);
  let maxIssues: number | undefined;
  if (options.maxIssues !== undefined) {
    maxIssues = parseInt(options.maxIssues, 10);
    if (!Number.isFinite(maxIssues) || maxIssues < 0) throw new CheckUsageError(`Invalid --max-issues "${options.maxIssues}"`);
  }
  try {
    parseThreshold(options.threshold);
  } catch (error) {
    throw new CheckUsageError((error as Error).message);
  }

  let rootDir: string;
  try {
    rootDir = fs.realpathSync(resolveRootDir(directory));
  } catch (error) {
    throw new CheckUsageError((error as Error).message);
  }

  // ---- Analyze
  const { graph, errors } = analyzeDir(rootDir, options);
  const all = graph.insights;
  if (errors.length) log(`warning: ${errors.length} file(s) could not be parsed (first: ${errors[0]!.filePath}: ${errors[0]!.message})`);
  if (!graph.meta || graph.meta.filesAnalyzed === 0) log(`warning: no source files found in ${rootDir}`);

  if (options.writeBaseline) {
    const ids = [...new Set(all.map(i => i.id))].sort();
    fs.writeFileSync(options.writeBaseline, JSON.stringify(ids, null, 2) + '\n');
    log(`Wrote ${ids.length} insight id(s) to ${options.writeBaseline}`);
    return 0;
  }

  const repoRoot = gitTopLevel(rootDir);
  const atOrAbove = (i: Insight) => severityRank(i.severity) <= severityRank(minSeverity);
  let reported = all.filter(atOrAbove);
  const belowMinSeverity = all.length - reported.length;

  let baselineSuppressed = 0;
  if (options.baseline) {
    const accepted = readBaseline(options.baseline);
    const before = reported.length;
    reported = reported.filter(i => !accepted.has(i.id));
    baselineSuppressed = before - reported.length;
  }

  // ---- Compare with base ref
  let base: CheckReport['base'];
  if (options.base) {
    if (!repoRoot) throw new CheckUsageError(`--base needs a git repository, but ${rootDir} is not inside one`);
    const relDir = path.relative(repoRoot, rootDir);
    const sha = (() => {
      try {
        return resolveBaseCommit(repoRoot, options.base!, log);
      } catch (error) {
        throw new CheckUsageError((error as Error).message);
      }
    })();
    log(`Analyzing base ${options.base} (${sha.slice(0, 12)})…`);
    const baseInsights = await withWorktree(repoRoot, sha, (wt) => {
      const baseDir = path.join(wt, relDir);
      if (!fs.existsSync(baseDir)) {
        log(`note: ${relDir || '.'} does not exist at the base; every issue counts as new`);
        return [] as Insight[];
      }
      return analyzeDir(baseDir, options).graph.insights;
    });
    const baseIds = new Set(baseInsights.map(i => i.id));
    const currentIds = new Set(all.map(i => i.id));
    const before = reported.length;
    reported = reported.filter(i => !baseIds.has(i.id));
    base = {
      ref: options.base,
      sha,
      existing: before - reported.length,
      fixed: baseInsights.filter(i => atOrAbove(i) && !currentIds.has(i.id)),
    };
  }

  const failed = failOn !== 'none' && reported.some(i => severityRank(i.severity) <= severityRank(failOn));
  const report: CheckReport = {
    version: options.version ?? '0.0.0',
    meta: graph.meta!,
    pathRoot: repoRoot ?? process.cwd(),
    insights: reported,
    totalInsights: all.length,
    belowMinSeverity,
    minSeverity,
    baselineSuppressed,
    base,
    drilling: drillingChains(graph, base ? new Set(reported.map(i => i.id)) : new Set()),
    failOn,
    failed,
    parseErrors: errors.map(e => ({ filePath: e.filePath, message: e.message })),
  };

  // ---- Render
  const toFile = !!options.output;
  const color = !toFile && !process.env.NO_COLOR && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY);
  let output: string;
  switch (format) {
    case 'json': output = renderJson(report); break;
    case 'github': output = renderGithub(report); break;
    case 'sarif': output = renderSarif(report); break;
    case 'markdown': output = renderMarkdown(report); break;
    default: output = renderText(report, { color, maxIssues, cwd: process.cwd() });
  }

  if (toFile) {
    fs.writeFileSync(options.output!, output);
    log(`Report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (format === 'github' && summaryFile && options.summary !== false) {
    try {
      fs.appendFileSync(summaryFile, renderMarkdown(report) + '\n');
    } catch (error) {
      log(`warning: could not write job summary: ${(error as Error).message}`);
    }
  }

  return failed ? 1 : 0;
}

export async function checkCommand(directory: string | undefined, options: CheckOptions): Promise<void> {
  try {
    process.exitCode = await runCheck(directory, options);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
