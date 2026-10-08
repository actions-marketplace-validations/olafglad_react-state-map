# @react-state-map/core

**The engine behind React State Map: a static analyzer that knows where every prop in a React app comes from.**

Point it at a project and get a queryable graph of components, render edges, state, prop flows and contexts — resolved through imports exactly the way TypeScript does (path aliases, barrels, project references) — plus diagnostics, impact analysis and safe automatic refactors. It powers the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=OlafGlad.react-state-map-vscode) and the [CLI / MCP server](https://www.npmjs.com/package/@react-state-map/cli); use it to build your own lint rules, codemods, dashboards or agent tools.

```bash
npm install @react-state-map/core
```

Node.js 18+. No runtime instrumentation and no build step: it reads your source files.

## Quick start

```ts
import { ReactParser, GraphQuery } from '@react-state-map/core';

const parser = new ReactParser({ rootDir: './my-app' });
const { graph } = parser.parse();
const q = new GraphQuery(graph);

// Where does UserMenu's `onSelect` prop come from?
const menu = q.resolveComponent('UserMenu')!;
const trace = q.traceProp(menu.id, 'onSelect')!;
for (const origin of trace.origins) {
  console.log(origin.owner.name, origin.state.name, origin.chain.map(hop => hop.component.name));
  // → Shell selectedId [ 'Layout', 'Sidebar', 'UserMenu' ]
}

// What's affected if this state changes?
const state = q.findState('selectedId')[0]!;
console.log(q.impactOfState(state.id)!.summary);
// → 4 components affected (3 direct, 1 below)

// Everything worth fixing, with stable ids
for (const issue of graph.insights) {
  console.log(issue.severity, issue.code, `${issue.filePath}:${issue.line}`, issue.message);
}
```

## What you get

**`ReactParser`** turns a project into a `StateFlowGraph`:

| Field | Contents |
|---|---|
| `components` | Every component (function, arrow, `memo`, `forwardRef`, class, anonymous default export) with props (types, usage), state it declares, contexts it provides/consumes, Server/Client environment |
| `renders` | Parent → child render edges with the JSX call site and the props passed there (including Next.js layout → page) |
| `stateNodes` | `useState`, `useReducer`, context, Redux, Zustand, Jotai, Recoil, Valtio, XState, TanStack Query, SWR, Apollo, React Hook Form, router hooks, custom hooks — with library and store/atom/query key |
| `edges` | How each state value travels through props (with renames, spreads and setter tracking) and through context |
| `propDrillingPaths` | Chains where a value passes through components that only forward it |
| `contextBoundaries`, `contextLeaks`, `bundles`, `componentMetrics`, `propChains` | Context providers & consumers, context values re-passed as props, oversized object props, per-component prop usage roles, rename chains |
| `insights` | Diagnostics with severity, location, related locations and a stable fingerprint id — see below |
| `meta` | Files analyzed, duration, detected frameworks (`next-app-router`, `react-19`, …) |

Ids are stable and readable — `c:src/components/Shell.tsx#Shell`, `s:src/components/Shell.tsx#Shell.selectedId`, `ctx:src/context/auth.tsx#AuthContext` — so they survive edits and work as fingerprints in CI.

### Insights

| Code | Severity |
|---|---|
| `SERVER_COMPONENT_HOOK` — client-only hook in a component rendered as a Server Component | error |
| `SERVER_TO_CLIENT_FUNCTION_PROP` — function passed from a Server to a Client Component | error |
| `PROP_DRILLING` — value passed through components that only forward it | warning |
| `CONTEXT_LEAK` — context read and re-passed as props | info |
| `PROP_BUNDLE` — large object passed as a single prop | info |
| `UNUSED_PROP` — prop destructured but never used | hint |
| `PROP_PASSTHROUGH` — one forwarding step of a drilling chain | hint |

## Incremental analysis

The parser caches per-file facts. After the first `parse()`, feed it changes and parse again — only changed files are re-read, and the graph is re-linked in milliseconds. This is what keeps the editor integration and the MCP server live.

```ts
parser.updateFiles([
  { filePath: '/abs/src/Header.tsx', content: editorBuffer }, // unsaved text
  { filePath: '/abs/src/NewThing.tsx' },                       // created/changed on disk
  { filePath: '/abs/src/Old.tsx', content: null },             // deleted
]);
const next = parser.parse().graph;
```

## Query API

`new GraphQuery(graph)` works on both the in-memory graph and its JSON form (`serializeGraph` / `deserializeGraph`). It only imports types, so you can load it on its own: `import { GraphQuery } from '@react-state-map/core/query'`.

| Method | |
|---|---|
| `resolveComponent(nameOrId)` / `findComponents(query)` / `componentAt(file, line)` | Lookup |
| `parents(id)` / `children(id)` / `descendants(id)` / `findRenderPath(from, to)` | Render tree |
| `traceProp(componentId, prop)` | Origin chains back to the owning state + every call site and the value passed there |
| `impactOfState(id)` / `impactOfComponent(id)` / `impactOfContext(id)` | Affected components, grouped by reason |
| `contextConsumers(id)` / `contextProviders(id)` / `sharedSubscribers(state)` | Who reads the same context / store / atom / query |
| `summarizeComponent(id)` / `drillingFor(id)` / `insightsInFile(file)` | Per-component and per-file views |

## Automatic fixes

Fix planners compute the edit in memory and return full before/after text per file — nothing is written, so you decide how to apply it.

```ts
import { planLiftToContext, planRemoveUnusedProp } from '@react-state-map/core';

const issue = graph.insights.find(i => i.code === 'PROP_DRILLING')!;
const plan = planLiftToContext(parser.getProject(), graph, issue.drillingPathId!, { react19: true });

if (plan.applicable) {
  for (const edit of plan.edits) {
    // edit.filePath, edit.oldText, edit.newText, edit.isNew
  }
} else {
  console.log(plan.reasons); // e.g. "Avatar is also rendered by Other; …"
}
```

`planLiftToContext` creates a typed context + hook next to the owner, provides it (memoized, `<Ctx value>` on React 19), removes the forwarded prop from every intermediate component's signature, types and JSX, and reads it with the hook in the consumer. It refuses — with reasons — whenever the change wouldn't be safe.

## Text for humans and LLMs

`@react-state-map/core/format` holds the compact, `path:line`-annotated text formatters used by the MCP server and the Copilot tools (`formatOverview`, `formatComponent`, `formatTraceProp`, `formatImpact`, `formatIssues`, `formatFixPlan`, …), plus `createUnifiedDiff` and `diffLineEdits` for turning fix plans into patches or editor edits.

## Options

```ts
new ReactParser({
  rootDir: './my-app',
  include: ['src/**/*.{ts,tsx}'],   // default: all .ts/.tsx/.js/.jsx/.mts/.mjs
  exclude: ['**/legacy/**'],         // default: node_modules, build output, tests, stories, .d.ts
  drillingThreshold: 3,              // hops before passing a value down counts as drilling
});
```

Module resolution follows the nearest `tsconfig.json` / `jsconfig.json` of each file (`paths`, `baseUrl`, `extends`, solution-style `references`), so monorepos with per-app configs just work.

## License

MIT · [GitHub](https://github.com/olafglad/react-state-map) · [Issues](https://github.com/olafglad/react-state-map/issues)
