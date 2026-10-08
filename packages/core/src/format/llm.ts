/**
 * Plain-text formatters for the MCP tools (and anything else that wants LLM-friendly output).
 *
 * Every export is a pure function over core types/values: (query, graph, args) => string.
 * No Node, MCP SDK, commander or chokidar imports — this module is meant to be shareable.
 */
import { GraphQuery } from '../graph/query.js';
import type { ImpactReport, ComponentRef } from '../graph/query.js';
import type { FixPlan } from '../fix/lift-to-context.js';
import type {
  StateFlowGraph,
  SerializedStateFlowGraph,
  ComponentNode,
  StateNode,
  Insight,
  InsightSeverity,
  PropDrillingPath,
  RenderEdge,
} from '../types.js';

export type AnyGraph = StateFlowGraph | SerializedStateFlowGraph;

// ============================================
// Shared helpers
// ============================================

export const SEVERITY_ORDER: InsightSeverity[] = ['error', 'warning', 'info', 'hint'];
const severityRank = (s: InsightSeverity) => SEVERITY_ORDER.indexOf(s);

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Path relative to the analyzed root (falls back to the input) */
export function relPath(graph: AnyGraph, filePath: string): string {
  const file = toPosix(filePath);
  const root = graph.meta?.rootDir ? toPosix(graph.meta.rootDir).replace(/\/+$/, '') : '';
  if (root && file.startsWith(root + '/')) return file.slice(root.length + 1);
  return file;
}

function loc(graph: AnyGraph, filePath: string, line?: number): string {
  return line ? `${relPath(graph, filePath)}:${line}` : relPath(graph, filePath);
}

function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function insightsOf(graph: AnyGraph): Insight[] {
  return graph.insights ?? [];
}

function sortInsights(list: Insight[]): Insight[] {
  return [...list].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) ||
    a.filePath.localeCompare(b.filePath) ||
    a.line - b.line ||
    a.column - b.column
  );
}

function severityCounts(list: Insight[]): Record<InsightSeverity, number> {
  const counts: Record<InsightSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const i of list) counts[i.severity]++;
  return counts;
}

function countsLine(list: Insight[]): string {
  const c = severityCounts(list);
  return `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}, ${c.info} info, ${plural(c.hint, 'hint')}`;
}

function insightLine(graph: AnyGraph, i: Insight, withFile = true): string {
  const where = withFile ? `${loc(graph, i.filePath, i.line)} ` : `line ${i.line} `;
  const extra: string[] = [];
  if (i.fixable) extra.push(i.code === 'UNUSED_PROP' ? 'fixable: plan_fix insight_id' : `fixable: plan_fix drilling_path_id=${i.drillingPathId}`);
  return `- [${i.severity}] ${i.code} ${where}— ${i.message}\n  id: ${i.id}${extra.length ? `\n  ${extra.join('; ')}` : ''}`;
}

function componentLabel(graph: AnyGraph, c: ComponentNode | ComponentRef): string {
  return `${c.name} (${loc(graph, c.filePath, c.line)})`;
}

function stateLabel(s: StateNode): string {
  const parts: string[] = [s.type];
  if (s.library && s.library !== 'react') parts.push(s.library);
  if (s.storeName) parts.push(`store ${s.storeName}`);
  if (s.hookName) parts.push(`via ${s.hookName}()`);
  return parts.join(', ');
}

function propsAtSite(site: RenderEdge, max = 6): string {
  const props = site.props ?? [];
  if (!props.length) return 'no props';
  const shown = props.slice(0, max).map(p => (p.name === '...spread' ? `{${clip(p.value, 30)}}` : `${p.name}={${clip(p.value, 30)}}`));
  return shown.join(' ') + (props.length > max ? ` …+${props.length - max}` : '');
}

/** Resolve a component query, returning either the component or an explanatory message */
function resolveComponentOrExplain(query: GraphQuery, graph: AnyGraph, q: string, role = 'component'): ComponentNode | string {
  const found = query.resolveComponent(q.trim());
  if (found) return found;
  const suggestions = query.findComponents(q.replace(/^.*#/, ''), 5);
  return `No ${role} matches "${q}".` + (suggestions.length
    ? ` Did you mean: ${suggestions.map(c => `${c.name} (${relPath(graph, c.filePath)})`).join(', ')}?`
    : ' Use find_components to search.');
}

function ambiguityNote(query: GraphQuery, graph: AnyGraph, q: string, chosen: ComponentNode): string {
  if (query.components.has(q) || q.includes('#')) return '';
  const same = [...query.components.values()].filter(c => c.name === chosen.name && c.id !== chosen.id);
  if (!same.length) return '';
  return `\nNote: ${plural(same.length, 'other component')} named ${chosen.name}: ${same.map(c => c.id).join(', ')}. Pass the id (or "path#Name") to pick one.`;
}

interface DrillingRoute {
  paths: PropDrillingPath[];
  key: string;
  values: string[];
  chain: string;
  hops: number;
}

/** Group drilling paths that move values of the same state along the same route (value + setter …) */
function drillingRoutes(graph: AnyGraph): DrillingRoute[] {
  const byKey = new Map<string, DrillingRoute>();
  for (const p of graph.propDrillingPaths) {
    const key = `${p.stateId}|${(p.componentIds ?? p.path).join('>')}`;
    const route = byKey.get(key);
    if (route) {
      route.paths.push(p);
      if (!route.values.includes(p.stateName)) route.values.push(p.stateName);
    } else {
      byKey.set(key, { key, paths: [p], values: [p.stateName], chain: p.path.join(' → '), hops: p.hops });
    }
  }
  return [...byKey.values()].sort((a, b) => b.hops - a.hops || a.chain.localeCompare(b.chain));
}

interface ContextEntry { id: string; name: string; providers: ComponentNode[]; consumers: ComponentNode[]; file?: string }

function contextEntries(query: GraphQuery, graph: AnyGraph): ContextEntry[] {
  const map = new Map<string, ContextEntry>();
  const add = (id: string, name: string, file?: string) => {
    if (!map.has(id)) map.set(id, { id, name, providers: [], consumers: [], file });
  };
  for (const b of graph.contextBoundaries) add(b.contextId, b.contextName, b.providerFile);
  for (const c of query.components.values()) {
    (c.contextConsumerIds ?? []).forEach((id, idx) => add(id, c.contextConsumers[idx] ?? contextNameFromId(id)));
  }
  for (const e of map.values()) {
    e.providers = query.contextProviders(e.id);
    e.consumers = query.contextConsumers(e.id);
  }
  return [...map.values()].sort((a, b) => b.consumers.length - a.consumers.length || a.name.localeCompare(b.name));
}

function contextNameFromId(id: string): string {
  return id.includes('#') ? id.slice(id.lastIndexOf('#') + 1) : id.replace(/^ctx:(ext:)?/, '');
}

// ============================================
// get_overview
// ============================================

export function formatOverview(query: GraphQuery, graph: AnyGraph, args: { maxIssues?: number; maxChains?: number } = {}): string {
  const meta = graph.meta;
  const insights = insightsOf(graph);
  const out: string[] = [];

  out.push(`# React State Map overview${meta ? ` — ${meta.rootDir}` : ''}`);
  if (meta) {
    out.push(`Frameworks: ${meta.frameworks.length ? meta.frameworks.join(', ') : 'plain React'} · ${plural(meta.filesAnalyzed, 'file')} analyzed in ${meta.durationMs}ms · drilling threshold ${meta.drillingThreshold}`);
  }

  const stateByType = new Map<string, number>();
  for (const s of query.stateNodes.values()) stateByType.set(s.type, (stateByType.get(s.type) ?? 0) + 1);
  const stateSummary = [...stateByType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ');
  const env = { client: 0, server: 0 };
  for (const c of query.components.values()) if (c.environment) env[c.environment]++;
  out.push(`Components: ${query.components.size}${env.client || env.server ? ` (${env.server} server, ${env.client} client)` : ''} · State: ${query.stateNodes.size}${stateSummary ? ` (${stateSummary})` : ''} · Render edges: ${query.renders.length}`);
  out.push(`Issues: ${countsLine(insights)}`);

  const maxIssues = args.maxIssues ?? 8;
  const top = sortInsights(insights.filter(i => i.severity !== 'hint')).slice(0, maxIssues);
  out.push('', '## Top issues');
  if (!top.length) out.push('None above hint level.');
  for (const i of top) out.push(`- [${i.severity}] ${i.code} ${loc(graph, i.filePath, i.line)} — ${i.message}`);
  const rest = insights.filter(i => i.severity !== 'hint').length - top.length;
  if (rest > 0) out.push(`…${rest} more (list_issues)`);

  const routes = drillingRoutes(graph).slice(0, args.maxChains ?? 5);
  out.push('', '## Largest prop-drilling chains');
  if (!routes.length) out.push('None.');
  for (const r of routes) {
    out.push(`- ${r.values.join(' + ')}: ${r.chain} (${plural(r.hops, 'component')}) — drilling_path_id: ${r.paths[0]!.id ?? '(none)'}`);
  }

  const contexts = contextEntries(query, graph);
  out.push('', '## Contexts');
  if (!contexts.length) out.push('None.');
  for (const c of contexts.slice(0, 15)) {
    const providers = c.providers.map(p => p.name).join(', ') || 'no provider found';
    out.push(`- ${c.name} [${c.id}] — provided by ${providers}; ${plural(c.consumers.length, 'consumer')}`);
  }
  if (contexts.length > 15) out.push(`…${contexts.length - 15} more`);

  out.push('', 'Next: get_component <name> for details, list_issues to filter issues, plan_fix to get a refactor diff.');
  return out.join('\n');
}

// ============================================
// find_components
// ============================================

export function formatFindComponents(query: GraphQuery, graph: AnyGraph, args: { query: string; limit?: number }): string {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
  const matches = query.findComponents(args.query, limit + 1);
  if (!matches.length) return `No components match "${args.query}". Try a shorter name or part of the file path.`;
  const shown = matches.slice(0, limit);
  const out = [`${plural(shown.length, 'match', 'matches')}${matches.length > limit ? ` (showing first ${limit})` : ''} for "${args.query}":`];
  for (const c of shown) {
    const bits: string[] = [c.kind ?? 'function'];
    if (c.environment) bits.push(c.environment);
    if (c.directive) bits.push(`"${c.directive}"`);
    bits.push(plural(c.props.length, 'prop'));
    bits.push(plural(c.stateProvided.length, 'state'));
    const parents = query.parents(c.id).length;
    bits.push(`rendered by ${parents}`);
    out.push(`- ${c.name} — ${loc(graph, c.filePath, c.line)} · ${bits.join(' · ')}\n  id: ${c.id}`);
  }
  return out.join('\n');
}

// ============================================
// get_component
// ============================================

export function formatComponent(query: GraphQuery, graph: AnyGraph, args: { component: string }): string {
  const resolved = resolveComponentOrExplain(query, graph, args.component);
  if (typeof resolved === 'string') return resolved;
  const summary = query.summarizeComponent(resolved.id)!;
  const c = summary.component;
  const out: string[] = [];

  const header: string[] = [c.kind ?? 'function'];
  if (c.environment) header.push(`${c.environment} component`);
  if (c.directive) header.push(`"${c.directive}"`);
  if (c.isExported) header.push('exported');
  out.push(`# ${c.name} — ${loc(graph, c.filePath, c.line)}${c.endLine ? `-${c.endLine}` : ''}`);
  out.push(`id: ${c.id} · ${header.join(' · ')}`);
  if (summary.metrics) {
    const m = summary.metrics;
    out.push(`Role: ${m.role} (receives ${m.totalPropsReceived}, consumes ${m.propsConsumed}, forwards ${m.propsPassed}, ignores ${m.propsIgnored})`);
  }

  out.push('', `## Props (${c.props.length})`);
  if (!c.props.length) out.push('None.');
  for (const p of c.props) {
    const bits: string[] = [];
    if (p.type) bits.push(clip(p.type, 50));
    if (!p.isUsed) bits.push('UNUSED');
    if (p.passedTo.length) bits.push(`forwarded to ${p.passedTo.map(id => query.components.get(id)?.name ?? id).join(', ')}`);
    const trace = query.traceProp(c.id, p.name);
    const origins = (trace?.origins ?? []).map(o =>
      `${o.isSetter ? 'setter of ' : ''}${o.owner.name}.${o.state.name} [${o.state.type}] via ${o.chain.length} hop${o.chain.length === 1 ? '' : 's'}`
    );
    if (origins.length) bits.push(`from ${origins.join(' | ')}`);
    out.push(`- ${p.name}${p.optional ? '?' : ''}${bits.length ? ` — ${bits.join('; ')}` : ''}`);
  }

  out.push('', `## State declared (${summary.stateDeclared.length})`);
  if (!summary.stateDeclared.length) out.push('None.');
  for (const s of summary.stateDeclared) {
    const extra: string[] = [];
    if (s.setterName) extra.push(`setter ${s.setterName}`);
    if (s.initialValue) extra.push(`init ${clip(s.initialValue, 40)}`);
    out.push(`- ${s.name} [${stateLabel(s)}] line ${s.line}${extra.length ? ` — ${extra.join(', ')}` : ''}\n  id: ${s.id}`);
  }

  const received = c.stateUsed.filter(s => s.ownerId && s.ownerId !== c.id);
  if (received.length) {
    out.push('', '## State received from ancestors');
    for (const s of received) out.push(`- ${s.name} [${s.type}] owned by ${query.components.get(s.ownerId!)?.name ?? s.ownerId}`);
  }

  if (summary.contextsConsumed.length || summary.contextsProvided.length) {
    out.push('', '## Context');
    if (summary.contextsConsumed.length) out.push(`Consumes: ${summary.contextsConsumed.join(', ')}`);
    for (const p of c.contextProviders) {
      out.push(`Provides: ${p.contextName} [${p.contextId}]${p.providerValue ? ` value={${clip(p.providerValue, 50)}}` : ''} — ${plural(query.contextConsumers(p.contextId).length, 'consumer')}`);
    }
  }

  out.push('', `## Rendered by (${summary.renderedBy.length})`);
  if (!summary.renderedBy.length) out.push('Nothing in the analyzed code (entry point, route or unused).');
  for (const r of summary.renderedBy.slice(0, 20)) {
    out.push(`- ${r.component.name} at ${loc(graph, r.site.filePath, r.site.line)}${(r.site.count ?? 1) > 1 ? ` (${r.site.count}×)` : ''}: ${propsAtSite(r.site)}`);
  }
  if (summary.renderedBy.length > 20) out.push(`…${summary.renderedBy.length - 20} more`);

  out.push('', `## Renders (${summary.renders.length})`);
  if (!summary.renders.length) out.push('No child components.');
  for (const r of summary.renders.slice(0, 25)) {
    out.push(`- ${r.component.name} at line ${r.site.line}${(r.site.count ?? 1) > 1 ? ` (${r.site.count}×)` : ''}: ${propsAtSite(r.site)}`);
  }
  if (summary.renders.length > 25) out.push(`…${summary.renders.length - 25} more`);

  if (summary.drilling.length) {
    out.push('', '## Prop drilling involvement');
    for (const d of summary.drilling) {
      const ids = d.componentIds ?? [];
      const idx = ids.indexOf(c.id);
      const role = idx === 0 ? 'owner' : idx === ids.length - 1 ? 'consumer' : d.passThroughIds?.includes(c.id) ? 'pass-through only' : 'intermediate';
      out.push(`- ${role} of "${d.stateName}": ${d.path.join(' → ')} (props: ${[...new Set(d.propNames)].join('/')})\n  drilling_path_id: ${d.id ?? '(none)'}`);
    }
  }

  out.push('', `## Issues (${summary.insights.length})`);
  if (!summary.insights.length) out.push('None.');
  for (const i of sortInsights(summary.insights)) out.push(insightLine(graph, i, false));

  return out.join('\n') + ambiguityNote(query, graph, args.component, resolved);
}

// ============================================
// trace_prop
// ============================================

export function formatTraceProp(query: GraphQuery, graph: AnyGraph, args: { component: string; prop: string }): string {
  const resolved = resolveComponentOrExplain(query, graph, args.component);
  if (typeof resolved === 'string') return resolved;
  const trace = query.traceProp(resolved.id, args.prop);
  if (!trace) return `Component ${args.component} not found.`;
  const declared = resolved.props.find(p => p.name === args.prop);
  const out: string[] = [`# Prop "${args.prop}" of ${componentLabel(graph, resolved)}`];
  if (!declared && !trace.origins.length) {
    out.push(`${resolved.name} does not declare a prop named "${args.prop}". Its props: ${resolved.props.map(p => p.name).join(', ') || '(none)'}.`);
  } else if (declared) {
    out.push(`Declared${declared.type ? ` as ${clip(declared.type, 60)}` : ''}${declared.isUsed ? '' : ' — never used in this component'}${declared.passedTo.length ? `; forwarded to ${declared.passedTo.map(id => query.components.get(id)?.name ?? id).join(', ')}` : ''}.`);
  }

  out.push('', `## Origins (${trace.origins.length})`);
  if (!trace.origins.length) out.push('Not traced to component state (literal, computed value, module import, or a call site outside the analyzed code). See call sites.');
  trace.origins.forEach((o, n) => {
    out.push(`${n + 1}. ${o.isSetter ? 'setter of ' : ''}state "${o.state.name}" [${stateLabel(o.state)}] declared in ${o.owner.name} at ${loc(graph, o.state.filePath, o.state.line)}`);
    let prev = o.owner.name;
    for (const hop of o.chain) {
      out.push(`   ${prev} → ${hop.component.name} as "${hop.propName}"${hop.viaSpread ? ' (via spread)' : ''}${hop.location ? ` at ${loc(graph, hop.location.filePath, hop.location.line)}` : ''}`);
      prev = hop.component.name;
    }
    out.push(`   state id: ${o.state.id}`);
  });

  out.push('', `## Call sites (${trace.callSites.length})`);
  if (!trace.callSites.length) out.push('No parent renders this component in the analyzed code.');
  for (const s of trace.callSites.slice(0, 25)) {
    out.push(`- ${s.parent.name} at ${loc(graph, s.filePath, s.line)}${s.count > 1 ? ` (${s.count}×)` : ''}: ${s.value !== undefined ? `${args.prop}={${clip(s.value, 60)}}` : 'not passed'}`);
  }
  if (trace.callSites.length > 25) out.push(`…${trace.callSites.length - 25} more`);
  return out.join('\n');
}

// ============================================
// get_impact
// ============================================

export function formatImpact(
  query: GraphQuery,
  graph: AnyGraph,
  args: { component?: string; state?: string; context?: string; maxPerGroup?: number }
): string {
  let report: ImpactReport | undefined;
  let preface = '';

  if (args.context) {
    const contexts = contextEntries(query, graph);
    const q = args.context.trim();
    const matches = contexts.filter(c => c.id === q).length
      ? contexts.filter(c => c.id === q)
      : contexts.filter(c => c.name === q || c.name.toLowerCase() === q.toLowerCase() || c.id.toLowerCase().endsWith(q.toLowerCase()));
    if (!matches.length) {
      return `No context matches "${args.context}". Known contexts: ${contexts.map(c => `${c.name} [${c.id}]`).join(', ') || '(none)'}.`;
    }
    if (matches.length > 1) {
      return `"${args.context}" is ambiguous. Pass one of these context ids:\n${matches.map(c => `- ${c.id}`).join('\n')}`;
    }
    report = query.impactOfContext(matches[0]!.id);
  } else if (args.state) {
    let ownerId: string | undefined;
    if (args.component) {
      const owner = resolveComponentOrExplain(query, graph, args.component, 'owning component');
      if (typeof owner === 'string') return owner;
      ownerId = owner.id;
    }
    const states = query.findState(args.state.trim(), ownerId);
    if (!states.length) {
      const hint = ownerId
        ? ` ${query.components.get(ownerId)!.name} declares: ${query.components.get(ownerId)!.stateProvided.map(s => s.name).join(', ') || '(no state)'}.`
        : ' Pass the state id (see get_component) or the owning component.';
      return `No state matches "${args.state}".${hint}`;
    }
    if (states.length > 1) {
      return `"${args.state}" matches ${states.length} state declarations. Call again with one of these state ids (or add component):\n` +
        states.slice(0, 20).map(s => `- ${s.id} [${s.type}] in ${s.ownerId ? query.components.get(s.ownerId)?.name ?? s.ownerId : '?'} at ${loc(graph, s.filePath, s.line)}`).join('\n');
    }
    const s = states[0]!;
    preface = `State ${s.name} [${stateLabel(s)}] at ${loc(graph, s.filePath, s.line)}\n`;
    report = query.impactOfState(s.id);
  } else if (args.component) {
    const c = resolveComponentOrExplain(query, graph, args.component);
    if (typeof c === 'string') return c;
    preface = `Component ${componentLabel(graph, c)}\n`;
    report = query.impactOfComponent(c.id);
  } else {
    return 'Pass one of: component, state (optionally with component as its owner), or context.';
  }

  if (!report) return 'Nothing found to analyze.';
  const max = args.maxPerGroup ?? 25;
  const out = [`# Impact of changing ${report.target.kind} ${report.target.name}`, preface + report.summary];
  for (const g of report.groups) {
    out.push('', `## ${g.label} (${g.items.length})`);
    for (const item of g.items.slice(0, max)) {
      out.push(`- ${item.component.name} (${loc(graph, item.component.filePath, item.component.line)}) — ${item.reason}`);
    }
    if (g.items.length > max) out.push(`…${g.items.length - max} more`);
  }
  return out.join('\n');
}

// ============================================
// find_render_path
// ============================================

export function formatRenderPath(query: GraphQuery, graph: AnyGraph, args: { from: string; to: string }): string {
  const from = resolveComponentOrExplain(query, graph, args.from, 'start component');
  if (typeof from === 'string') return from;
  const to = resolveComponentOrExplain(query, graph, args.to, 'target component');
  if (typeof to === 'string') return to;

  const describe = (ids: string[]) => {
    const lines = [`${componentLabel(graph, query.components.get(ids[0]!)!)}`];
    for (let i = 1; i < ids.length; i++) {
      const site = query.children(ids[i - 1]!).find(r => r.to === ids[i]);
      const comp = query.components.get(ids[i]!)!;
      lines.push(`  → ${comp.name}${site ? ` rendered at ${loc(graph, site.filePath, site.line)} (${propsAtSite(site, 4)})` : ''}`);
    }
    return lines.join('\n');
  };

  const path = query.findRenderPath(from.id, to.id);
  if (path) {
    return `Render path ${from.name} → ${to.name} (${plural(path.length - 1, 'level')}):\n${describe(path)}`;
  }
  const reverse = query.findRenderPath(to.id, from.id);
  if (reverse) {
    return `${from.name} does not render ${to.name}, but ${to.name} renders ${from.name}:\n${describe(reverse)}`;
  }
  return `No render path between ${from.name} and ${to.name} in either direction. They may be connected only through routing, lazy loading, or code outside the analyzed directory.`;
}

// ============================================
// list_issues
// ============================================

export function formatIssues(
  query: GraphQuery,
  graph: AnyGraph,
  args: { code?: string; severity?: InsightSeverity; file?: string; limit?: number }
): string {
  let list = insightsOf(graph);
  const filters: string[] = [];
  if (args.code) {
    const code = args.code.toUpperCase();
    list = list.filter(i => i.code === code);
    filters.push(`code ${code}`);
  }
  if (args.severity) {
    const max = severityRank(args.severity);
    list = list.filter(i => severityRank(i.severity) <= max);
    filters.push(`severity ≥ ${args.severity}`);
  }
  if (args.file) {
    const f = toPosix(args.file).toLowerCase();
    list = list.filter(i => toPosix(i.filePath).toLowerCase().includes(f) || relPath(graph, i.filePath).toLowerCase().includes(f));
    filters.push(`file ~ ${args.file}`);
  }
  list = sortInsights(list);
  const limit = Math.max(1, Math.min(args.limit ?? 50, 500));
  const out = [`${plural(list.length, 'issue')}${filters.length ? ` (${filters.join(', ')})` : ''}: ${countsLine(list)}`];
  if (!list.length) return out[0] + (insightsOf(graph).length ? '' : '\nThe analysis found no issues.');
  for (const i of list.slice(0, limit)) out.push(insightLine(graph, i));
  if (list.length > limit) out.push(`…${list.length - limit} more (raise limit or filter by file/code)`);
  return out.join('\n');
}

// ============================================
// Fix targets (shared by plan_fix and `react-state-map fix`)
// ============================================

export interface FixTarget {
  index: number;                 // 1-based
  kind: 'lift-to-context' | 'remove-unused-prop';
  insight: Insight;
  drillingPathId?: string;
  chain?: string;
  values?: string[];
  label: string;
}

/** One target per PROP_DRILLING insight (lift to context) and per UNUSED_PROP insight */
export function listFixTargets(query: GraphQuery, graph: AnyGraph): FixTarget[] {
  const routes = drillingRoutes(graph);
  const targets: FixTarget[] = [];
  const drilling = sortInsights(insightsOf(graph).filter(i => i.code === 'PROP_DRILLING' && i.drillingPathId));
  for (const insight of drilling) {
    const route = routes.find(r => r.paths.some(p => p.id === insight.drillingPathId));
    const path = route?.paths.find(p => p.id === insight.drillingPathId) ?? graph.propDrillingPaths.find(p => p.id === insight.drillingPathId);
    targets.push({
      index: targets.length + 1,
      kind: 'lift-to-context',
      insight,
      drillingPathId: insight.drillingPathId,
      chain: route?.chain ?? path?.path.join(' → '),
      values: route?.values ?? (path ? [path.stateName] : []),
      label: `Lift ${(route?.values ?? [path?.stateName ?? '?']).map(v => `"${v}"`).join(', ')} into a context`,
    });
  }
  for (const insight of sortInsights(insightsOf(graph).filter(i => i.code === 'UNUSED_PROP'))) {
    const comp = insight.componentId ? query.components.get(insight.componentId) : undefined;
    targets.push({
      index: targets.length + 1,
      kind: 'remove-unused-prop',
      insight,
      label: `Remove unused prop "${insight.propName}"${comp ? ` from ${comp.name}` : ''}`,
    });
  }
  return targets;
}

/**
 * Resolve a fix target from a drilling path id, an insight id, or a 1-based index into listFixTargets().
 * PROP_PASSTHROUGH insights resolve to their drilling route.
 */
export function resolveFixTarget(query: GraphQuery, graph: AnyGraph, ref: string): FixTarget | string {
  const targets = listFixTargets(query, graph);
  const key = ref.trim();
  if (/^\d+$/.test(key)) {
    const t = targets[Number(key) - 1];
    return t ?? `No fix #${key}; there ${targets.length === 1 ? 'is' : 'are'} ${plural(targets.length, 'fixable item')}.`;
  }
  const byInsight = targets.find(t => t.insight.id === key);
  if (byInsight) return byInsight;
  const insight = insightsOf(graph).find(i => i.id === key);
  const pathId = insight?.drillingPathId ?? key;
  const path = graph.propDrillingPaths.find(p => p.id === pathId);
  if (path) {
    const route = drillingRoutes(graph).find(r => r.paths.includes(path));
    const existing = targets.find(t => t.drillingPathId && route?.paths.some(p => p.id === t.drillingPathId));
    if (existing) return { ...existing, drillingPathId: path.id };
    return {
      index: 0,
      kind: 'lift-to-context',
      insight: insight ?? {
        id: `PROP_DRILLING:${path.id}`, code: 'PROP_DRILLING', severity: 'warning', message: `${path.stateName} drilled through ${path.path.join(' → ')}`,
        filePath: '', line: 0, column: 0, drillingPathId: path.id,
      },
      drillingPathId: path.id,
      chain: path.path.join(' → '),
      values: route?.values ?? [path.stateName],
      label: `Lift "${path.stateName}" into a context`,
    };
  }
  if (insight) return `Insight ${insight.code} has no automatic fix (only PROP_DRILLING / PROP_PASSTHROUGH routes and UNUSED_PROP are fixable).`;
  return `No drilling path, insight or fix index matches "${ref}". Use list_issues or get_overview to find ids.`;
}

export function formatFixTargets(query: GraphQuery, graph: AnyGraph): string {
  const targets = listFixTargets(query, graph);
  if (!targets.length) return 'No fixable issues (no PROP_DRILLING or UNUSED_PROP insights).';
  const out: string[] = [];
  for (const t of targets) {
    const where = t.insight.filePath ? loc(graph, t.insight.filePath, t.insight.line) : '';
    out.push(`${t.index}. ${t.label}${t.insight.fixable === false ? ' (may not be applicable)' : ''}`);
    if (t.chain) out.push(`   chain: ${t.chain}`);
    if (where) out.push(`   at: ${where}`);
    out.push(`   id: ${t.drillingPathId ?? t.insight.id}`);
  }
  return out.join('\n');
}

// ============================================
// plan_fix
// ============================================

export function formatFixPlan(
  query: GraphQuery,
  graph: AnyGraph,
  args: { plan: FixPlan; target?: FixTarget; applyHint?: string }
): string {
  const { plan, target } = args;
  const out = [`# ${plan.title}`];
  if (target?.chain) out.push(`Route: ${target.chain}`);
  if (plan.description) out.push(plan.description);
  if (!plan.applicable) {
    out.push('', 'Status: NOT applicable automatically.');
    for (const r of plan.reasons) out.push(`- ${r}`);
    out.push('', 'Refactor by hand, e.g. move the state into a context provider above the consumers or use composition (pass elements as children).');
    return out.join('\n');
  }
  const created = plan.edits.filter(e => e.isNew).length;
  out.push(`Status: applicable — ${plural(plan.edits.length, 'file')} (${created} new, ${plan.edits.length - created} modified).`);
  if (plan.notes.length) {
    out.push('', 'Check before applying:');
    for (const n of plan.notes) out.push(`- ${n}`);
  }
  out.push('', args.applyHint ?? 'Nothing was written. Apply these unified diffs yourself (edit the files or use `git apply`), then re-run the analysis to confirm the drilling is gone.');
  out.push('', '```diff');
  for (const e of plan.edits) {
    const rel = relPath(graph, e.filePath);
    out.push(createUnifiedDiff(e.isNew ? null : rel, rel, e.isNew ? '' : e.oldText, e.newText).trimEnd());
  }
  out.push('```');
  return out.join('\n');
}

// ============================================
// Unified diff (Myers, line based, dependency free)
// ============================================

type DiffOp = { op: ' ' | '-' | '+'; text: string; noEol: boolean };

const NOEOL = '\u0000noeol';

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}

function myers(a: string[], b: string[]): DiffOp[] {
  // Trim common prefix/suffix (cheap and keeps the search small)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const A = a.slice(start, endA), B = b.slice(start, endB);
  const N = A.length, M = B.length, MAX = N + M;
  const mk = (op: DiffOp['op'], raw: string): DiffOp => ({ op, text: raw.endsWith(NOEOL) ? raw.slice(0, -NOEOL.length) : raw, noEol: raw.endsWith(NOEOL) });
  const middle: DiffOp[] = [];

  if (N === 0 || M === 0 || MAX > 20000) {
    // Trivial (or very large) change: replace the whole middle block
    for (const l of A) middle.push(mk('-', l));
    for (const l of B) middle.push(mk('+', l));
  } else {
    const offset = MAX;
    let v = new Int32Array(2 * MAX + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= MAX && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= N && y >= M) { found = true; break; }
      }
    }
    // Backtrack
    let x = N, y = M;
    const rev: DiffOp[] = [];
    for (let d = trace.length - 1; d >= 0; d--) {
      const vd = trace[d]!;
      const k = x - y;
      const prevK = (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) ? k + 1 : k - 1;
      const prevX = vd[offset + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { rev.push(mk(' ', A[x - 1]!)); x--; y--; }
      if (d > 0) {
        if (x === prevX) rev.push(mk('+', B[prevY]!));
        else rev.push(mk('-', A[prevX]!));
      }
      x = prevX; y = prevY;
    }
    middle.push(...rev.reverse());
  }

  return [
    ...a.slice(0, start).map(l => mk(' ', l)),
    ...middle,
    ...a.slice(endA).map(l => mk(' ', l)),
  ];
}

/**
 * Create a unified diff (git style). Pass oldPath = null for a new file.
 * Returns '' when the texts are identical.
 */
export function createUnifiedDiff(oldPath: string | null, newPath: string, oldText: string, newText: string, context = 3): string {
  if (oldText === newText && oldPath !== null) return '';
  const ops = myers(splitLines(oldText), splitLines(newText));
  const header = [
    `--- ${oldPath === null ? '/dev/null' : `a/${oldPath}`}`,
    `+++ b/${newPath}`,
  ];
  const changes = ops.map((o, i) => (o.op === ' ' ? -1 : i)).filter(i => i >= 0);
  if (!changes.length) return header.join('\n') + '\n';

  // Line counters before each op
  const aBefore: number[] = [], bBefore: number[] = [];
  let ac = 0, bc = 0;
  for (const o of ops) {
    aBefore.push(ac); bBefore.push(bc);
    if (o.op !== '+') ac++;
    if (o.op !== '-') bc++;
  }

  const hunks: Array<[number, number]> = [];
  let hs = Math.max(0, changes[0]! - context);
  let he = Math.min(ops.length, changes[0]! + context + 1);
  for (const c of changes.slice(1)) {
    if (c - context <= he) he = Math.min(ops.length, c + context + 1);
    else {
      hunks.push([hs, he]);
      hs = Math.max(0, c - context);
      he = Math.min(ops.length, c + context + 1);
    }
  }
  hunks.push([hs, he]);

  const body: string[] = [];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e);
    const oldLen = slice.filter(o => o.op !== '+').length;
    const newLen = slice.filter(o => o.op !== '-').length;
    const oldStart = oldLen ? aBefore[s]! + 1 : aBefore[s]!;
    const newStart = newLen ? bBefore[s]! + 1 : bBefore[s]!;
    body.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const o of slice) {
      body.push(o.op + o.text);
      if (o.noEol) body.push('\\ No newline at end of file');
    }
  }
  return [...header, ...body].join('\n') + '\n';
}

export interface LineEdit {
  /** 0-based first line replaced in the old text */
  startLine: number;
  /** Number of old lines replaced */
  deleteCount: number;
  /** Replacement lines (without trailing newline) */
  lines: string[];
}

/**
 * Line-level edits that turn oldText into newText — one per changed block, so editors can
 * show a refactor as several small, readable changes instead of one big replacement.
 */
export function diffLineEdits(oldText: string, newText: string): LineEdit[] {
  const ops = myers(splitLines(oldText), splitLines(newText));
  const edits: LineEdit[] = [];
  let line = 0;
  let current: LineEdit | undefined;
  for (const o of ops) {
    if (o.op === ' ') {
      if (current) {
        edits.push(current);
        current = undefined;
      }
      line++;
      continue;
    }
    current ??= { startLine: line, deleteCount: 0, lines: [] };
    if (o.op === '-') {
      current.deleteCount++;
      line++;
    } else {
      current.lines.push(o.text);
    }
  }
  if (current) edits.push(current);
  return edits;
}
