# Changelog

All notable changes to React State Map will be documented in this file.

## [0.3.2] - 2026-10-08

### Changed
- Releases are now built and published automatically from GitHub Actions (Open VSX via trusted publishing); the `.vsix` is attached to each GitHub release.

## [0.3.1] - 2026-10-08

### Fixed
- A component passed as a prop and rendered as JSX (`<Glyph size={14} />`) is no longer reported as an unused prop.

## [0.3.0] - 2026-10-08

React State Map moves from "a graph you open sometimes" to answers right where you work.

### Added
- **Prop origins on hover**: hover a prop to see the state that owns it and every component it passes through — across renames, `{...props}` spreads, barrel files and path aliases — with clickable hops and call-site values. Hover a piece of state to see who depends on it.
- **CodeLens** above components (rendered by, renders, shares state with, drills / only forwards) and above state declarations (how many other components use it).
- **Diagnostics in the Problems panel**: prop drilling (on the exact JSX attribute, with the whole chain as related locations), forwarding-only steps, context leaks, large prop bundles, unused props (faded out), and Next.js errors — hooks in Server Components and functions passed from Server to Client Components.
- **Quick fix: Lift drilled state into a context.** Creates a typed context + hook, provides it at the source (memoized; React 19 `<Ctx value>` when detected), removes the prop from every intermediate component's signature, types and JSX, and reads it with the hook in the consumer — one undoable multi-file edit, offered only when it's safe. Optional Refactor Preview (`reactStateMap.fixes.preview`).
- **Quick fix: Remove unused prop.**
- **Impact analysis** (`Show Impact`, `⌘⌥I` / `Ctrl+Alt+I`) for state, components and contexts, in a new Impact view that stays in sync as you edit and can be highlighted in the graph.
- **Component Inspector** sidebar that follows the cursor: props with their origins, state, contexts, parents, children and issues.
- **Copilot agent-mode tools** (`#stateMapTraceProp`, `#stateMapImpact`, `#stateMapPlanFix`, …) backed by the live analysis.
- **Live analysis of unsaved changes**, in a background worker thread so the editor never blocks; incremental re-analysis per file.
- Commands: Show in State Map (`⌘⌥M` / `Ctrl+Alt+M`), Go to Component…, Show Parents & Children, Re-analyze Workspace; status bar item with component and issue counts; activity bar container; multi-root workspace support.
- Graph: updates in place without losing zoom/selection, focus-on-component and impact highlighting, client/server badges, per-component insights, "Rendered by"/"Renders" with call sites, colors for all new state types.

### Analysis engine
- Components are resolved through imports like TypeScript does: tsconfig/jsconfig `paths`, `extends`, Vite-style project references, barrels (`export *`, `export { default as X }`), aliased, default and namespace imports. Two components with the same name no longer collide.
- New component shapes: `memo`, `forwardRef`, class components, anonymous default exports; props from imported interfaces/type aliases (with `extends`), `props.x` access and `{...rest}` forwarding.
- React 19 (`use()`, `<Ctx value>`, `useActionState`, `useOptimistic`, `useFormStatus`), Next.js App Router Server/Client Components, TanStack Query, SWR, Apollo, Jotai, Recoil, Valtio, XState, React Hook Form, RTK Query and typed Redux hooks, router hooks. Custom hooks that wrap `useContext` are linked to their providers.
- `.ts`/`.js` files are analyzed by default so hooks, contexts and stores outside components are understood; build output, tests and stories are excluded.

### Changed
- Requires VS Code 1.95 or newer.
- `reactStateMap.autoRefresh` is replaced by `reactStateMap.analyzeOnType`.

## [0.2.0] - 2026-03-17

### Added
- **ELK.js Layout Engine**: Replaced Dagre with ELK.js for superior hierarchical graph layout
  - Better edge crossing minimization
  - Improved handling of large, complex graphs
- **Cytoscape.js Canvas Rendering**: Replaced SVG DOM rendering with Cytoscape.js
  - GPU-accelerated canvas rendering for smooth performance
  - Handles hundreds of components without lag
- **Semantic Zoom**: Directory overview at far zoom, component detail at close zoom
  - Three zoom levels: far (directory), medium (reduced detail), close (full detail)
  - Directory nodes show component count and stateful indicators
  - Inter-directory edge weights show connection density
- **Fuzzy Search**: Search components by name, file path, or props
  - Real-time results with keyboard navigation
  - Badges for stateful and provider components
- **Path Finding**: Find shortest path between any two components
  - BFS-based pathfinding across all edge types
  - Visual path highlighting with hop count
- **Focus Mode**: Isolate a component and its direct neighbors
- **Edge Layer Controls**: Floating Layers panel to toggle edge types
  - Toggle Props, Context, Hierarchy, and Drilling edges independently
  - View-specific layer visibility
- **Color-Coded Context Boundaries**: Each context gets a unique color
  - Up to 6 distinct colors for simultaneous context visualization
  - Legend updates dynamically with context names
- **Context View Enhancements**: Improved context boundary visualization
  - Hierarchy lines show parent-child relationships within contexts
  - Context edges use matching colors
- **State Persistence**: Panel state survives refresh and tab switches
  - Persists current view, edge visibility, panel collapsed state
  - Restores zoom level and pan position
- **Loading Indicator**: Full-screen spinner during layout computation

### Changed
- Complete rendering engine rewrite from SVG to canvas
- Layout algorithm upgraded from Dagre to ELK.js

## [0.1.6] - 2025-01-14

### Added
- **Pass-Through Ratio Visualization**: Component sidebar now shows prop usage metrics
  - Visual bar showing consumed/passed/transformed/ignored prop distribution
  - Role badge (consumer/passthrough/transformer/mixed) next to component name
  - Stats badge showing passthrough component count

- **Bundle Detection**: Detect large object props being passed through components
  - Stats badge showing problematic bundle count
  - Identifies inline object literals with 5+ properties

- **Context Leak Detection**: Detect anti-pattern of extracting context and re-passing as props
  - Finds components that use `useContext` then pass values as props to children
  - Stats badge showing leak count

- **Rename Tracking**: Track props through rename chains
  - Detects destructuring renames: `const { id: dealId } = props`
  - Detects assignment renames: `const newName = oldProp`
  - Stats badge showing complex rename count

### Changed
- Stats bar now shows 5 detection badges: drilling, passthrough, bundles, leaks, renames
- Updated to @react-state-map/core v0.1.6 with all new detection features

## [0.1.5] - 2025-01-13

### Added
- **Full Dagre Layout**: Switched from BFS depth-based layout to dagre's hierarchical algorithm
  - Automatic edge crossing minimization
  - Better handling of disconnected components
  - Compound graph support for clustering
- **Directory Clustering** (State Flow view): Components automatically grouped by directory
  - Recognizes common directories: components/, pages/, features/, modules/, views/
  - Visual cluster boundaries with dashed outlines
- **Context Boundary Clustering** (Context view): Consumers grouped inside provider boundaries
  - Context boundaries now influence layout, not just overlaid
  - Clearer visual hierarchy of context scope
- **Collapsible Subtrees**: Click to collapse/expand component subtrees
  - Collapse indicator (▶/▼) on nodes with children
  - Hidden child count badge (+N) when collapsed
  - Reduces visual complexity for large graphs
- **Hierarchy Lines in Context View**: Subtle props edges show parent-child relationships
  - Makes it clear why collapsing a parent hides its children
  - Lighter styling so context edges remain the focus

### Changed
- Layout algorithm now uses dagre for both node positioning and edge routing
- Context view shows both context edges (bold purple) and props edges (subtle gray)

## [0.1.4] - 2025-01-13

### Added
- **Improved Drilling View**: Completely redesigned prop drilling visualization
  - Shows only components involved in drilling paths as clean vertical chains
  - Color-coded nodes: Blue (defines state), Orange (pass-through), Green (uses state)
  - Displays state name and hop count above each drilling chain
  - Multiple drilling paths displayed side by side
- **Dynamic Legends**: Each view now has its own tailored legend
  - State Flow: Shows arrow types (Props, Context)
  - Context: Shows Context Provider indicator and Context Flow arrows
  - Drilling: Shows role colors (Defines State, Pass-through, Uses State)
- **Context Provider Highlighting**: Provider nodes now have purple border in Context view

### Changed
- CLI and VS Code extension now share identical rendering logic
- Synced hierarchical layout algorithm between CLI and VS Code

## [0.1.3] - 2025-01-07

### Fixed
- **Critical Bug Fix**: Fixed `dagreGraph` variable hoisting issue that caused State Flow view to crash
- **Layout Engine Rewrite**: Replaced dagre-only layout with custom hierarchical positioning
  - Nodes now arranged by depth (parents at top, children below)
  - Maximum 20 nodes per row to prevent extremely wide layouts
  - Extra vertical spacing between hierarchy levels
  - No more overlapping nodes
- **Error Handling**: Added try-catch around edge drawing to prevent crashes

### Changed
- Bundled dagre.js directly for edge routing (more reliable)
- Improved fit-to-view behavior for large graphs

## [0.1.2] - 2025-01-06

### Fixed
- **Large Project Support**: Fixed visualization failing on projects with many components
  - Added automatic fit-to-view that zooms out to show all nodes
  - Dynamic spacing that increases for larger graphs (1.2x for 20+ nodes, 1.5x for 50+ nodes)
  - Removed viewport clamping that caused nodes to be cut off at edges
  - Increased collision detection iterations for dense graphs
- **Context Detection**: Now detects more context provider patterns
  - Added support for `<ThemeProvider>`, `<Provider>`, `<AuthProvider>`, etc.
  - Detects any component ending in `Provider`
  - Recognizes common provider props (`value`, `store`, `client`, `theme`, `config`)
- **Prop Drilling Detection**: Fixed false negatives in prop drilling detection
  - Now correctly tracks props through component chains
  - Fixed hop count calculation for intermediate components
  - Properly identifies pass-through components vs components that use the state

### Added
- **Fit to View Button**: New button in header to reset zoom and center the graph

## [0.1.1] - 2025-01-05

### Fixed
- Minor bug fixes and improvements

## [0.1.0] - 2025-01-05

### Added
- Initial release
- **State Flow View**: Visualize how state flows between components
- **Context Boundaries View**: See React Context providers and consumers
- **Prop Drilling Detection**: Automatically detect props passed through multiple layers
- State detection for:
  - `useState` and `useReducer`
  - `useContext`
  - Redux (`useSelector`, `useDispatch`)
  - Zustand (`useStore`, `useXxxStore` patterns)
  - Custom hooks (`useXxx`)
- Interactive graph with pan and zoom
- Click-to-navigate: Click any component to jump to source code
- Auto-refresh on file save
- Configurable exclusion patterns
- Configurable prop drilling threshold
