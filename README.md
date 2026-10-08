<div align="center">

<img src="https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/icon.png" width="88" alt="React State Map logo">

# React State Map

**Know where every prop comes from.**

React State Map follows state through your React app — across files, renames, spreads, barrels and path aliases — and shows you the answer right where you work: in your editor, in your AI agent, and in CI.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/OlafGlad.react-state-map-vscode?label=VS%20Code&color=0e639c)](https://marketplace.visualstudio.com/items?itemName=OlafGlad.react-state-map-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/OlafGlad.react-state-map-vscode?color=0e639c)](https://marketplace.visualstudio.com/items?itemName=OlafGlad.react-state-map-vscode)
[![npm cli](https://img.shields.io/npm/v/@react-state-map/cli?label=cli&color=cb3837)](https://www.npmjs.com/package/@react-state-map/cli)
[![npm core](https://img.shields.io/npm/v/@react-state-map/core?label=core&color=cb3837)](https://www.npmjs.com/package/@react-state-map/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**Install for VS Code**](https://marketplace.visualstudio.com/items?itemName=OlafGlad.react-state-map-vscode) · [Add to your AI agent](#give-your-ai-agent-x-ray-vision) · [Guard your PRs](#keep-new-problems-out-of-main) · [Use the engine](packages/core)

![React State Map in VS Code: hover a prop to see its origin, fix prop drilling with one quick fix](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/demo.gif)

</div>

## Why

In a React codebase the hardest question is often the simplest one: *where does this value actually come from — and what breaks if I change it?* The answer is spread over five files, three renames and a `{...rest}`. Your editor's "Go to Definition" stops at the prop. React State Map doesn't.

- 🔍 **Trace any prop to its source.** Hover a prop and see the state that owns it and every component it passed through — even through renames, `{...props}` spreads, barrel files and `@/` aliases.
- 🛠 **Fix prop drilling in one click.** One quick fix creates a typed context and hook, provides it at the source, removes the prop from every component in between and reads it where it's used — across all files at once, and only when it's provably safe.
- 💥 **See the blast radius before you change something.** Impact analysis for any state, component or context: who receives it, who subscribes to the same store, what re-renders.
- ⚡️ **Catch Next.js Server Component mistakes early.** Hooks in Server Components and functions passed to Client Components show up as errors while you type — not in the browser.
- 🤖 **Give your AI agent the same answers.** An MCP server and Copilot tools let Claude Code, Cursor and Copilot ask "who sets this prop?" and get an exact answer in one call instead of grepping.
- ✅ **Keep new problems out of main.** A GitHub Action annotates pull requests with only the issues *they* introduce.

Zero config. Pure static analysis — nothing runs in your app, nothing leaves your machine.

## In your editor

Install **[React State Map for VS Code](https://marketplace.visualstudio.com/items?itemName=OlafGlad.react-state-map-vscode)** (works in Cursor and other VS Code–based editors too). Open a React project; that's it.

| | |
|---|---|
| **Hover a prop → see where it comes from**<br>The owning state, every hop, every rename — each one clickable. | ![Hover trace](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/hover-trace.png) |
| **CodeLens on every component**<br>Who renders it, what shares its state, whether it drills — at a glance. | ![CodeLens](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/codelens.png) |
| **One quick fix for prop drilling**<br>Lift the value into a context across every file in the chain. | ![Quick fix](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/quick-fix.png) |
| **Impact analysis & Component Inspector**<br>A sidebar that follows your cursor, plus "what does this affect?" on demand. | ![Impact and inspector](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/impact-inspector.png) |
| **Next.js Server/Client checks**<br>Real errors, in the Problems panel, before you run anything. | ![Server components](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/server-components.png) |
| **The whole map when you need it**<br>An interactive graph with impact highlighting, search and path-finding. | ![Graph](https://raw.githubusercontent.com/olafglad/react-state-map/main/packages/vscode-extension/images/graph-impact.png) |

[Everything the extension does →](packages/vscode-extension)

## Give your AI agent X-ray vision

Coding agents are great at writing components and surprisingly bad at answering "where does this prop come from?" — they grep, guess, and burn context. React State Map gives them the answer directly.

**Claude Code**

```bash
claude mcp add react-state-map -- npx -y @react-state-map/cli mcp .
```

**Cursor / any MCP client**

```json
{ "mcpServers": { "react-state-map": { "command": "npx", "args": ["-y", "@react-state-map/cli", "mcp", "."] } } }
```

**GitHub Copilot in VS Code** — nothing to set up: the extension registers the same tools for agent mode.

Your agent can then call `trace_prop`, `get_impact`, `get_component`, `find_render_path`, `list_issues` and `plan_fix` (which returns the lift-to-context refactor as a diff). The analysis stays warm and updates incrementally as files change, so answers come back in milliseconds.

## Keep new problems out of main

```yaml
# .github/workflows/react-state-map.yml
name: React State Map
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: olafglad/react-state-map@v0.3.0
        with: { fail-on: error }
```

Pull requests get inline annotations and a job summary listing only the issues they introduce (and the ones they fix). Prefer another CI? `npx @react-state-map/cli check --base origin/main` works anywhere, with `text`, `json`, `markdown` and SARIF output.

## What it understands

| | |
|---|---|
| **React** | `useState`, `useReducer`, `useContext`, React 19 `use()`, `useActionState`, `useOptimistic`, `useSyncExternalStore`, `useFormStatus`, `<Ctx value>` providers, `memo`, `forwardRef`, class components |
| **State libraries** | Redux & Redux Toolkit (incl. RTK Query and typed hooks), Zustand, Jotai, Recoil, Valtio, XState, TanStack Query, SWR, Apollo, React Hook Form, React Router / Next.js / TanStack Router hooks |
| **Context** | `createContext`, `.Provider` and React 19 providers, custom hooks that wrap `useContext` (so `useAuth()` is linked to `AuthProvider`) |
| **Next.js** | App Router Server vs. Client Components (`"use client"`, `"use server"`, layout → page wiring) |
| **Your project's layout** | tsconfig/jsconfig `paths` & `baseUrl`, `extends`, Vite-style project references, barrel files (`export *`, `export { default as X }`), aliased and namespace imports, default exports under any name, monorepos |

## How it works

React State Map parses your code with the TypeScript compiler API (via [ts-morph](https://ts-morph.com)) — no build step, no runtime instrumentation. Each file is reduced to a small set of facts (components, hooks, JSX, imports, exports); a linker resolves imports exactly like TypeScript does and builds a graph of render edges, state flows and context boundaries. Because facts are cached per file, an edit re-analyzes one file and re-links the graph in milliseconds — which is what makes the live editor features and the warm MCP server possible.

## Packages

| Package | What it's for |
|---|---|
| [**React State Map for VS Code**](packages/vscode-extension) | Hover traces, CodeLens, quick fixes, diagnostics, impact analysis, Copilot tools and the interactive graph |
| [**@react-state-map/cli**](packages/cli) | MCP server for AI agents, `check` for CI, `fix` for refactors, and the standalone HTML graph |
| [**@react-state-map/core**](packages/core) | The analysis engine: parser, query API, impact analysis and code-fix planners for your own tools |

## Contributing

```bash
pnpm install
pnpm -r build
pnpm --filter @react-state-map/core test               # engine tests
pnpm --filter react-state-map-vscode test              # VS Code integration tests (downloads VS Code)
```

Issues and ideas are very welcome: [open an issue](https://github.com/olafglad/react-state-map/issues).

## License

[MIT](LICENSE)
