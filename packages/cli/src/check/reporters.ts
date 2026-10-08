import type { Insight, InsightCode, InsightSeverity, GraphMeta } from '@react-state-map/core';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEVERITIES: InsightSeverity[] = ['error', 'warning', 'info', 'hint'];
export const severityRank = (s: InsightSeverity) => SEVERITIES.indexOf(s);

export interface DrillingChain {
  values: string[];
  chain: string;
  components: number;
  id: string;
  isNew?: boolean;
}

export interface CheckReport {
  version: string;
  meta: GraphMeta;
  /** Directory paths are reported relative to (repository root when available, else cwd) */
  pathRoot: string;
  /** Insights that pass every filter (severity, baseline, base) — these decide the exit code */
  insights: Insight[];
  totalInsights: number;
  belowMinSeverity: number;
  minSeverity: InsightSeverity;
  baselineSuppressed: number;
  base?: { ref: string; sha: string; existing: number; fixed: Insight[] };
  drilling: DrillingChain[];
  failOn: InsightSeverity | 'none';
  failed: boolean;
  parseErrors: Array<{ filePath: string; message: string }>;
}

export const RULES: Record<InsightCode, { name: string; short: string; full: string; level: InsightSeverity }> = {
  PROP_DRILLING: {
    name: 'PropDrilling',
    short: 'State is drilled through components that only forward it',
    full: 'A state value is passed as props through intermediate components that do not use it. Lift it into a context, use composition (children), or a store.',
    level: 'warning',
  },
  PROP_PASSTHROUGH: {
    name: 'PropPassthrough',
    short: 'Component only forwards a drilled prop',
    full: 'This component receives a prop only to pass it on as part of a prop-drilling chain.',
    level: 'hint',
  },
  CONTEXT_LEAK: {
    name: 'ContextLeak',
    short: 'Context value re-passed as props',
    full: 'A component reads a context and passes its values down as props; the children could read the context directly.',
    level: 'info',
  },
  PROP_BUNDLE: {
    name: 'PropBundle',
    short: 'Large object passed as a single prop',
    full: 'A large object is passed as one prop; consider passing only the fields the child needs.',
    level: 'info',
  },
  UNUSED_PROP: {
    name: 'UnusedProp',
    short: 'Prop is destructured but never used',
    full: 'The component destructures a prop it never uses.',
    level: 'info',
  },
  SERVER_COMPONENT_HOOK: {
    name: 'ServerComponentHook',
    short: 'Client-only hook used in a Server Component',
    full: 'A React hook that only works in Client Components is used in a component rendered as a Server Component. Add "use client" or move the stateful part into a Client Component.',
    level: 'error',
  },
  SERVER_TO_CLIENT_FUNCTION_PROP: {
    name: 'ServerToClientFunctionProp',
    short: 'Function passed from a Server Component to a Client Component',
    full: 'Functions cannot be serialized across the server/client boundary unless they are Server Actions ("use server").',
    level: 'error',
  },
};

const HELP_URI = 'https://github.com/olafglad/react-state-map/tree/main/packages/cli#rules';

function rel(report: CheckReport, filePath: string): string {
  if (!filePath) return '';
  const r = path.relative(report.pathRoot, filePath);
  return (r.startsWith('..') || path.isAbsolute(r) ? filePath : r).split(path.sep).join('/');
}

function sortInsights(list: Insight[]): Insight[] {
  return [...list].sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column || severityRank(a.severity) - severityRank(b.severity)
  );
}

function counts(list: Insight[]): Record<InsightSeverity, number> {
  const c: Record<InsightSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const i of list) c[i.severity]++;
  return c;
}

function countsText(list: Insight[]): string {
  const c = counts(list);
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} error${c.error === 1 ? '' : 's'}`);
  if (c.warning) parts.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
  if (c.info) parts.push(`${c.info} info`);
  if (c.hint) parts.push(`${c.hint} hint${c.hint === 1 ? '' : 's'}`);
  return parts.join(', ') || 'none';
}

function noun(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ============================================
// text
// ============================================

export function renderText(report: CheckReport, options: { color: boolean; maxIssues?: number; cwd: string }): string {
  const c = (code: string, s: string) => (options.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const sevColor: Record<InsightSeverity, string> = { error: '31', warning: '33', info: '36', hint: '90' };
  const out: string[] = [];
  const list = sortInsights(report.insights);
  const shown = options.maxIssues !== undefined ? list.slice(0, options.maxIssues) : list;

  let currentFile = '';
  for (const i of shown) {
    if (i.filePath !== currentFile) {
      if (currentFile) out.push('');
      currentFile = i.filePath;
      const r = path.relative(options.cwd, i.filePath);
      out.push(c('4', r.startsWith('..') ? i.filePath : r));
    }
    const pos = `${i.line}:${i.column + 1}`.padEnd(7);
    out.push(`  ${c('90', pos)} ${c(sevColor[i.severity], i.severity.padEnd(7))} ${i.message}  ${c('90', i.code)}`);
  }
  if (shown.length < list.length) out.push('', c('90', `… ${list.length - shown.length} more not shown (--max-issues ${options.maxIssues})`));
  if (shown.length) out.push('');

  const extras: string[] = [];
  if (report.base) extras.push(`${report.base.existing} already on ${report.base.ref.slice(0, 12)}`, `${report.base.fixed.length} fixed since base`);
  if (report.baselineSuppressed) extras.push(`${report.baselineSuppressed} in baseline`);
  if (report.belowMinSeverity) extras.push(`${report.belowMinSeverity} below --min-severity ${report.minSeverity}`);
  const what = report.base ? 'new issue' : 'issue';
  const head = report.insights.length
    ? c(report.failed ? '31;1' : '33;1', `${report.failed ? '✖' : '!'} ${noun(report.insights.length, what)} (${countsText(report.insights)})`)
    : c('32;1', `✔ No ${what}s`);
  out.push(`${head}${extras.length ? c('90', ` · ${extras.join(' · ')}`) : ''}`);
  out.push(c('90', `${report.meta.filesAnalyzed} files analyzed in ${report.meta.durationMs}ms${report.meta.frameworks.length ? ` (${report.meta.frameworks.join(', ')})` : ''}; fail-on: ${report.failOn}`));
  return out.join('\n') + '\n';
}

// ============================================
// json
// ============================================

export function renderJson(report: CheckReport): string {
  const withRel = (i: Insight) => ({ ...i, relativePath: rel(report, i.filePath) });
  const body: Record<string, unknown> = {
    meta: { ...report.meta, version: report.version },
    summary: {
      reported: report.insights.length,
      total: report.totalInsights,
      bySeverity: counts(report.insights),
      baselineSuppressed: report.baselineSuppressed,
      belowMinSeverity: report.belowMinSeverity,
      minSeverity: report.minSeverity,
      failOn: report.failOn,
      failed: report.failed,
      parseErrors: report.parseErrors.length,
    },
    insights: sortInsights(report.insights).map(withRel),
  };
  if (report.base) {
    body.base = { ref: report.base.ref, sha: report.base.sha, existing: report.base.existing };
    body.newSinceBase = sortInsights(report.insights).map(i => i.id);
    body.fixedSinceBase = report.base.fixed.map(withRel);
  }
  if (report.parseErrors.length) body.parseErrors = report.parseErrors;
  return JSON.stringify(body, null, 2) + '\n';
}

// ============================================
// github (workflow commands)
// ============================================

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function renderGithub(report: CheckReport): string {
  const out: string[] = [];
  for (const i of sortInsights(report.insights)) {
    const cmd = i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'notice';
    const props = [
      `file=${escapeProperty(rel(report, i.filePath))}`,
      `line=${i.line}`,
      `col=${i.column + 1}`,
    ];
    if (i.endLine !== undefined) props.push(`endLine=${i.endLine}`);
    if (i.endColumn !== undefined && (i.endLine === undefined || i.endLine === i.line)) props.push(`endColumn=${i.endColumn + 1}`);
    props.push(`title=${escapeProperty(`React State Map: ${RULES[i.code]?.short ?? i.code} (${i.code})`)}`);
    out.push(`::${cmd} ${props.join(',')}::${escapeData(i.message)}`);
  }
  const what = report.base ? 'new issue' : 'issue';
  out.push(report.insights.length
    ? `React State Map: ${noun(report.insights.length, what)} (${countsText(report.insights)})${report.base ? `, ${report.base.fixed.length} fixed since base` : ''}`
    : `React State Map: no ${what}s${report.base ? `, ${report.base.fixed.length} fixed since base` : ''}`);
  return out.join('\n') + '\n';
}

// ============================================
// markdown (also used for $GITHUB_STEP_SUMMARY)
// ============================================

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(report: CheckReport, options: { maxRows?: number } = {}): string {
  const maxRows = options.maxRows ?? 50;
  const out: string[] = ['## React State Map', ''];
  const what = report.base ? 'new issue' : 'issue';
  const status = report.failed ? '**Failed**' : '**Passed**';
  out.push(`${status}: ${report.insights.length ? `${noun(report.insights.length, what)} (${countsText(report.insights)})` : `no ${what}s`}` +
    (report.base ? ` compared to \`${report.base.ref.slice(0, 12)}\`` : '') + ` · fail-on: \`${report.failOn}\``);
  const facts: string[] = [];
  if (report.base) facts.push(`**${report.base.fixed.length}** fixed since base`, `${report.base.existing} pre-existing`);
  if (report.baselineSuppressed) facts.push(`${report.baselineSuppressed} accepted in baseline`);
  facts.push(`${report.meta.filesAnalyzed} files analyzed`);
  out.push('', facts.join(' · '));

  if (report.insights.length) {
    out.push('', `### ${report.base ? 'New issues' : 'Issues'}`, '', '| Severity | Rule | Location | Message |', '| --- | --- | --- | --- |');
    const list = [...report.insights].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.filePath.localeCompare(b.filePath) || a.line - b.line);
    for (const i of list.slice(0, maxRows)) {
      out.push(`| ${i.severity} | \`${i.code}\` | \`${cell(rel(report, i.filePath))}:${i.line}\` | ${cell(i.message)} |`);
    }
    if (list.length > maxRows) out.push('', `…and ${list.length - maxRows} more.`);
  }

  if (report.drilling.length) {
    out.push('', '### Largest prop-drilling chains', '', '| Value(s) | Chain | Components |', '| --- | --- | --- |');
    for (const d of report.drilling.slice(0, 5)) {
      out.push(`| ${cell(d.values.map(v => `\`${v}\``).join(', '))}${d.isNew ? ' (new)' : ''} | ${cell(d.chain)} | ${d.components} |`);
    }
  }

  if (report.base && report.base.fixed.length) {
    out.push('', `<details><summary>Fixed since base (${report.base.fixed.length})</summary>`, '');
    for (const i of report.base.fixed.slice(0, maxRows)) out.push(`- \`${i.code}\` ${cell(i.message)}`);
    out.push('', '</details>');
  }
  out.push('', 'Run `npx @react-state-map/cli fix --list` locally for automatic fixes.');
  return out.join('\n') + '\n';
}

// ============================================
// SARIF 2.1.0
// ============================================

const sarifLevel = (s: InsightSeverity) => (s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'note');

export function renderSarif(report: CheckReport): string {
  const codes = Object.keys(RULES) as InsightCode[];
  const rules = codes.map(code => ({
    id: code,
    name: RULES[code].name,
    shortDescription: { text: RULES[code].short },
    fullDescription: { text: RULES[code].full },
    helpUri: HELP_URI,
    defaultConfiguration: { level: sarifLevel(RULES[code].level) },
    properties: { tags: ['react', 'state-management'] },
  }));
  const root = pathToFileURL(report.pathRoot.endsWith(path.sep) ? report.pathRoot : report.pathRoot + path.sep).href;

  const results = sortInsights(report.insights).map(i => {
    const region: Record<string, number> = { startLine: Math.max(1, i.line), startColumn: i.column + 1 };
    if (i.endLine !== undefined) region.endLine = i.endLine;
    if (i.endColumn !== undefined) region.endColumn = i.endColumn + 1;
    const result: Record<string, unknown> = {
      ruleId: i.code,
      ruleIndex: codes.indexOf(i.code),
      level: sarifLevel(i.severity),
      message: { text: i.message },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: encodeURI(rel(report, i.filePath)), uriBaseId: 'SRCROOT' },
          region,
        },
      }],
      partialFingerprints: { 'reactStateMap/v1': i.id },
      properties: { severity: i.severity, ...(i.componentId ? { componentId: i.componentId } : {}), ...(i.fixable ? { fixable: true } : {}) },
    };
    if (i.related?.length) {
      result.relatedLocations = i.related.map((r, idx) => ({
        id: idx + 1,
        message: { text: r.message },
        physicalLocation: {
          artifactLocation: { uri: encodeURI(rel(report, r.filePath)), uriBaseId: 'SRCROOT' },
          region: { startLine: Math.max(1, r.line), startColumn: r.column + 1 },
        },
      }));
    }
    return result;
  });

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'React State Map',
          semanticVersion: report.version,
          version: report.version,
          informationUri: 'https://github.com/olafglad/react-state-map',
          rules,
        },
      },
      originalUriBaseIds: { SRCROOT: { uri: root } },
      results,
      properties: {
        frameworks: report.meta.frameworks,
        filesAnalyzed: report.meta.filesAnalyzed,
        ...(report.base ? { baseRef: report.base.ref, baseSha: report.base.sha, fixedSinceBase: report.base.fixed.length } : {}),
      },
    }],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}
