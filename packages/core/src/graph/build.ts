import * as path from 'node:path';
import type {
  StateFlowGraph,
  ComponentNode,
  StateNode,
  StateFlowEdge,
  RenderEdge,
  ContextBoundary,
  ContextInfo,
  PropDrillingPath,
  PropDrillingStep,
  PropDefinition,
  ComponentPropMetrics,
  ComponentRole,
  PropUsage,
  PropBundle,
  ContextLeak,
  ContextLeakSeverity,
  PropChain,
  PropRename,
  ParseWarning,
  Insight,
  SourceLocation,
} from '../types.js';
import type {
  FileFacts,
  ComponentFact,
  HookCallFact,
  HookDefFact,
  JsxElementFact,
  JsxPropFact,
  TypeShape,
  TypeMember,
} from '../parser/facts.js';
import type { ModuleResolver } from '../parser/module-resolver.js';
import { classifyHook, IGNORED_REACT_HOOKS, type HookSpec } from '../parser/hooks.js';

export interface ProjectInfo {
  rootDir: string;
  drillingThreshold: number;
  /** Package directories (normalized, forward slashes) that depend on `next` */
  nextRoots: string[];
  reactMajor: number | null;
}

export interface BuildOutput {
  graph: StateFlowGraph;
  warnings: ParseWarning[];
}

interface Sym {
  file: string;
  local: string;
}

interface ComponentEntry {
  node: ComponentNode;
  fact: ComponentFact;
  file: FileFacts;
}

interface HookSummary {
  contexts: Set<string>;
  clientOnly: boolean;
}

type ValueSource =
  | { kind: 'state'; stateId: string; isSetter: boolean }
  | { kind: 'prop'; propName: string; derived: boolean }
  | { kind: 'spread'; all: boolean }   // {...props} forwards all, {...rest} forwards non-destructured
  | null;

const DEFAULT_LOCAL = '__default__';

function normalizeContextName(name: string): string {
  return name.toLowerCase().replace(/(context|provider|consumer)$/i, '') || name.toLowerCase();
}

function looksLikePackage(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !/^(@\/|~\/?|#|\$)/.test(specifier);
}

export class GraphBuilder {
  private filesByPath: Map<string, FileFacts>;
  private componentsByKey = new Map<string, ComponentEntry>();   // file#local
  private componentsById = new Map<string, ComponentEntry>();
  private componentsByName = new Map<string, ComponentEntry[]>();
  private hookDefs = new Map<string, { file: FileFacts; def: HookDefFact }>();
  private contextDefs = new Map<string, { id: string; name: string; file: string; line: number }>();
  private contextsByName = new Map<string, string[]>();
  private storeDefs = new Map<string, { name: string; library: string; kind: string }>();
  private typeDefs = new Map<string, { file: FileFacts; shape: TypeShape }>();
  private hookSummaries = new Map<string, HookSummary>();
  private warnings: ParseWarning[] = [];
  private insights: Insight[] = [];
  private contextNames = new Map<string, string>();   // contextId → display name

  constructor(
    files: Iterable<FileFacts>,
    private resolver: ModuleResolver,
    private project: ProjectInfo
  ) {
    this.filesByPath = new Map([...files].map(f => [f.filePath, f]));
  }

  // ============================================
  // Paths and ids
  // ============================================

  private rel(filePath: string): string {
    const r = path.relative(this.project.rootDir, filePath).split(path.sep).join('/');
    return r.startsWith('..') ? filePath : r;
  }

  private loc(filePath: string, p: { line: number; column: number }): SourceLocation {
    return { filePath, line: p.line, column: p.column };
  }

  // ============================================
  // Symbol resolution (imports, re-exports, barrels)
  // ============================================

  private resolveModule(specifier: string, fromFile: string): string | null {
    const resolved = this.resolver.resolve(specifier, fromFile);
    return resolved && this.filesByPath.has(resolved) ? resolved : resolved;
  }

  private isDeclaredLocally(file: FileFacts, local: string): boolean {
    return (
      file.components.some(c => c.localName === local) ||
      file.hooks.some(h => h.name === local) ||
      file.contexts.some(c => c.name === local) ||
      file.stores.some(s => s.name === local) ||
      file.types.some(t => t.name === local) ||
      local in file.aliases
    );
  }

  resolveLocal(filePath: string, local: string, depth = 0): Sym | null {
    if (depth > 12) return null;
    const file = this.filesByPath.get(filePath);
    if (!file) return null;

    if (local in file.aliases) {
      return this.resolveLocal(filePath, file.aliases[local]!, depth + 1);
    }
    if (this.isDeclaredLocally(file, local)) return { file: filePath, local };

    const imp = file.imports.find(i => i.local === local);
    if (!imp) return null;
    const target = this.resolveModule(imp.specifier, filePath);
    if (!target) return null;
    if (imp.imported === '*') return { file: target, local: '*' };
    return this.resolveExport(target, imp.imported, depth + 1);
  }

  resolveExport(filePath: string, exported: string, depth = 0): Sym | null {
    if (depth > 12) return null;
    const file = this.filesByPath.get(filePath);
    if (!file) return null;

    for (const e of file.exports) {
      if (e.exported !== exported) continue;
      if (e.local) {
        if (e.local === DEFAULT_LOCAL) return { file: filePath, local: DEFAULT_LOCAL };
        return this.resolveLocal(filePath, e.local, depth + 1);
      }
      if (e.from) {
        const target = this.resolveModule(e.from, filePath);
        if (!target) return null;
        if (e.imported === '*') return { file: target, local: '*' };
        return this.resolveExport(target, e.imported ?? exported, depth + 1);
      }
    }

    if (exported !== 'default') {
      for (const star of file.starExports) {
        const target = this.resolveModule(star, filePath);
        if (!target) continue;
        const found = this.resolveExport(target, exported, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /** Resolve `Foo` or `UI.Button` as written in `filePath` */
  private resolveReference(filePath: string, ref: string): Sym | null {
    const parts = ref.split('.');
    if (parts.length === 1) return this.resolveLocal(filePath, ref);
    const ns = this.resolveLocal(filePath, parts[0]!);
    if (ns?.local === '*' && parts.length === 2) return this.resolveExport(ns.file, parts[1]!);
    return null;
  }

  private importFor(file: FileFacts, local: string) {
    return file.imports.find(i => i.local === local);
  }

  // ============================================
  // Build
  // ============================================

  build(): BuildOutput {
    this.indexDefinitions();
    const components = this.createComponents();
    this.computeHookSummaries();

    const stateNodes = new Map<string, StateNode>();
    const bindingsByComponent = new Map<string, Map<string, { state: StateNode; isSetter: boolean }>>();
    this.createStateNodes(stateNodes, bindingsByComponent);

    const { renders, resolvedJsx } = this.resolveJsx();
    this.addRouteEdges(renders);
    this.collectProviders();

    const edges: StateFlowEdge[] = [];
    this.computePropFlows(resolvedJsx, bindingsByComponent, stateNodes, edges);
    const contextBoundaries = this.computeContextFlows(edges);

    this.computeEnvironments(renders);

    const usagesByComponent = this.finalizeProps(resolvedJsx, edges);
    const componentMetrics = this.computeMetrics(usagesByComponent);
    const propDrillingPaths = this.detectDrilling(edges, stateNodes, usagesByComponent);
    const bundles = this.detectBundles(resolvedJsx);
    const contextLeaks = this.detectContextLeaks(resolvedJsx, bindingsByComponent);
    const propChains = this.buildPropChains();

    this.serverComponentInsights(resolvedJsx);
    this.unusedPropInsights(usagesByComponent);

    const graph: StateFlowGraph = {
      components,
      stateNodes,
      edges,
      contextBoundaries,
      propDrillingPaths,
      componentMetrics,
      bundles,
      contextLeaks,
      propChains,
      renders,
      insights: this.insights.sort((a, b) =>
        a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)
      ),
    };

    return { graph, warnings: this.warnings };
  }

  private indexDefinitions(): void {
    for (const file of this.filesByPath.values()) {
      for (const h of file.hooks) this.hookDefs.set(`${file.filePath}#${h.name}`, { file, def: h });
      for (const c of file.contexts) {
        const id = `ctx:${this.rel(file.filePath)}#${c.name}`;
        this.contextDefs.set(`${file.filePath}#${c.name}`, { id, name: c.name, file: file.filePath, line: c.line });
        this.contextNames.set(id, c.name);
        const list = this.contextsByName.get(c.name) ?? [];
        list.push(id);
        this.contextsByName.set(c.name, list);
      }
      for (const s of file.stores) this.storeDefs.set(`${file.filePath}#${s.name}`, s);
      for (const t of file.types) this.typeDefs.set(`${file.filePath}#${t.name}`, { file, shape: t });
    }
  }

  private createComponents(): Map<string, ComponentNode> {
    const components = new Map<string, ComponentNode>();
    const files = [...this.filesByPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));

    for (const file of files) {
      for (const fact of file.components) {
        let id = `c:${this.rel(file.filePath)}#${fact.name}`;
        if (components.has(id)) id = `${id}@${fact.line}`;

        const node: ComponentNode = {
          id,
          name: fact.name,
          filePath: file.filePath,
          line: fact.line,
          column: fact.column,
          endLine: fact.endLine,
          kind: fact.kind,
          stateUsed: [],
          stateProvided: [],
          contextProviders: [],
          contextConsumers: [],
          contextConsumerIds: [],
          props: [],
          isExported: fact.isExported,
          directive: file.directive,
        };
        components.set(id, node);

        const entry: ComponentEntry = { node, fact, file };
        this.componentsById.set(id, entry);
        this.componentsByKey.set(`${file.filePath}#${fact.localName}`, entry);
        const byName = this.componentsByName.get(fact.name) ?? [];
        byName.push(entry);
        this.componentsByName.set(fact.name, byName);
      }
    }
    return components;
  }

  // ============================================
  // Hooks, contexts and state
  // ============================================

  private resolveContextRef(filePath: string, ref: string): string {
    const sym = this.resolveReference(filePath, ref);
    if (sym) {
      const def = this.contextDefs.get(`${sym.file}#${sym.local}`);
      if (def) return def.id;
    }
    // Unresolvable: fall back to a unique same-named context in the project
    const byName = this.contextsByName.get(ref.split('.').pop()!);
    if (byName?.length === 1) return byName[0]!;
    const id = `ctx:ext:${normalizeContextName(ref)}`;
    if (!this.contextNames.has(id)) this.contextNames.set(id, ref);
    return id;
  }

  private isContextRef(filePath: string, ref: string): boolean {
    const sym = this.resolveReference(filePath, ref);
    if (sym && this.contextDefs.has(`${sym.file}#${sym.local}`)) return true;
    return /Context$/.test(ref);
  }

  /** Which project hook does this call refer to? */
  private resolveHookDef(file: FileFacts, call: HookCallFact): string | null {
    const ref = call.calleeRoot === call.callee ? call.callee : `${call.calleeRoot}.${call.callee}`;
    const sym = this.resolveReference(file.filePath, ref);
    if (!sym) return null;
    const key = `${sym.file}#${sym.local}`;
    return this.hookDefs.has(key) ? key : null;
  }

  private resolveStoreDef(file: FileFacts, call: HookCallFact): { name: string; library: string; kind: string } | null {
    if (call.calleeRoot !== call.callee) return null;
    const sym = this.resolveLocal(file.filePath, call.callee);
    if (!sym) return null;
    return this.storeDefs.get(`${sym.file}#${sym.local}`) ?? null;
  }

  private classifyExternal(file: FileFacts, call: HookCallFact): HookSpec | null {
    const imp = this.importFor(file, call.calleeRoot);
    return classifyHook(call.callee, imp?.specifier ?? null);
  }

  private computeHookSummaries(): void {
    const visiting = new Set<string>();
    const summarize = (key: string): HookSummary => {
      const cached = this.hookSummaries.get(key);
      if (cached) return cached;
      const summary: HookSummary = { contexts: new Set(), clientOnly: false };
      if (visiting.has(key)) return summary;
      visiting.add(key);

      const entry = this.hookDefs.get(key)!;
      summary.clientOnly = entry.def.usesClientOnlyHooks;
      for (const call of entry.def.calls) {
        const inner = this.resolveHookDef(entry.file, call);
        if (inner) {
          const s = summarize(inner);
          s.contexts.forEach(c => summary.contexts.add(c));
          summary.clientOnly ||= s.clientOnly;
          continue;
        }
        const spec = this.classifyExternal(entry.file, call);
        if (spec?.clientOnly) summary.clientOnly = true;
        if (spec?.contextArg && call.firstArgIdent && this.isContextRef(entry.file.filePath, call.firstArgIdent)) {
          summary.contexts.add(this.resolveContextRef(entry.file.filePath, call.firstArgIdent));
        }
      }

      visiting.delete(key);
      this.hookSummaries.set(key, summary);
      return summary;
    };
    for (const key of this.hookDefs.keys()) summarize(key);
  }

  private addConsumer(node: ComponentNode, contextId: string): void {
    if (!node.contextConsumerIds!.includes(contextId)) {
      node.contextConsumerIds!.push(contextId);
      node.contextConsumers.push(this.contextNames.get(contextId) ?? contextId);
    }
  }

  private createStateNodes(
    stateNodes: Map<string, StateNode>,
    bindingsByComponent: Map<string, Map<string, { state: StateNode; isSetter: boolean }>>
  ): void {
    for (const { node, fact, file } of this.componentsById.values()) {
      const bindings = new Map<string, { state: StateNode; isSetter: boolean }>();
      bindingsByComponent.set(node.id, bindings);

      const addState = (state: StateNode) => {
        stateNodes.set(state.id, state);
        node.stateProvided.push(state);
        for (const b of state.bindings ?? []) {
          bindings.set(b, { state, isSetter: b === state.setterName });
        }
      };

      for (const call of fact.hookCalls) {
        const base = {
          filePath: file.filePath,
          line: call.line,
          column: call.column,
          ownerId: node.id,
          bindings: call.bindings,
          setterName: call.setterName,
        };
        const makeId = (name: string) => {
          // Line numbers only on collisions, so ids (and insight fingerprints) survive unrelated edits
          const base = `s:${this.rel(file.filePath)}#${fact.name}.${name}`;
          return stateNodes.has(base) ? `${base}@${call.line}` : base;
        };

        const hookKey = this.resolveHookDef(file, call);
        // useMemo / useCallback / useRef … derive values, they don't hold state
        if (!hookKey && IGNORED_REACT_HOOKS.has(call.callee)) continue;
        if (hookKey) {
          const summary = this.hookSummaries.get(hookKey);
          summary?.contexts.forEach(ctx => this.addConsumer(node, ctx));
          if (!call.displayName) continue;
          const contexts = summary ? [...summary.contexts] : [];
          addState({
            id: makeId(call.displayName),
            type: 'customHook',
            name: call.displayName,
            hookName: call.callee,
            contextId: contexts.length === 1 ? contexts[0] : undefined,
            ...base,
          });
          continue;
        }

        const store = this.resolveStoreDef(file, call);
        if (store) {
          if (!call.displayName) continue;
          const type = store.library === 'zustand' ? 'zustand' : store.kind === 'atom' ? 'atom' : 'externalStore';
          addState({
            id: makeId(call.displayName),
            type,
            name: call.displayName,
            storeName: store.name,
            library: store.library,
            initialValue: call.firstArgText,
            ...base,
          });
          continue;
        }

        const spec = this.classifyExternal(file, call);

        if (spec?.contextArg) {
          const arg = call.firstArgIdent;
          if (arg && (call.callee === 'useContext' || this.isContextRef(file.filePath, arg))) {
            const contextId = this.resolveContextRef(file.filePath, arg);
            this.addConsumer(node, contextId);
            if (!call.displayName) continue;
            addState({
              id: makeId(call.displayName),
              type: 'useContext',
              name: call.displayName,
              initialValue: this.contextNames.get(contextId) ?? arg,
              contextId,
              library: spec.library,
              ...base,
            });
            continue;
          }
          if (call.callee === 'use') {
            // use(promise) — suspends on async data
            if (!call.displayName) continue;
            addState({
              id: makeId(call.displayName),
              type: 'serverState',
              name: call.displayName,
              library: 'react',
              initialValue: call.firstArgText,
              ...base,
            });
            continue;
          }
        }

        if (!call.displayName) continue;

        if (spec) {
          addState({
            id: makeId(call.displayName),
            type: spec.type,
            name: call.displayName,
            library: spec.library,
            initialValue: spec.type === 'useState' || spec.type === 'useReducer' || spec.type === 'useOptimistic' || spec.type === 'useActionState'
              ? call.firstArgText
              : undefined,
            storeName: storeNameFor(spec, call),
            ...base,
          });
          continue;
        }

        // Unknown hook from a library (useTranslation, useTheme from MUI…)
        addState({
          id: makeId(call.displayName),
          type: 'customHook',
          name: call.displayName,
          hookName: call.callee,
          ...base,
        });
      }

      if (fact.classState) {
        const name = fact.classState.keys.length ? fact.classState.keys.join(', ') : 'state';
        addState({
          id: `s:${this.rel(file.filePath)}#${fact.name}.state`,
          type: 'useState',
          name,
          library: 'react-class',
          filePath: file.filePath,
          line: fact.classState.line,
          column: fact.classState.column,
          ownerId: node.id,
          bindings: ['this.state'],
        });
      }
    }
  }

  // ============================================
  // JSX resolution and render edges
  // ============================================

  private resolveTag(entry: ComponentEntry, tag: string): ComponentEntry | null {
    const filePath = entry.file.filePath;
    const sym = this.resolveReference(filePath, tag);
    if (sym) {
      const found = this.componentsByKey.get(`${sym.file}#${sym.local}`);
      if (found) return found;
      // Resolved to a project file but not a component we know (e.g. a styled component)
      if (this.filesByPath.has(sym.file)) return null;
    }

    // Fallbacks when resolution failed: unresolvable alias, missing tsconfig, globals
    const root = tag.split('.')[0]!;
    const imp = this.importFor(entry.file, root);
    // Not declared here and not imported: don't guess by name (would create false render edges)
    if (!imp) return null;
    if (looksLikePackage(imp.specifier)) return null;
    if (imp && this.resolver.isExternal(imp.specifier, filePath)) return null;

    const lookupName = tag.includes('.')
      ? tag.split('.').pop()!
      : imp && imp.imported !== 'default' && imp.imported !== '*' ? imp.imported : tag;
    const candidates = this.componentsByName.get(lookupName) ?? [];
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      const sameFile = candidates.find(c => c.file.filePath === filePath);
      if (sameFile) return sameFile;
      if (imp) {
        const hint = imp.specifier.split('/').pop()!.replace(/\.\w+$/, '');
        const byPath = candidates.find(c => c.file.filePath.includes(`/${hint}`));
        if (byPath) return byPath;
      }
    }
    return null;
  }

  private resolveJsx(): {
    renders: RenderEdge[];
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>;
  } {
    const renders: RenderEdge[] = [];
    const seen = new Map<string, RenderEdge>();
    const resolvedJsx = new Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>();

    for (const entry of this.componentsById.values()) {
      const list: Array<{ element: JsxElementFact; child: ComponentEntry }> = [];
      for (const element of entry.fact.jsx) {
        if (element.tag.endsWith('.Provider') || element.tag.endsWith('.Consumer')) continue;
        const child = this.resolveTag(entry, element.tag);
        if (!child) continue;
        list.push({ element, child });
        const key = `${entry.node.id}>${child.node.id}`;
        const existing = seen.get(key);
        if (existing) {
          existing.count = (existing.count ?? 1) + 1;
        } else {
          const edge: RenderEdge = {
            from: entry.node.id,
            to: child.node.id,
            filePath: entry.file.filePath,
            line: element.line,
            column: element.column,
            count: 1,
            props: element.props.map(p => ({ name: p.name, value: p.valueText })),
          };
          seen.set(key, edge);
          renders.push(edge);
        }
      }
      resolvedJsx.set(entry.node.id, list);
    }
    return { renders, resolvedJsx };
  }

  /** In the App Router a layout renders its route segment through `children` — make that edge explicit */
  private addRouteEdges(renders: RenderEdge[]): void {
    if (!this.project.nextRoots.length) return;
    const ROUTE_FILES = /\/(page|layout|template|loading|error|not-found|default)\.(tsx|jsx|ts|js)$/;
    const defaultComponent = (file: string): ComponentEntry | undefined => {
      const sym = this.resolveExport(file, 'default');
      return sym ? this.componentsByKey.get(`${sym.file}#${sym.local}`) : undefined;
    };
    const layoutIn = new Map<string, ComponentEntry | undefined>();
    const findLayout = (dir: string): ComponentEntry | undefined => {
      if (layoutIn.has(dir)) return layoutIn.get(dir);
      const file = ['tsx', 'jsx', 'ts', 'js'].map(ext => `${dir}/layout.${ext}`).find(f => this.filesByPath.has(f));
      const entry = file ? defaultComponent(file) : undefined;
      layoutIn.set(dir, entry);
      return entry;
    };
    const seen = new Set(renders.map(r => `${r.from}>${r.to}`));

    for (const filePath of this.filesByPath.keys()) {
      if (!this.isInNextApp(filePath) || !/\/app\//.test(filePath)) continue;
      const match = filePath.match(ROUTE_FILES);
      if (!match) continue;
      const child = defaultComponent(filePath);
      if (!child) continue;
      // A page is wrapped by the layout in its own folder; a layout by the nearest one above it
      let dir = filePath.slice(0, filePath.lastIndexOf('/'));
      if (match[1] === 'layout') dir = dir.slice(0, dir.lastIndexOf('/'));
      let parent: ComponentEntry | undefined;
      while (dir.includes('/app')) {
        parent = findLayout(dir);
        if (parent && parent !== child) break;
        parent = undefined;
        if (/\/app$/.test(dir)) break;
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
      if (!parent || seen.has(`${parent.node.id}>${child.node.id}`)) continue;
      seen.add(`${parent.node.id}>${child.node.id}`);
      renders.push({
        from: parent.node.id,
        to: child.node.id,
        filePath: parent.file.filePath,
        line: parent.node.line,
        column: parent.node.column,
        count: 1,
        props: [{ name: 'children', value: '(route segment)' }],
        implicit: true,
      });
    }
  }

  private collectProviders(): void {
    for (const entry of this.componentsById.values()) {
      const filePath = entry.file.filePath;
      for (const element of entry.fact.jsx) {
        const valueProp = element.props.find(p => p.name === 'value');
        let contextId: string | null = null;

        if (element.tag.endsWith('.Provider')) {
          contextId = this.resolveContextRef(filePath, element.tag.slice(0, -'.Provider'.length));
        } else if (element.tag.endsWith('.Consumer')) {
          this.addConsumer(entry.node, this.resolveContextRef(filePath, element.tag.slice(0, -'.Consumer'.length)));
          continue;
        } else {
          const sym = this.resolveReference(filePath, element.tag);
          const def = sym ? this.contextDefs.get(`${sym.file}#${sym.local}`) : undefined;
          if (def) {
            contextId = def.id;   // React 19: <ThemeContext value={...}>
          } else if (/Provider$/.test(element.tag) && !this.resolveTag(entry, element.tag)) {
            // Library provider (QueryClientProvider, ThemeProvider from MUI…)
            const name = element.tag.split('.').pop()!.replace(/Provider$/, '') || element.tag;
            contextId = `ctx:ext:${normalizeContextName(name)}`;
            if (!this.contextNames.has(contextId)) this.contextNames.set(contextId, name);
          }
        }

        if (!contextId) continue;
        if (entry.node.contextProviders.some(p => p.contextId === contextId)) continue;
        const providerValueProp = valueProp ?? element.props.find(p => ['store', 'client', 'theme', 'config'].includes(p.name));
        const info: ContextInfo = {
          contextId,
          contextName: this.contextNames.get(contextId) ?? contextId,
          providerValue: providerValueProp?.valueText,
        };
        entry.node.contextProviders.push(info);
      }
    }
  }

  // ============================================
  // Prop flows
  // ============================================

  private valueSource(
    entry: ComponentEntry,
    prop: JsxPropFact,
    bindings: Map<string, { state: StateNode; isSetter: boolean }>
  ): ValueSource {
    const { fact } = entry;
    const root = prop.root;
    const pathParts = prop.path ?? [];
    if (!root) return null;

    if (prop.kind === 'spread') {
      if (root === fact.propsParam && pathParts.length === 0) return { kind: 'spread', all: true };
      if (root === 'this' && pathParts.length === 1 && pathParts[0] === 'props') return { kind: 'spread', all: true };
      if (root === fact.restName && pathParts.length === 0) return { kind: 'spread', all: false };
      return null;
    }
    if (prop.kind !== 'identifier' && prop.kind !== 'member') return null;

    // this.props.x / this.state.x (class components)
    if (root === 'this') {
      if (pathParts[0] === 'props' && pathParts[1]) return { kind: 'prop', propName: pathParts[1], derived: pathParts.length > 2 };
      if (pathParts[0] === 'state') {
        const s = bindings.get('this.state');
        if (s) return { kind: 'state', stateId: s.state.id, isSetter: false };
      }
      return null;
    }

    // props.user (non-destructured)
    if (fact.propsParam && root === fact.propsParam && pathParts[0]) {
      return { kind: 'prop', propName: pathParts[0], derived: pathParts.length > 1 };
    }

    const state = bindings.get(root);
    if (state) return { kind: 'state', stateId: state.state.id, isSetter: state.isSetter };

    const prop0 = fact.props.find(p => p.localName === root);
    if (prop0) return { kind: 'prop', propName: prop0.name, derived: pathParts.length > 0 };

    const alias = fact.aliasToProp[root];
    if (alias) return { kind: 'prop', propName: alias, derived: true };

    return null;
  }

  private computePropFlows(
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>,
    bindingsByComponent: Map<string, Map<string, { state: StateNode; isSetter: boolean }>>,
    stateNodes: Map<string, StateNode>,
    edges: StateFlowEdge[]
  ): void {
    const edgeIndex = new Map<string, StateFlowEdge>();
    // incoming[componentId][propName] → edges delivering state under that prop name
    const incoming = new Map<string, Map<string, StateFlowEdge[]>>();
    const maxHops = Math.max(4, this.componentsById.size + 1);

    const addEdge = (
      from: ComponentEntry,
      to: ComponentEntry,
      stateId: string,
      propName: string,
      hops: number,
      prop: JsxPropFact,
      extra: { viaSpread?: boolean; isSetter?: boolean; fromProp?: string }
    ): boolean => {
      const key = `${from.node.id}|${to.node.id}|${stateId}|${propName}|${extra.fromProp ?? ''}`;
      const existing = edgeIndex.get(key);
      if (existing) {
        if (existing.hops < hops && hops <= maxHops) {
          existing.hops = hops;
          return true;
        }
        return false;
      }
      const edge: StateFlowEdge = {
        id: `edge_${edges.length}`,
        from: from.node.id,
        to: to.node.id,
        stateId,
        mechanism: 'props',
        propName,
        hops,
        location: this.loc(from.file.filePath, prop),
        ...(extra.viaSpread ? { viaSpread: true } : {}),
        ...(extra.isSetter ? { isSetter: true } : {}),
        ...(extra.fromProp ? { fromProp: extra.fromProp } : {}),
      };
      edges.push(edge);
      edgeIndex.set(key, edge);
      const byProp = incoming.get(to.node.id) ?? new Map<string, StateFlowEdge[]>();
      const list = byProp.get(propName) ?? [];
      list.push(edge);
      byProp.set(propName, list);
      incoming.set(to.node.id, byProp);

      const state = stateNodes.get(stateId);
      if (state && !to.node.stateUsed.some(s => s.id === stateId)) to.node.stateUsed.push(state);
      return true;
    };

    // Pass 1: state originating in a component
    for (const [componentId, list] of resolvedJsx) {
      const entry = this.componentsById.get(componentId)!;
      const bindings = bindingsByComponent.get(componentId)!;
      for (const { element, child } of list) {
        for (const prop of element.props) {
          const source = this.valueSource(entry, prop, bindings);
          if (source?.kind === 'state') {
            addEdge(entry, child, source.stateId, prop.name, 1, prop, { isSetter: source.isSetter });
          }
        }
      }
    }

    // Pass 2..n: forwarding of received props (fixpoint)
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 50) {
      changed = false;
      iterations++;
      for (const [componentId, list] of resolvedJsx) {
        const received = incoming.get(componentId);
        if (!received) continue;
        const entry = this.componentsById.get(componentId)!;
        const bindings = bindingsByComponent.get(componentId)!;
        const destructured = new Set(entry.fact.props.filter(p => p.destructured).map(p => p.name));

        for (const { element, child } of list) {
          for (const prop of element.props) {
            const source = this.valueSource(entry, prop, bindings);
            if (!source) continue;

            if (source.kind === 'prop' && !source.derived) {
              for (const inEdge of received.get(source.propName) ?? []) {
                if (addEdge(entry, child, inEdge.stateId, prop.name, inEdge.hops + 1, prop, { isSetter: inEdge.isSetter, fromProp: source.propName })) {
                  changed = true;
                }
              }
            } else if (source.kind === 'spread') {
              for (const [propName, inEdges] of received) {
                if (!source.all && destructured.has(propName)) continue;
                // Explicit props after the spread override it
                if (element.props.some(p => p.name === propName && p.kind !== 'spread')) continue;
                for (const inEdge of inEdges) {
                  if (addEdge(entry, child, inEdge.stateId, propName, inEdge.hops + 1, prop, { viaSpread: true, isSetter: inEdge.isSetter, fromProp: propName })) {
                    changed = true;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private computeContextFlows(edges: StateFlowEdge[]): ContextBoundary[] {
    const boundaries: ContextBoundary[] = [];
    for (const provider of this.componentsById.values()) {
      for (const info of provider.node.contextProviders) {
        const boundary: ContextBoundary = {
          contextId: info.contextId,
          contextName: info.contextName,
          providerComponent: provider.node.id,
          providerFile: provider.file.filePath,
          providerLine: provider.node.line,
          childComponents: [],
        };
        for (const consumer of this.componentsById.values()) {
          if (!consumer.node.contextConsumerIds?.includes(info.contextId)) continue;
          boundary.childComponents.push(consumer.node.id);
          edges.push({
            id: `edge_${edges.length}`,
            from: provider.node.id,
            to: consumer.node.id,
            stateId: info.contextId,
            mechanism: 'context',
            hops: 0,
          });
        }
        boundaries.push(boundary);
      }
    }
    return boundaries;
  }

  // ============================================
  // Server / client components (Next.js App Router)
  // ============================================

  private isInNextApp(filePath: string): boolean {
    return this.project.nextRoots.some(root => filePath.startsWith(root + '/'));
  }

  private computeEnvironments(renders: RenderEdge[]): void {
    const children = new Map<string, string[]>();
    for (const r of renders) {
      const list = children.get(r.from) ?? [];
      list.push(r.to);
      children.set(r.from, list);
    }

    const client = new Set<string>();
    const server = new Set<string>();
    const queue: string[] = [];

    for (const entry of this.componentsById.values()) {
      if (entry.file.directive === 'use client') {
        client.add(entry.node.id);
      }
    }

    // Client propagation: anything rendered (imported) by a client component is client code
    queue.push(...client);
    while (queue.length) {
      const id = queue.shift()!;
      for (const child of children.get(id) ?? []) {
        if (!client.has(child)) {
          client.add(child);
          queue.push(child);
        }
      }
    }

    // Server roots: App Router files without 'use client'
    for (const entry of this.componentsById.values()) {
      const fp = entry.file.filePath;
      if (!this.isInNextApp(fp) || entry.file.directive === 'use client') continue;
      if (/\/app\//.test(fp)) server.add(entry.node.id);
    }
    queue.push(...server);
    while (queue.length) {
      const id = queue.shift()!;
      for (const child of children.get(id) ?? []) {
        const childEntry = this.componentsById.get(child)!;
        if (childEntry.file.directive === 'use client' || server.has(child)) continue;
        server.add(child);
        queue.push(child);
      }
    }

    for (const entry of this.componentsById.values()) {
      if (server.has(entry.node.id)) entry.node.environment = 'server';
      else if (client.has(entry.node.id)) entry.node.environment = 'client';
    }
  }

  private serverComponentInsights(
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>
  ): void {
    for (const entry of this.componentsById.values()) {
      if (entry.node.environment !== 'server') continue;

      // Hooks in Server Components
      for (const call of entry.fact.hookCalls) {
        const hookKey = this.resolveHookDef(entry.file, call);
        const clientOnly = hookKey
          ? this.hookSummaries.get(hookKey)?.clientOnly
          : this.classifyExternal(entry.file, call)?.clientOnly;
        if (!clientOnly) continue;
        this.insights.push({
          id: `SERVER_COMPONENT_HOOK:${entry.node.id}:${call.callee}`,
          code: 'SERVER_COMPONENT_HOOK',
          severity: 'error',
          message: `${call.callee} only works in Client Components, but ${entry.node.name} is rendered as a Server Component. Add "use client" at the top of the file, or move the stateful part into a Client Component.`,
          filePath: entry.file.filePath,
          line: call.line,
          column: call.column,
          componentId: entry.node.id,
        });
        break;
      }

      // Functions passed across the server → client boundary
      for (const { element, child } of resolvedJsx.get(entry.node.id) ?? []) {
        if (child.file.directive !== 'use client') continue;
        for (const prop of element.props) {
          if (prop.kind !== 'function' || prop.functionUsesServerDirective) continue;
          this.insights.push({
            id: `SERVER_TO_CLIENT_FUNCTION_PROP:${entry.node.id}>${child.node.id}:${prop.name}`,
            code: 'SERVER_TO_CLIENT_FUNCTION_PROP',
            severity: 'error',
            message: `Function prop "${prop.name}" is passed from Server Component ${entry.node.name} to Client Component ${child.node.name}. Functions can't cross the server/client boundary unless they are Server Actions ("use server").`,
            filePath: entry.file.filePath,
            line: prop.line,
            column: prop.column,
            endLine: prop.endLine,
            endColumn: prop.endColumn,
            componentId: entry.node.id,
            propName: prop.name,
          });
        }
      }
    }
  }

  // ============================================
  // Props, usage and metrics
  // ============================================

  private resolveTypeMembers(file: FileFacts, shape: TypeShape, depth = 0, seen = new Set<string>()): TypeMember[] {
    const members = [...shape.members];
    if (depth > 6) return members;
    for (const ref of shape.refs) {
      const sym = this.resolveReference(file.filePath, ref.name);
      if (!sym) continue;
      const key = `${sym.file}#${sym.local}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const def = this.typeDefs.get(key);
      if (!def) continue;
      for (const m of this.resolveTypeMembers(def.file, def.shape, depth + 1, seen)) {
        if (!members.some(x => x.name === m.name)) members.push(m);
      }
    }
    return members;
  }

  private finalizeProps(
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>,
    edges: StateFlowEdge[]
  ): Map<string, PropUsage[]> {
    const usagesByComponent = new Map<string, PropUsage[]>();

    for (const entry of this.componentsById.values()) {
      const { fact, node, file } = entry;
      const typeMembers = this.resolveTypeMembers(file, fact.propsTypes);
      const props: PropDefinition[] = fact.props.map(p => {
        const member = typeMembers.find(m => m.name === p.name);
        return {
          name: p.name,
          type: p.type ?? member?.type,
          isUsed: true,
          passedTo: [],
          ...(p.localName !== p.name ? { localName: p.localName } : {}),
          line: p.line,
          column: p.column,
          optional: p.optional || member?.optional || undefined,
        };
      });

      // When props aren't fully destructured, declared type members are props too
      const includeTypeOnly = !!fact.propsParam || !!fact.restName;
      if (includeTypeOnly) {
        for (const m of typeMembers) {
          if (props.some(p => p.name === m.name) || m.name === 'children' || m.name === 'key' || m.name === 'ref') continue;
          props.push({ name: m.name, type: m.type, isUsed: false, passedTo: [], optional: m.optional || undefined });
        }
      }

      const usages: PropUsage[] = props.map(p => {
        const u = fact.propUsages.find(x => x.propName === p.name);
        return u ?? {
          propName: p.name,
          usedInRender: false,
          passedToChild: false,
          usedInCallback: false,
          usedInEffect: false,
          usedInLogic: false,
          transformed: false,
        };
      });

      // Props forwarded through {...rest}/{...props} count as passed to children
      const outgoing = edges.filter(e => e.from === node.id && e.mechanism === 'props');
      for (const u of usages) {
        if (!u.passedToChild && outgoing.some(e => e.viaSpread && e.propName === u.propName)) u.passedToChild = true;
      }
      for (const p of props) {
        const u = usages.find(x => x.propName === p.name)!;
        p.isUsed = u.usedInRender || u.usedInLogic || u.usedInEffect || u.usedInCallback || u.transformed || u.passedToChild;
      }

      // passedTo: which children receive this prop
      for (const { element, child } of resolvedJsx.get(node.id) ?? []) {
        for (const jp of element.props) {
          const local = jp.root;
          if (!local) continue;
          const target = props.find(p => (p.localName ?? p.name) === local || (fact.propsParam === local && jp.path?.[0] === p.name));
          if (target && !target.passedTo.includes(child.node.name)) target.passedTo.push(child.node.name);
        }
      }

      node.props = props;
      usagesByComponent.set(node.id, usages);
    }

    return usagesByComponent;
  }

  private computeMetrics(usagesByComponent: Map<string, PropUsage[]>): ComponentPropMetrics[] {
    const metrics: ComponentPropMetrics[] = [];
    for (const { node } of this.componentsById.values()) {
      const propUsages = usagesByComponent.get(node.id) ?? [];
      if (propUsages.length === 0) continue;

      let consumed = 0, passed = 0, transformed = 0, ignored = 0;
      for (const u of propUsages) {
        const isConsumed = u.usedInRender || u.usedInCallback || u.usedInEffect || u.usedInLogic;
        if (isConsumed) consumed++;
        if (u.passedToChild) passed++;
        if (u.transformed) transformed++;
        if (!isConsumed && !u.passedToChild && !u.transformed) ignored++;
      }
      const total = propUsages.length;
      const passthroughRatio = passed / total;
      const consumptionRatio = consumed / total;
      let role: ComponentRole;
      if (passthroughRatio > 0.7 && consumptionRatio < 0.3) role = 'passthrough';
      else if (consumptionRatio > 0.7) role = 'consumer';
      else if (transformed > 0 && transformed >= passed * 0.5) role = 'transformer';
      else role = 'mixed';

      metrics.push({
        componentId: node.id,
        componentName: node.name,
        filePath: node.filePath,
        totalPropsReceived: total,
        propsConsumed: consumed,
        propsPassed: passed,
        propsTransformed: transformed,
        propsIgnored: ignored,
        passthroughRatio,
        consumptionRatio,
        role,
        propUsages,
      });
    }
    return metrics;
  }

  // ============================================
  // Prop drilling
  // ============================================

  private detectDrilling(
    edges: StateFlowEdge[],
    stateNodes: Map<string, StateNode>,
    usagesByComponent: Map<string, PropUsage[]>
  ): PropDrillingPath[] {
    const threshold = this.project.drillingThreshold;
    const paths: PropDrillingPath[] = [];
    const byState = new Map<string, StateFlowEdge[]>();
    for (const e of edges) {
      if (e.mechanism !== 'props') continue;
      const list = byState.get(e.stateId) ?? [];
      list.push(e);
      byState.set(e.stateId, list);
    }

    const consumes = (componentId: string, propName: string): boolean => {
      const u = usagesByComponent.get(componentId)?.find(x => x.propName === propName);
      if (!u) return false;
      return u.usedInRender || u.usedInLogic || u.usedInEffect || u.usedInCallback || u.transformed;
    };

    for (const [stateId, stateEdges] of byState) {
      const state = stateNodes.get(stateId);
      if (!state?.ownerId) continue;
      const outgoing = new Map<string, StateFlowEdge[]>();
      for (const e of stateEdges) {
        const list = outgoing.get(e.from) ?? [];
        list.push(e);
        outgoing.set(e.from, list);
      }

      const found: StateFlowEdge[][] = [];
      const walk = (componentId: string, trail: StateFlowEdge[], visited: Set<string>) => {
        if (found.length >= 100) return;
        const last = trail[trail.length - 1];
        // Follow one value thread: the next hop must forward the prop this component received
        const next = (outgoing.get(componentId) ?? []).filter(e =>
          !visited.has(e.to) && (last ? e.fromProp === last.propName : !e.fromProp)
        );
        if (last) {
          // A path ends where the value is used, or where it stops flowing
          if (consumes(componentId, last.propName!) || next.length === 0) found.push([...trail]);
        }
        for (const e of next) {
          visited.add(e.to);
          walk(e.to, [...trail, e], visited);
          visited.delete(e.to);
        }
      };
      walk(state.ownerId, [], new Set([state.ownerId]));

      for (const trail of found) {
        const componentIds = [state.ownerId, ...trail.map(e => e.to)];
        if (componentIds.length < threshold + 1) continue;

        const passThroughIds: string[] = [];
        for (let i = 1; i < trail.length; i++) {
          const inbound = trail[i - 1]!;
          if (!consumes(componentIds[i]!, inbound.propName!)) passThroughIds.push(componentIds[i]!);
        }
        if (passThroughIds.length < threshold - 1) continue;

        const names = componentIds.map(id => this.componentsById.get(id)!.node.name);
        const steps: PropDrillingStep[] = trail.map(e => ({
          from: e.from,
          to: e.to,
          propName: e.propName!,
          location: e.location,
          ...(e.viaSpread ? { viaSpread: true } : {}),
        }));
        const consumerId = componentIds[componentIds.length - 1]!;
        const id = `drill:${stateId}>${trail.map(e => `${e.to}.${e.propName}`).join('>')}`;

        const drilling: PropDrillingPath = {
          id,
          stateId,
          stateName: trail[0]!.isSetter ? state.setterName ?? state.name : state.name,
          origin: state.ownerId,
          path: names,
          hops: names.length,
          propNames: trail.map(e => e.propName!),
          componentIds,
          steps,
          passThroughIds,
          consumerId,
        };
        paths.push(drilling);

      }
    }

    this.emitDrillingInsights(paths, stateNodes);
    return paths;
  }

  /** One PROP_DRILLING insight per (state, component route) — a value and its setter drilled together read as one problem */
  private emitDrillingInsights(paths: PropDrillingPath[], stateNodes: Map<string, StateNode>): void {
    const groups = new Map<string, PropDrillingPath[]>();
    for (const p of paths) {
      const key = `${p.stateId}|${p.componentIds!.join('>')}`;
      const list = groups.get(key) ?? [];
      list.push(p);
      groups.set(key, list);
    }

    const seenHints = new Set<string>();
    for (const group of groups.values()) {
      const first = group[0]!;
      const state = stateNodes.get(first.stateId)!;
      const names = first.path;
      const values = [...new Set(group.map(p => p.stateName))];
      const valueText = values.map(v => `"${v}"`).join(' and ');
      const passCount = first.passThroughIds!.length;
      const consumer = this.componentsById.get(first.consumerId!)!.node;
      const step0 = first.steps![0]!;

      this.warnings.push({
        filePath: state.filePath,
        line: state.line,
        column: state.column,
        message: `Prop drilling: ${valueText} ${values.length > 1 ? 'pass' : 'passes'} through ${passCount} forwarding component${passCount === 1 ? '' : 's'} (${names.join(' → ')})`,
        code: 'PROP_DRILLING',
      });

      const related: NonNullable<Insight['related']> = [
        { filePath: state.filePath, line: state.line, column: state.column, message: `"${state.name}" is declared here` },
      ];
      for (const p of group) {
        for (const s of p.steps!.slice(1)) {
          if (!s.location) continue;
          related.push({
            ...s.location,
            message: `${this.componentsById.get(s.from)!.node.name} forwards it as "${s.propName}"${s.viaSpread ? ' (via spread)' : ''}`,
          });
        }
      }
      related.push({ filePath: consumer.filePath, line: consumer.line, column: consumer.column, message: `${consumer.name} uses it` });

      this.insights.push({
        id: `PROP_DRILLING:${first.id}`,
        code: 'PROP_DRILLING',
        severity: 'warning',
        message: `${valueText} ${values.length > 1 ? 'are' : 'is'} drilled through ${passCount} component${passCount === 1 ? '' : 's'} that only forward ${values.length > 1 ? 'them' : 'it'}: ${names.join(' → ')}`,
        filePath: step0.location?.filePath ?? state.filePath,
        line: step0.location?.line ?? state.line,
        column: step0.location?.column ?? state.column,
        componentId: state.ownerId,
        stateId: state.id,
        drillingPathId: first.id,
        propName: step0.propName,
        fixable: true,
        related: dedupeLocations(related),
      });

      for (const p of group) {
        const steps = p.steps!;
        for (let i = 1; i < steps.length; i++) {
          const step = steps[i]!;
          if (!p.passThroughIds!.includes(step.from) || !step.location) continue;
          const key = `${step.location.filePath}:${step.location.line}:${step.location.column}:${steps[i - 1]!.propName}`;
          if (seenHints.has(key)) continue;
          seenHints.add(key);
          this.insights.push({
            id: `PROP_PASSTHROUGH:${p.id}:${step.from}`,
            code: 'PROP_PASSTHROUGH',
            severity: 'hint',
            message: `"${steps[i - 1]!.propName}" is only forwarded here (${names[0]} → … → ${names[names.length - 1]}, prop drilling)`,
            filePath: step.location.filePath,
            line: step.location.line,
            column: step.location.column,
            componentId: step.from,
            stateId: p.stateId,
            drillingPathId: p.id,
            propName: step.propName,
            fixable: true,
          });
        }
      }
    }
  }

  // ============================================
  // Bundles
  // ============================================

  private detectBundles(
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>
  ): PropBundle[] {
    const bundles: PropBundle[] = [];
    let counter = 0;
    const bundleNamePattern = /(data|config|options|info|value|state|props|settings|params|context|fields|form)$/i;

    const forwardsBundle = (entry: ComponentEntry, propName: string) =>
      (resolvedJsx.get(entry.node.id) ?? []).filter(({ element }) =>
        element.props.some(p =>
          p.name === propName ||
          (p.kind === 'spread') ||
          (p.kind === 'identifier' && bundleNamePattern.test(p.name) &&
            p.name.toLowerCase().includes(propName.toLowerCase().replace(/data|info|value|state/i, '')))
        )
      );

    for (const entry of this.componentsById.values()) {
      for (const { element, child } of resolvedJsx.get(entry.node.id) ?? []) {
        for (const prop of element.props) {
          const isObject = prop.kind === 'object' && (prop.objectProperties?.filter(p => p !== '...spread').length ?? 0) >= 3;
          const isSpread = prop.kind === 'spread';
          if (!isObject && !isSpread) continue;

          const properties = prop.objectProperties ?? [];
          const bundle: PropBundle = {
            id: `bundle_${++counter}`,
            propName: prop.name,
            sourceComponentId: entry.node.id,
            sourceComponentName: entry.node.name,
            estimatedSize: isObject ? properties.filter(p => p !== '...spread').length : -1,
            properties,
            passedThrough: [],
            isObjectLiteral: isObject,
            filePath: entry.file.filePath,
            line: prop.line,
          };

          const visited = new Set<string>();
          const queue: ComponentEntry[] = [child];
          while (queue.length) {
            const current = queue.shift()!;
            if (visited.has(current.node.id)) continue;
            visited.add(current.node.id);
            const forwards = forwardsBundle(current, bundle.propName);
            if (forwards.length) {
              if (!bundle.passedThrough.includes(current.node.id)) bundle.passedThrough.push(current.node.id);
              forwards.forEach(f => queue.push(f.child));
            }
          }
          bundles.push(bundle);

          if (bundle.estimatedSize >= 5) {
            this.warnings.push({
              filePath: entry.file.filePath,
              line: prop.line,
              column: prop.column,
              message: `Large prop bundle "${prop.name}" with ${bundle.estimatedSize} properties passed to ${child.node.name}`,
              code: 'PROP_BUNDLE',
            });
            this.insights.push({
              id: `PROP_BUNDLE:${entry.node.id}>${child.node.id}:${prop.name}`,
              code: 'PROP_BUNDLE',
              severity: 'info',
              message: `Large prop bundle "${prop.name}" (${bundle.estimatedSize} properties) passed to ${child.node.name}. Consider passing only what ${child.node.name} needs.`,
              filePath: entry.file.filePath,
              line: prop.line,
              column: prop.column,
              endLine: prop.endLine,
              endColumn: prop.endColumn,
              componentId: entry.node.id,
              propName: prop.name,
            });
          }
        }
      }
    }
    return bundles;
  }

  // ============================================
  // Context leaks
  // ============================================

  private detectContextLeaks(
    resolvedJsx: Map<string, Array<{ element: JsxElementFact; child: ComponentEntry }>>,
    bindingsByComponent: Map<string, Map<string, { state: StateNode; isSetter: boolean }>>
  ): ContextLeak[] {
    const leaks: ContextLeak[] = [];
    let counter = 0;

    for (const entry of this.componentsById.values()) {
      const bindings = bindingsByComponent.get(entry.node.id)!;
      const contextStates = entry.node.stateProvided.filter(s => s.contextId && (s.type === 'useContext' || s.type === 'customHook'));

      for (const state of contextStates) {
        const passedTo = new Map<string, { entry: ComponentEntry; propNames: string[] }>();
        const extracted = new Set<string>();

        for (const { element, child } of resolvedJsx.get(entry.node.id) ?? []) {
          for (const prop of element.props) {
            if (!prop.root || (prop.kind !== 'identifier' && prop.kind !== 'member')) continue;
            const b = bindings.get(prop.root);
            if (b?.state.id !== state.id) continue;
            extracted.add(prop.root);
            const item = passedTo.get(child.node.id) ?? { entry: child, propNames: [] };
            if (!item.propNames.includes(prop.name)) item.propNames.push(prop.name);
            passedTo.set(child.node.id, item);
          }
        }
        if (passedTo.size === 0) continue;

        const contextName = this.contextNames.get(state.contextId!) ?? state.contextId!;
        const list = [...passedTo.values()].map(p => ({
          componentId: p.entry.node.id,
          componentName: p.entry.node.name,
          propNames: p.propNames,
        }));
        const totalProps = list.reduce((n, p) => n + p.propNames.length, 0);
        const severity: ContextLeakSeverity = totalProps >= 5 || list.length >= 3 ? 'high' : totalProps >= 3 || list.length >= 2 ? 'medium' : 'low';
        const accessor = state.type === 'customHook' && state.hookName ? `${state.hookName}()` : `useContext(${contextName})`;
        const childNames = list.map(p => p.componentName).join(', ');
        const potentialFix = list.length === 1
          ? `${list[0]!.componentName} can call ${accessor} directly instead of receiving ${list[0]!.propNames.join(', ')} as props`
          : `${childNames} can each call ${accessor} directly`;

        leaks.push({
          id: `leak_${++counter}`,
          contextName,
          leakingComponentId: entry.node.id,
          leakingComponentName: entry.node.name,
          extractedValues: [...extracted],
          passedTo: list,
          severity,
          potentialFix,
          filePath: entry.file.filePath,
          line: state.line,
        });

        this.warnings.push({
          filePath: entry.file.filePath,
          line: state.line,
          column: state.column,
          message: `Context leak: ${entry.node.name} extracts from ${contextName} and passes to ${childNames} as props`,
          code: 'CONTEXT_LEAK',
        });
        this.insights.push({
          id: `CONTEXT_LEAK:${entry.node.id}:${state.contextId}`,
          code: 'CONTEXT_LEAK',
          severity: 'info',
          message: `${entry.node.name} reads ${contextName} and re-passes it as props to ${childNames}. ${potentialFix}.`,
          filePath: entry.file.filePath,
          line: state.line,
          column: state.column,
          componentId: entry.node.id,
          stateId: state.id,
        });
      }
    }
    return leaks;
  }

  // ============================================
  // Renames
  // ============================================

  private buildPropChains(): PropChain[] {
    const chains: PropChain[] = [];
    let counter = 0;
    for (const { node, fact } of this.componentsById.values()) {
      if (fact.renames.length === 0) continue;
      const renames: PropRename[] = fact.renames.map(r => ({ ...r, componentId: node.id }));
      chains.push({
        id: `chain_${++counter}`,
        originalName: renames[0]!.fromName,
        renames,
        finalName: renames[renames.length - 1]!.toName,
        depth: renames.length,
      });
      if (renames.length >= 2) {
        this.warnings.push({
          filePath: renames[0]!.filePath,
          line: renames[0]!.line,
          message: `Prop renamed ${renames.length} times in ${node.name}: ${renames.map(r => `${r.fromName}→${r.toName}`).join(', ')}`,
          code: 'PROP_RENAME_CHAIN',
        });
      }
    }
    return chains;
  }

  // ============================================
  // Unused props
  // ============================================

  private unusedPropInsights(usagesByComponent: Map<string, PropUsage[]>): void {
    for (const { node, fact, file } of this.componentsById.values()) {
      const usages = usagesByComponent.get(node.id) ?? [];
      for (const p of fact.props) {
        if (!p.destructured || p.name === 'children') continue;
        const u = usages.find(x => x.propName === p.name);
        if (!u) continue;
        const used = u.usedInRender || u.usedInLogic || u.usedInEffect || u.usedInCallback || u.transformed || u.passedToChild;
        if (used) continue;
        this.insights.push({
          id: `UNUSED_PROP:${node.id}:${p.name}`,
          code: 'UNUSED_PROP',
          severity: 'hint',
          message: `Prop "${p.name}" is received by ${node.name} but never used or forwarded.`,
          filePath: file.filePath,
          line: p.line,
          column: p.column,
          endLine: p.line,
          endColumn: p.column + p.localName.length + (p.localName !== p.name ? p.name.length + 2 : 0),
          componentId: node.id,
          propName: p.name,
          fixable: true,
        });
      }
    }
  }
}

function dedupeLocations<T extends SourceLocation>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(i => {
    const key = `${i.filePath}:${i.line}:${i.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function storeNameFor(spec: HookSpec, call: HookCallFact): string | undefined {
  const arg = call.firstArgText;
  switch (spec.type) {
    case 'atom':
      return call.firstArgIdent ?? arg;
    case 'serverState': {
      const key = arg?.match(/queryKey\s*:\s*(\[[^\]]*\]|[\w.]+)/);
      if (key) return key[1];
      if (spec.library === 'swr') return arg;
      return spec.library === 'rtk-query' ? call.callee : undefined;
    }
    case 'redux': {
      if (call.callee.endsWith('Dispatch')) return 'dispatch';
      const m = arg?.match(/=>\s*\(?\s*\w+\s*\)?\s*\.\s*(\w+)/) ?? arg?.match(/^\(?\s*\w+[^)]*\)?\s*=>\s*\w+\.(\w+)/);
      return m?.[1];
    }
    case 'zustand':
      return call.callee;
    case 'machine':
      return call.firstArgIdent;
    default:
      return undefined;
  }
}
