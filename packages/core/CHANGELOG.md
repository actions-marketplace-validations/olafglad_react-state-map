# Changelog

All notable changes to @react-state-map/core will be documented in this file.

## [0.3.1] - 2026-10-08

### Fixed
- A component passed as a prop and rendered as JSX (`<Glyph size={14} />`) is no longer reported as an unused prop.

## [0.3.0] - 2026-10-08

A rewrite of the analyzer around per-file facts and an import-aware linker, plus a query API, diagnostics and code-fix planners.

### Added
- **Import-aware linking**: JSX tags, hooks, contexts and types are resolved like TypeScript does — `paths`/`baseUrl`/`extends` from the nearest tsconfig/jsconfig, solution-style `references` (Vite), barrels (`export *`, `export { default as X }`), aliased, default and namespace imports. Same-named components in different files are told apart.
- **Incremental parsing**: `ReactParser.updateFiles([{ filePath, content? }])` + `parse()` re-extracts only changed files and re-links the graph.
- **Render graph** (`graph.renders`) with JSX call sites and props, including implicit Next.js layout → page edges.
- **Insights** (`graph.insights`): `PROP_DRILLING`, `PROP_PASSTHROUGH`, `CONTEXT_LEAK`, `PROP_BUNDLE`, `UNUSED_PROP`, `SERVER_COMPONENT_HOOK`, `SERVER_TO_CLIENT_FUNCTION_PROP` — with locations, related locations and stable fingerprint ids.
- **`GraphQuery`** (also as `@react-state-map/core/query`): component lookup, render paths, `traceProp`, `impactOfState` / `impactOfComponent` / `impactOfContext`, shared-store subscribers, summaries.
- **Fix planners**: `planLiftToContext` (lift drilled state into a typed context + hook across every file, with safety checks) and `planRemoveUnusedProp`.
- **Formatters** (`@react-state-map/core/format`): LLM-friendly text for overview, components, prop traces, impact, issues and fix plans; `createUnifiedDiff` and `diffLineEdits`.
- New component shapes: `memo`, `forwardRef`, class components, anonymous default exports; props from imported interfaces/type aliases, `props.x` access, `{...rest}` forwarding; setter tracking (`[x, setX]` drilled together).
- New state sources: React 19 `use()`, `useActionState`, `useOptimistic`, `useSyncExternalStore`, `useFormStatus`; TanStack Query, SWR, Apollo, urql, Jotai, Recoil, Valtio, XState, React Hook Form, RTK Query, typed Redux hooks, router hooks. Custom hooks that wrap contexts are linked to their providers; React 19 `<Ctx value>` providers.
- Next.js App Router environment detection (`component.environment`: `server` / `client`).
- Stable, readable ids (`c:src/App.tsx#App`, `s:src/App.tsx#App.count`, `ctx:src/App.tsx#ThemeContext`) and `graph.meta` (frameworks, timing).

### Changed
- Default include now covers `.ts`/`.js`/`.mts`/`.mjs`; default exclude skips build output, `.next`, coverage, stories and `.d.ts`.
- Prop drilling follows each value thread separately (no more mixed-prop paths) and reports value + setter on the same route as one issue.
- `parseFile` is removed (the parser now works on cached per-file facts).

## [0.2.0] - 2026-03-17

### Fixed
- **File Exclusion Patterns**: Improved ts-morph negation glob handling for more reliable file filtering

## [0.1.6] - 2025-01-14

### Added
- **Pass-Through Ratio Analysis**: New component role classification
  - Components classified as: consumer, passthrough, transformer, or mixed
  - Tracks how props are used: consumed, passed through, transformed, or ignored
  - `ComponentPropMetrics` type with detailed prop usage statistics
  - Analyzer methods: `getComponentMetrics()`, `getPassthroughComponents()`, `getComponentsByRole()`

- **Bundle Detection**: Detect large object props being passed through components
  - Identifies inline object literals with 3+ properties
  - Tracks bundles through component chains
  - Warns about bundles with 5+ properties
  - `PropBundle` type and analyzer methods: `getBundles()`, `getLargeBundles()`, `getBundleWarnings()`

- **Context Leak Detection**: Detect anti-pattern of extracting context and re-passing as props
  - Finds components that use `useContext` then pass values as props to children
  - Handles destructured context values and non-null assertions
  - Provides fix suggestions
  - `ContextLeak` type and analyzer methods: `getContextLeaks()`, `getContextLeakSummary()`

- **Rename Tracking**: Track props through rename chains
  - Detects destructuring renames: `const { id: dealId } = props`
  - Detects assignment renames: `const newName = oldProp`
  - Builds scope maps to trace variable origins
  - `PropChain` and `PropRename` types with analyzer methods

### Fixed
- `getHookStateName` now handles non-null assertions (`!`) and object destructuring
- Enhanced context usage extraction to navigate through wrapper nodes

## [0.1.5] - 2025-01-13

### Changed
- Version bump to stay in sync with CLI and VS Code extension releases
- No functional changes to core parsing logic

## [0.1.4] - 2025-01-13

### Changed
- Version bump to stay in sync with CLI and VS Code extension releases
- No functional changes to core parsing logic

## [0.1.3] - 2025-01-07

### Changed
- Updated README with correct API usage examples
- Fixed VS Code extension marketplace link

## [0.1.2] - 2025-01-06

### Fixed
- **Context Detection**: Expanded provider detection patterns
  - Added `KNOWN_PROVIDER_NAMES` set for common providers (ThemeProvider, Provider, AuthProvider, QueryClientProvider, etc.)
  - Now detects any component ending in `Provider`
  - Checks multiple provider props (`value`, `store`, `client`, `theme`, `config`)
- **Prop Drilling Detection**: Fixed false negatives
  - Added iterative refinement pass to correctly update hop counts through component chains
  - Fixed `countUnusedHops` to identify true pass-through components (receive AND pass state)
  - Props are now correctly traced through intermediate components
- **State Tracking**: Improved `findStateByName` to check `stateUsed` for props received from parent components

## [0.1.1] - 2025-01-05

### Fixed
- Minor bug fixes

## [0.1.0] - 2025-01-05

### Added
- Initial release
- React component parsing with ts-morph
- State detection: useState, useReducer, useContext, Redux, Zustand, custom hooks
- Context boundary detection
- Prop drilling detection with configurable threshold
- Graph serialization for visualization
