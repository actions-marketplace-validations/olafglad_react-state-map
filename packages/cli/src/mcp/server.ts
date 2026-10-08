import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GraphQuery, planLiftToContext, planRemoveUnusedProp } from '@react-state-map/core';
import type { ReactParser, StateFlowGraph, FixPlan } from '@react-state-map/core';
import { createParser, watchProject, type ProjectOptions, type WatchHandle } from '../shared/project.js';
import {
  formatOverview,
  formatFindComponents,
  formatComponent,
  formatTraceProp,
  formatImpact,
  formatRenderPath,
  formatIssues,
  formatFixPlan,
  resolveFixTarget,
} from '@react-state-map/core';

export interface McpServerOptions extends ProjectOptions {
  watch?: boolean;
  version: string;
}

const log = (msg: string) => process.stderr.write(`[react-state-map] ${msg}\n`);

/** Keeps one parser warm and re-links the graph incrementally when files change */
class AnalysisSession {
  private parser: ReactParser;
  private graph: StateFlowGraph | null = null;
  private query: GraphQuery | null = null;
  private watcher: WatchHandle | null = null;
  private dirty = false;
  private lastError: string | null = null;

  constructor(readonly rootDir: string, private options: McpServerOptions) {
    this.parser = createParser(rootDir, options);
  }

  start(): void {
    if (!this.graph) this.reparse('initial analysis');
    if (this.options.watch !== false) {
      this.watcher = watchProject(this.parser, this.rootDir, (changed) => {
        this.dirty = true;
        log(`${changed.length || 'config'} file change(s) queued`);
      }, { debounceMs: 200, log });
    }
  }

  private reparse(reason: string): void {
    const started = Date.now();
    try {
      const result = this.parser.parse();
      this.graph = result.graph;
      this.query = new GraphQuery(result.graph);
      this.lastError = null;
      if (result.errors.length) log(`${result.errors.length} file(s) failed to parse (first: ${result.errors[0]!.filePath}: ${result.errors[0]!.message})`);
      log(`${reason}: ${this.query.components.size} components, ${result.graph.insights.length} insights in ${Date.now() - started}ms`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      log(`analysis failed: ${this.lastError}`);
    }
  }

  /** Current analysis; applies pending file changes first so answers reflect the files on disk */
  current(): { graph: StateFlowGraph; query: GraphQuery } {
    this.watcher?.flush();
    if (this.dirty || !this.graph) {
      this.dirty = false;
      this.reparse('re-analysis');
    }
    if (!this.graph || !this.query) throw new Error(`Analysis is not available: ${this.lastError ?? 'unknown error'}`);
    return { graph: this.graph, query: this.query };
  }

  parserInstance(): ReactParser {
    return this.parser;
  }

  async close(): Promise<void> {
    await this.watcher?.close();
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function guard(fn: () => string): ToolResult {
  try {
    return text(fn());
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const INSTRUCTIONS = `React State Map statically analyzes the React/Next.js code in this project: components, who renders whom (with the props passed at each JSX site), where state lives (useState/useReducer, context, Redux, Zustand, Jotai, TanStack Query, …), how values flow through props, and issues such as prop drilling or Server/Client Component mistakes.
Use it before refactoring or changing state, props or context: get_overview first, then get_component / trace_prop / get_impact for specifics. It reads the files on disk (kept up to date by a file watcher), so results reflect saved changes. Locations are "path:line" relative to the analyzed root. plan_fix only returns diffs; apply them yourself.`;

export function createMcpServer(session: AnalysisSession, version: string): McpServer {
  const server = new McpServer(
    { name: 'react-state-map', version },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool('get_overview', {
    title: 'Project overview',
    description: 'Summarize the analyzed React project: component/state counts, detected frameworks (Next.js App Router, React version), the most important issues by severity, the longest prop-drilling chains (with drilling_path_id for plan_fix) and every context with its provider and consumer count. Call this first to orient yourself in an unfamiliar React codebase.',
    inputSchema: {},
    annotations: { title: 'Project overview', ...READ_ONLY },
  }, () => guard(() => {
    const { graph, query } = session.current();
    return formatOverview(query, graph);
  }));

  server.registerTool('find_components', {
    title: 'Find components',
    description: 'Search React components by name (exact, case-insensitive, or substring) or by part of the file path. Returns each match with file:line, component kind (function/arrow/class/memo/forwardRef), Server/Client environment when known, and its id. Use it to locate a component or disambiguate names before calling get_component, trace_prop or get_impact.',
    inputSchema: {
      query: z.string().min(1).describe('Component name, part of a name, or part of a file path, e.g. "UserMenu", "menu", "components/ui"'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum results (default 20)'),
    },
    annotations: { title: 'Find components', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatFindComponents(query, graph, args);
  }));

  server.registerTool('get_component', {
    title: 'Component details',
    description: 'Everything known about one component: its props (type, whether used, and which ancestor state each prop originates from and over how many hops), state it declares (type, library, store), state received from ancestors, contexts consumed and provided, which components render it (with the props passed at each call site) and which it renders, its role in prop-drilling chains, and its issues. Use before modifying a component\'s props, state or children.',
    inputSchema: {
      component: z.string().min(1).describe('Component name ("UserMenu"), "path/File.tsx#Name", or a component id from another tool ("c:src/components/UserMenu.tsx#UserMenu")'),
    },
    annotations: { title: 'Component details', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatComponent(query, graph, args);
  }));

  server.registerTool('trace_prop', {
    title: 'Trace a prop to its origin',
    description: 'Trace where a component\'s prop value comes from: walks up through every component that forwards it (handling renames and {...spread}) back to the state declaration that owns it (useState/useReducer/store/etc.), with file:line of each hand-off, and lists every call site that renders the component with the value passed there. Use it to answer "where does this prop come from / who sets it" before changing a prop.',
    inputSchema: {
      component: z.string().min(1).describe('Component that receives the prop (name, "path#Name" or id)'),
      prop: z.string().min(1).describe('Prop name as the component receives it, e.g. "selectedId"'),
    },
    annotations: { title: 'Trace a prop to its origin', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatTraceProp(query, graph, args);
  }));

  server.registerTool('get_impact', {
    title: 'Change impact',
    description: 'List which components are affected if you change something. Pass exactly one target: {component} — callers that must update props, components receiving data from it, consumers of contexts it provides, and its render subtree; {state} (state name or id, optionally with {component} = the owning component to disambiguate) — components receiving the value via props, components subscribed to the same store/atom/query/context, and components that re-render with the owner; {context} (context name or id) — every consumer and provider. Use before renaming/removing props, changing state shape, or changing a context value.',
    inputSchema: {
      component: z.string().optional().describe('Component name/id. Alone: impact of changing the component. With state: the component that owns the state'),
      state: z.string().optional().describe('State name (e.g. "selectedId", a setter name, or a store/atom/query key) or state id ("s:src/components/Shell.tsx#Shell.selectedId")'),
      context: z.string().optional().describe('Context name ("AuthContext") or id ("ctx:src/context/auth.tsx#AuthContext")'),
    },
    annotations: { title: 'Change impact', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatImpact(query, graph, args);
  }));

  server.registerTool('find_render_path', {
    title: 'Find render path',
    description: 'Find the shortest chain of components through which one component renders another (parent → … → descendant), with the file:line of each JSX call site and the props passed there. Checks the reverse direction too. Use it to understand how a component is reached in the tree or where to put a provider so a descendant can read it.',
    inputSchema: {
      from: z.string().min(1).describe('Ancestor component (name, "path#Name" or id)'),
      to: z.string().min(1).describe('Descendant component (name, "path#Name" or id)'),
    },
    annotations: { title: 'Find render path', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatRenderPath(query, graph, args);
  }));

  server.registerTool('list_issues', {
    title: 'List issues',
    description: 'List state-management issues found by the analysis, sorted by severity, with file:line, message, stable id and whether an automatic fix exists. Codes: PROP_DRILLING (state passed through components that only forward it), PROP_PASSTHROUGH (one forwarding component in such a chain), CONTEXT_LEAK (context value re-passed as props), PROP_BUNDLE (large object prop), UNUSED_PROP, SERVER_COMPONENT_HOOK (hook used in a Server Component), SERVER_TO_CLIENT_FUNCTION_PROP (function passed from a Server to a Client Component). Filter by code, minimum severity or file.',
    inputSchema: {
      code: z.enum(['PROP_DRILLING', 'PROP_PASSTHROUGH', 'CONTEXT_LEAK', 'PROP_BUNDLE', 'UNUSED_PROP', 'SERVER_COMPONENT_HOOK', 'SERVER_TO_CLIENT_FUNCTION_PROP']).optional().describe('Only this issue code'),
      severity: z.enum(['error', 'warning', 'info', 'hint']).optional().describe('Minimum severity (e.g. "warning" returns errors and warnings)'),
      file: z.string().optional().describe('Only issues whose file path contains this text'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum issues to return (default 50)'),
    },
    annotations: { title: 'List issues', ...READ_ONLY },
  }, (args) => guard(() => {
    const { graph, query } = session.current();
    return formatIssues(query, graph, args);
  }));

  server.registerTool('plan_fix', {
    title: 'Plan an automatic fix',
    description: 'Compute an automatic refactor and return it as unified diffs WITHOUT writing any files. Supports: lifting drilled state into a new React context (pass drilling_path_id, or the id of a PROP_DRILLING / PROP_PASSTHROUGH issue as insight_id) — creates the context + hook file, wraps the owner\'s JSX in the provider, removes the forwarded props from intermediate components and reads the value with the hook in the consumer; and removing an unused prop (insight_id of an UNUSED_PROP issue). The result says whether the fix is applicable and lists caveats. You must apply the diff yourself (edit the files), then verify with get_component or list_issues.',
    inputSchema: {
      drilling_path_id: z.string().optional().describe('drilling_path_id from get_overview, get_component or list_issues ("drill:…")'),
      insight_id: z.string().optional().describe('Issue id from list_issues (PROP_DRILLING, PROP_PASSTHROUGH or UNUSED_PROP)'),
    },
    annotations: { title: 'Plan an automatic fix', ...READ_ONLY },
  }, (args) => guard(() => {
    const ref = args.drilling_path_id ?? args.insight_id;
    if (!ref) return 'Pass drilling_path_id or insight_id (see list_issues / get_overview).';
    const { graph, query } = session.current();
    const target = resolveFixTarget(query, graph, ref);
    if (typeof target === 'string') return target;
    const parser = session.parserInstance();
    let plan: FixPlan;
    if (target.kind === 'remove-unused-prop') {
      plan = planRemoveUnusedProp(parser.getProject(), target.insight);
    } else {
      plan = planLiftToContext(parser.getProject(), graph, target.drillingPathId!, { react19: (parser.getReactMajor() ?? 0) >= 19 });
    }
    return formatFixPlan(query, graph, { plan, target });
  }));

  // Lightweight resources (same text as the tools) for clients that surface resources
  server.registerResource('overview', 'react-state-map://overview', {
    title: 'React State Map overview',
    description: 'Project overview: counts, frameworks, top issues, drilling chains and contexts',
    mimeType: 'text/plain',
  }, (uri) => {
    const { graph, query } = session.current();
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatOverview(query, graph) }] };
  });

  server.registerResource('issues', 'react-state-map://issues', {
    title: 'React State Map issues',
    description: 'All issues found by the analysis, sorted by severity',
    mimeType: 'text/plain',
  }, (uri) => {
    const { graph, query } = session.current();
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: formatIssues(query, graph, { limit: 500 }) }] };
  });

  return server;
}

export async function runMcpServer(rootDir: string, options: McpServerOptions): Promise<void> {
  // stdout belongs to the protocol: route any stray console output to stderr
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const session = new AnalysisSession(rootDir, options);
  const server = createMcpServer(session, options.version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server ready for ${rootDir}`);

  // Analyze after the handshake so clients don't time out on large projects; tool calls wait for it
  setImmediate(() => session.start());

  const shutdown = async () => {
    await session.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
