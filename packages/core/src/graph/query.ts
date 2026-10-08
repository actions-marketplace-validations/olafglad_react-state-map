import type {
  StateFlowGraph,
  SerializedStateFlowGraph,
  ComponentNode,
  StateNode,
  StateFlowEdge,
  RenderEdge,
  PropDrillingPath,
  Insight,
  ComponentPropMetrics,
  SourceLocation,
  ContextBoundary,
} from '../types.js';

export interface ComponentRef {
  id: string;
  name: string;
  filePath: string;
  line: number;
}

export interface PropOriginHop {
  component: ComponentRef;
  propName: string;            // Name the value has when it arrives at `component`
  location?: SourceLocation;   // Where the previous component passes it
  viaSpread?: boolean;
}

export interface PropOrigin {
  state: StateNode;
  owner: ComponentRef;
  /** Hops from the owner to the queried component (owner first) */
  chain: PropOriginHop[];
  isSetter: boolean;
}

export interface CallSite {
  parent: ComponentRef;
  filePath: string;
  line: number;
  column: number;
  value?: string;              // Value passed for the queried prop at this site
  count: number;
}

export interface PropTrace {
  component: ComponentRef;
  propName: string;
  origins: PropOrigin[];
  callSites: CallSite[];
}

export interface ImpactItem {
  component: ComponentRef;
  reason: string;
}

export interface ImpactGroup {
  key: 'direct' | 'subscribers' | 'rerender' | 'callers' | 'consumers' | 'descendants';
  label: string;
  items: ImpactItem[];
}

export interface ImpactReport {
  target: { kind: 'state' | 'component' | 'context'; id: string; name: string };
  groups: ImpactGroup[];
  componentIds: string[];      // Union of every affected component (excluding the target itself)
  summary: string;
}

export interface ComponentInsightSummary {
  component: ComponentNode;
  renderedBy: Array<{ component: ComponentRef; site: RenderEdge }>;
  renders: Array<{ component: ComponentRef; site: RenderEdge }>;
  stateDeclared: StateNode[];
  contextsConsumed: string[];
  contextsProvided: string[];
  propsReceived: Array<{ name: string; type?: string; fromState?: string; hops?: number; used: boolean }>;
  drilling: PropDrillingPath[];      // Paths this component participates in
  metrics?: ComponentPropMetrics;
  insights: Insight[];
}

const normalize = (p: string) => p.replace(/\\/g, '/');

/**
 * Read-only query layer over an analyzed graph. Used by the editor integration, the MCP server,
 * the language-model tools and the CLI — so every surface answers questions the same way.
 */
export class GraphQuery {
  readonly components: Map<string, ComponentNode>;
  readonly stateNodes: Map<string, StateNode>;
  readonly edges: StateFlowEdge[];
  readonly renders: RenderEdge[];
  readonly insights: Insight[];
  readonly drilling: PropDrillingPath[];
  readonly boundaries: ContextBoundary[];
  readonly metrics: ComponentPropMetrics[];

  private byFile = new Map<string, ComponentNode[]>();
  private childrenOf = new Map<string, RenderEdge[]>();
  private parentsOf = new Map<string, RenderEdge[]>();
  private incomingProps = new Map<string, StateFlowEdge[]>();
  private outgoingProps = new Map<string, StateFlowEdge[]>();
  private insightsByFile = new Map<string, Insight[]>();

  constructor(graph: StateFlowGraph | SerializedStateFlowGraph) {
    this.components = graph.components instanceof Map ? graph.components : new Map(Object.entries(graph.components));
    this.stateNodes = graph.stateNodes instanceof Map ? graph.stateNodes : new Map(Object.entries(graph.stateNodes));
    this.edges = graph.edges;
    this.renders = graph.renders ?? [];
    this.insights = graph.insights ?? [];
    this.drilling = graph.propDrillingPaths;
    this.boundaries = graph.contextBoundaries;
    this.metrics = graph.componentMetrics ?? [];

    for (const c of this.components.values()) {
      const key = normalize(c.filePath);
      const list = this.byFile.get(key) ?? [];
      list.push(c);
      this.byFile.set(key, list);
    }
    for (const list of this.byFile.values()) list.sort((a, b) => a.line - b.line);

    for (const r of this.renders) {
      push(this.childrenOf, r.from, r);
      push(this.parentsOf, r.to, r);
    }
    for (const e of this.edges) {
      if (e.mechanism !== 'props') continue;
      push(this.incomingProps, e.to, e);
      push(this.outgoingProps, e.from, e);
    }
    for (const i of this.insights) push(this.insightsByFile, normalize(i.filePath), i);
  }

  ref(id: string): ComponentRef | undefined {
    const c = this.components.get(id);
    return c ? { id: c.id, name: c.name, filePath: c.filePath, line: c.line } : undefined;
  }

  // ============================================
  // Lookup
  // ============================================

  componentsInFile(filePath: string): ComponentNode[] {
    return this.byFile.get(normalize(filePath)) ?? [];
  }

  /** Innermost component whose declaration spans `line` (1-based) */
  componentAt(filePath: string, line: number): ComponentNode | undefined {
    let best: ComponentNode | undefined;
    for (const c of this.componentsInFile(filePath)) {
      const end = c.endLine ?? c.line;
      if (line >= c.line && line <= end) {
        if (!best || c.line >= best.line) best = c;
      }
    }
    return best;
  }

  stateAt(filePath: string, line: number): StateNode[] {
    const key = normalize(filePath);
    return [...this.stateNodes.values()].filter(s => normalize(s.filePath) === key && s.line === line);
  }

  insightsInFile(filePath: string): Insight[] {
    return this.insightsByFile.get(normalize(filePath)) ?? [];
  }

  /** Find components by id, exact name, or case-insensitive substring of name/path */
  findComponents(query: string, limit = 20): ComponentNode[] {
    const byId = this.components.get(query);
    if (byId) return [byId];
    const q = query.toLowerCase();
    const all = [...this.components.values()];
    const exact = all.filter(c => c.name === query);
    const ci = all.filter(c => c.name.toLowerCase() === q && !exact.includes(c));
    const partial = all.filter(c =>
      !exact.includes(c) && !ci.includes(c) &&
      (c.name.toLowerCase().includes(q) || normalize(c.filePath).toLowerCase().includes(q))
    );
    return [...exact, ...ci, ...partial].slice(0, limit);
  }

  /** Resolve "Name", "path/File.tsx#Name" or an id to a single component */
  resolveComponent(query: string): ComponentNode | undefined {
    if (this.components.has(query)) return this.components.get(query);
    if (query.includes('#')) {
      const [file, name] = query.split('#');
      return [...this.components.values()].find(c => c.name === name && normalize(c.filePath).endsWith(normalize(file!)));
    }
    return this.findComponents(query, 1)[0];
  }

  findState(query: string, componentId?: string): StateNode[] {
    if (this.stateNodes.has(query)) return [this.stateNodes.get(query)!];
    const q = query.toLowerCase();
    return [...this.stateNodes.values()].filter(s =>
      (!componentId || s.ownerId === componentId) &&
      (s.name.toLowerCase() === q ||
        s.bindings?.some(b => b.toLowerCase() === q) ||
        s.storeName?.toLowerCase() === q ||
        s.name.toLowerCase().split(/,\s*/).includes(q))
    );
  }

  // ============================================
  // Relationships
  // ============================================

  parents(componentId: string): RenderEdge[] {
    return this.parentsOf.get(componentId) ?? [];
  }

  children(componentId: string): RenderEdge[] {
    return this.childrenOf.get(componentId) ?? [];
  }

  /** All components rendered (transitively) below a component */
  descendants(componentId: string, limit = 2000): string[] {
    const seen = new Set<string>([componentId]);
    const queue = [componentId];
    while (queue.length && seen.size <= limit) {
      const id = queue.shift()!;
      for (const r of this.children(id)) {
        if (!seen.has(r.to)) {
          seen.add(r.to);
          queue.push(r.to);
        }
      }
    }
    seen.delete(componentId);
    return [...seen];
  }

  /** Shortest render path from one component to another (ids, inclusive) */
  findRenderPath(fromId: string, toId: string): string[] | null {
    if (fromId === toId) return [fromId];
    const prev = new Map<string, string>();
    const queue = [fromId];
    const seen = new Set([fromId]);
    while (queue.length) {
      const id = queue.shift()!;
      for (const r of this.children(id)) {
        if (seen.has(r.to)) continue;
        seen.add(r.to);
        prev.set(r.to, id);
        if (r.to === toId) {
          const path = [toId];
          let cur = toId;
          while (prev.has(cur)) {
            cur = prev.get(cur)!;
            path.unshift(cur);
          }
          return path;
        }
        queue.push(r.to);
      }
    }
    return null;
  }

  contextConsumers(contextId: string): ComponentNode[] {
    return [...this.components.values()].filter(c => c.contextConsumerIds?.includes(contextId));
  }

  contextProviders(contextId: string): ComponentNode[] {
    return [...this.components.values()].filter(c => c.contextProviders.some(p => p.contextId === contextId));
  }

  /** Components subscribed to the same external store / atom / query key as a state node */
  sharedSubscribers(state: StateNode): StateNode[] {
    if (!state.storeName || !['zustand', 'redux', 'atom', 'serverState', 'externalStore', 'machine'].includes(state.type)) return [];
    if (state.type === 'redux' && state.storeName === 'dispatch') return [];
    return [...this.stateNodes.values()].filter(s =>
      s.id !== state.id && s.type === state.type && s.storeName === state.storeName && (s.library ?? '') === (state.library ?? '')
    );
  }

  drillingFor(componentId: string): PropDrillingPath[] {
    return this.drilling.filter(d => d.componentIds?.includes(componentId) ?? d.path.includes(this.components.get(componentId)?.name ?? '\0'));
  }

  // ============================================
  // Prop tracing
  // ============================================

  traceProp(componentId: string, propName: string): PropTrace | undefined {
    const component = this.ref(componentId);
    if (!component) return undefined;

    const origins: PropOrigin[] = [];
    const seenOrigins = new Set<string>();

    const walk = (edge: StateFlowEdge, chain: PropOriginHop[], depth: number) => {
      const hop: PropOriginHop = {
        component: this.ref(edge.to)!,
        propName: edge.propName!,
        location: edge.location,
        ...(edge.viaSpread ? { viaSpread: true } : {}),
      };
      const nextChain = [hop, ...chain];
      if (!edge.fromProp || depth > 50) {
        const state = this.stateNodes.get(edge.stateId);
        const owner = this.ref(edge.from);
        if (!state || !owner) return;
        const key = `${state.id}|${nextChain.map(h => `${h.component.id}.${h.propName}`).join('>')}`;
        if (seenOrigins.has(key)) return;
        seenOrigins.add(key);
        origins.push({ state, owner, chain: nextChain, isSetter: !!edge.isSetter });
        return;
      }
      for (const prev of this.incomingProps.get(edge.from) ?? []) {
        if (prev.propName === edge.fromProp && prev.stateId === edge.stateId) walk(prev, nextChain, depth + 1);
      }
    };

    for (const edge of this.incomingProps.get(componentId) ?? []) {
      if (edge.propName === propName) walk(edge, [], 0);
    }

    const callSites: CallSite[] = this.parents(componentId).map(r => ({
      parent: this.ref(r.from)!,
      filePath: r.filePath,
      line: r.line,
      column: r.column,
      value: r.props?.find(p => p.name === propName)?.value ?? (r.props?.some(p => p.name === '...spread') ? '(via spread)' : undefined),
      count: r.count ?? 1,
    }));

    return { component, propName, origins, callSites };
  }

  // ============================================
  // Impact analysis
  // ============================================

  impactOfState(stateId: string): ImpactReport | undefined {
    const state = this.stateNodes.get(stateId);
    if (!state) return undefined;
    const groups: ImpactGroup[] = [];
    const owner = state.ownerId ? this.components.get(state.ownerId) : undefined;

    // Components that receive the value through props
    const direct = new Map<string, ImpactItem>();
    for (const e of this.edges) {
      if (e.mechanism !== 'props' || e.stateId !== stateId) continue;
      if (!direct.has(e.to)) {
        direct.set(e.to, {
          component: this.ref(e.to)!,
          reason: `receives it as "${e.propName}"${e.hops > 1 ? ` (${e.hops} hops)` : ''}`,
        });
      }
    }
    if (direct.size) groups.push({ key: 'direct', label: 'Receives the value via props', items: [...direct.values()] });

    // Shared stores / atoms / queries / contexts
    const subscribers = new Map<string, ImpactItem>();
    for (const s of this.sharedSubscribers(state)) {
      if (s.ownerId && s.ownerId !== state.ownerId && !subscribers.has(s.ownerId)) {
        subscribers.set(s.ownerId, { component: this.ref(s.ownerId)!, reason: `also reads ${s.storeName} (${s.library ?? s.type})` });
      }
    }
    if (state.contextId) {
      for (const c of this.contextConsumers(state.contextId)) {
        if (c.id !== state.ownerId && !subscribers.has(c.id)) {
          subscribers.set(c.id, { component: this.ref(c.id)!, reason: 'consumes the same context' });
        }
      }
    }
    if (subscribers.size) groups.push({ key: 'subscribers', label: 'Subscribed to the same source', items: [...subscribers.values()] });

    // Local state re-renders the owner's subtree
    if (owner && ['useState', 'useReducer', 'useActionState', 'useOptimistic'].includes(state.type)) {
      const items = this.descendants(owner.id)
        .filter(id => !direct.has(id))
        .map(id => {
          const c = this.components.get(id)!;
          return {
            component: this.ref(id)!,
            reason: c.kind === 'memo' ? 'memoized — re-renders only if its props change' : 'rendered below the owner',
          };
        });
      if (items.length) groups.push({ key: 'rerender', label: `Re-renders with ${owner.name}`, items });
    }

    // Context providers: every consumer re-renders when the value changes
    const providedContexts = owner?.contextProviders.filter(p =>
      p.providerValue && state.bindings?.some(b => new RegExp(`\\b${escapeRegExp(b)}\\b`).test(p.providerValue!))
    ) ?? [];
    for (const p of providedContexts) {
      const items = this.contextConsumers(p.contextId).map(c => ({ component: this.ref(c.id)!, reason: `consumes ${p.contextName}` }));
      if (items.length) groups.push({ key: 'consumers', label: `Provided through ${p.contextName}`, items });
    }

    return this.report({ kind: 'state', id: state.id, name: state.name }, groups, owner?.id);
  }

  impactOfComponent(componentId: string): ImpactReport | undefined {
    const component = this.components.get(componentId);
    if (!component) return undefined;
    const groups: ImpactGroup[] = [];

    const callers = this.parents(componentId).map(r => ({
      component: this.ref(r.from)!,
      reason: `renders it at ${shortPath(r.filePath)}:${r.line}${(r.count ?? 1) > 1 ? ` (${r.count}×)` : ''}`,
    }));
    if (callers.length) groups.push({ key: 'callers', label: 'Call sites (affected by prop changes)', items: callers });

    const flows = new Map<string, ImpactItem>();
    for (const e of this.outgoingProps.get(componentId) ?? []) {
      for (const id of [e.to, ...this.downstreamOf(e)]) {
        const state = this.stateNodes.get(e.stateId);
        const value = (e.isSetter ? state?.setterName : state?.name) ?? e.propName;
        if (!flows.has(id)) flows.set(id, { component: this.ref(id)!, reason: `receives "${value}" from it` });
      }
    }
    if (flows.size) groups.push({ key: 'direct', label: 'Receives data from it', items: [...flows.values()] });

    for (const p of component.contextProviders) {
      const items = this.contextConsumers(p.contextId).map(c => ({ component: this.ref(c.id)!, reason: `consumes ${p.contextName}` }));
      if (items.length) groups.push({ key: 'consumers', label: `Consumers of ${p.contextName}`, items });
    }

    const descendants = this.descendants(componentId).filter(id => !flows.has(id));
    if (descendants.length) {
      groups.push({
        key: 'descendants',
        label: 'Rendered below it',
        items: descendants.map(id => ({ component: this.ref(id)!, reason: 'in its render subtree' })),
      });
    }

    return this.report({ kind: 'component', id: component.id, name: component.name }, groups, component.id);
  }

  impactOfContext(contextId: string): ImpactReport | undefined {
    const boundary = this.boundaries.find(b => b.contextId === contextId);
    const consumers = this.contextConsumers(contextId);
    if (!boundary && consumers.length === 0) return undefined;
    const name = boundary?.contextName ?? contextId;
    const groups: ImpactGroup[] = [];
    if (consumers.length) {
      groups.push({ key: 'consumers', label: `Consumers of ${name}`, items: consumers.map(c => ({ component: this.ref(c.id)!, reason: 'reads the context' })) });
    }
    const providers = this.contextProviders(contextId);
    if (providers.length) {
      groups.push({ key: 'callers', label: 'Providers', items: providers.map(c => ({ component: this.ref(c.id)!, reason: 'provides the value' })) });
    }
    return this.report({ kind: 'context', id: contextId, name }, groups);
  }

  private downstreamOf(edge: StateFlowEdge): string[] {
    const out: string[] = [];
    const queue = [edge];
    const seen = new Set<string>();
    while (queue.length) {
      const e = queue.shift()!;
      for (const next of this.outgoingProps.get(e.to) ?? []) {
        if (next.stateId !== e.stateId || next.fromProp !== e.propName) continue;
        const key = `${next.from}>${next.to}:${next.propName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(next.to);
        queue.push(next);
      }
    }
    return out;
  }

  private report(target: ImpactReport['target'], groups: ImpactGroup[], excludeId?: string): ImpactReport {
    for (const g of groups) g.items = g.items.filter(i => i.component.id !== excludeId);
    const filtered = groups.filter(g => g.items.length);
    const ids = new Set<string>();
    filtered.forEach(g => g.items.forEach(i => ids.add(i.component.id)));
    const words: Record<ImpactGroup['key'], [string, string]> = {
      direct: ['direct', 'direct'],
      subscribers: ['subscriber', 'subscribers'],
      consumers: ['consumer', 'consumers'],
      callers: ['call site', 'call sites'],
      rerender: ['below', 'below'],
      descendants: ['below', 'below'],
    };
    const parts = filtered.map(g => `${g.items.length} ${words[g.key][g.items.length === 1 ? 0 : 1]}`);
    return {
      target,
      groups: filtered,
      componentIds: [...ids],
      summary: ids.size === 0
        ? `Nothing else depends on ${target.name}.`
        : `${ids.size} component${ids.size === 1 ? '' : 's'} affected (${parts.join(', ')})`,
    };
  }

  // ============================================
  // Summaries
  // ============================================

  summarizeComponent(componentId: string): ComponentInsightSummary | undefined {
    const component = this.components.get(componentId);
    if (!component) return undefined;
    const incoming = this.incomingProps.get(componentId) ?? [];

    return {
      component,
      renderedBy: this.parents(componentId).map(site => ({ component: this.ref(site.from)!, site })),
      renders: this.children(componentId).map(site => ({ component: this.ref(site.to)!, site })),
      stateDeclared: component.stateProvided,
      contextsConsumed: component.contextConsumers,
      contextsProvided: component.contextProviders.map(p => p.contextName),
      propsReceived: component.props.map(p => {
        const edge = incoming.find(e => e.propName === p.name);
        return {
          name: p.name,
          type: p.type,
          fromState: edge ? this.stateNodes.get(edge.stateId)?.name : undefined,
          hops: edge?.hops,
          used: p.isUsed,
        };
      }),
      drilling: this.drillingFor(componentId),
      metrics: this.metrics.find(m => m.componentId === componentId),
      insights: this.insights.filter(i => i.componentId === componentId),
    };
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortPath(p: string): string {
  return normalize(p).split('/').slice(-2).join('/');
}
