/**
 * Core data types for React State Map
 */

export type StateType =
  | 'useState'
  | 'useReducer'
  | 'useContext'
  | 'zustand'
  | 'redux'
  | 'customHook'
  | 'props'
  | 'serverState'     // TanStack Query, SWR, Apollo, RTK Query, React 19 use(promise)
  | 'atom'            // Jotai, Recoil
  | 'machine'         // XState
  | 'form'            // React Hook Form, useFormStatus
  | 'router'          // React Router, Next.js navigation, TanStack Router
  | 'useActionState'
  | 'useOptimistic'
  | 'externalStore';  // useSyncExternalStore, Valtio

export interface StateNode {
  id: string;
  type: StateType;
  name: string;
  filePath: string;
  line: number;
  column: number;
  initialValue?: string;
  storeName?: string; // For zustand/redux/atoms/queries - which store/atom/key it comes from
  hookName?: string;  // For custom hooks - which hook provides this state
  library?: string;   // e.g. 'react', 'tanstack-query', 'jotai'
  ownerId?: string;   // Component that declares this state
  bindings?: string[];  // Local identifiers introduced (e.g. ['count', 'setCount'])
  setterName?: string;  // For useState/useReducer-like tuples
  contextId?: string;   // For useContext/use(Context) and custom hooks that wrap contexts
}

export interface ContextInfo {
  contextId: string;
  contextName: string;
  providerValue?: string;
}

export type ComponentKind = 'function' | 'arrow' | 'class' | 'memo' | 'forwardRef';

export interface ComponentNode {
  id: string;
  name: string;
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  kind?: ComponentKind;
  stateUsed: StateNode[];
  stateProvided: StateNode[];
  contextProviders: ContextInfo[];
  contextConsumers: string[];       // Context display names
  contextConsumerIds?: string[];    // Resolved context ids (see ContextBoundary.contextId)
  props: PropDefinition[];
  isExported: boolean;
  directive?: 'use client' | 'use server';
  environment?: 'client' | 'server';  // Only set when it can be determined (directive or Next.js App Router)
}

export interface PropDefinition {
  name: string;
  type?: string;
  isUsed: boolean;
  passedTo: string[];
  localName?: string;   // Local binding name when renamed: ({ user: currentUser })
  line?: number;        // Location of the prop binding / declaration, when known
  column?: number;
  optional?: boolean;
}

export interface SourceLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface StateFlowEdge {
  id: string;
  from: string;
  to: string;
  stateId: string;
  mechanism: 'props' | 'context' | 'hook';
  propName?: string;
  hops: number;
  location?: SourceLocation;   // Where the value is passed (the JSX attribute)
  viaSpread?: boolean;         // Forwarded through {...props} / {...rest}
  isSetter?: boolean;          // The value passed is the state's setter
  fromProp?: string;           // For forwarded values: the prop name the sender received it as
}

/** Parent renders child in its JSX */
export interface RenderEdge {
  from: string;
  to: string;
  filePath: string;
  line: number;
  column: number;
  count?: number;                                  // Number of JSX sites in the parent rendering the child
  props?: Array<{ name: string; value: string }>;  // Props passed at the first site
  implicit?: boolean;                              // Framework wiring (e.g. Next.js layout → page), not JSX
}

export interface ContextBoundary {
  contextId: string;
  contextName: string;
  providerComponent: string;
  providerFile: string;
  providerLine: number;
  childComponents: string[];
}

export interface PropDrillingStep {
  from: string;          // component id passing the value
  to: string;            // component id receiving it
  propName: string;
  location?: SourceLocation;
  viaSpread?: boolean;
}

export interface PropDrillingPath {
  id?: string;
  stateId: string;
  stateName: string;
  origin: string;
  path: string[];               // Component names, origin first
  hops: number;
  propNames: string[];
  componentIds?: string[];      // Component ids, origin first
  steps?: PropDrillingStep[];
  passThroughIds?: string[];    // Intermediate components that only forward the value
  consumerId?: string;          // Last component in the path
}

export interface StateFlowGraph {
  components: Map<string, ComponentNode>;
  stateNodes: Map<string, StateNode>;
  edges: StateFlowEdge[];
  contextBoundaries: ContextBoundary[];
  propDrillingPaths: PropDrillingPath[];
  componentMetrics: ComponentPropMetrics[];
  bundles: PropBundle[];
  contextLeaks: ContextLeak[];
  propChains: PropChain[];
  renders: RenderEdge[];
  insights: Insight[];
  meta?: GraphMeta;
}

export interface SerializedStateFlowGraph {
  components: Record<string, ComponentNode>;
  stateNodes: Record<string, StateNode>;
  edges: StateFlowEdge[];
  contextBoundaries: ContextBoundary[];
  propDrillingPaths: PropDrillingPath[];
  componentMetrics: ComponentPropMetrics[];
  bundles: PropBundle[];
  contextLeaks: ContextLeak[];
  propChains: PropChain[];
  renders?: RenderEdge[];
  insights?: Insight[];
  meta?: GraphMeta;
}

export interface GraphMeta {
  rootDir: string;
  filesAnalyzed: number;
  durationMs: number;
  frameworks: string[];         // e.g. ['next-app-router', 'react-19']
  drillingThreshold: number;
}

// ============================================
// Insights (diagnostics surfaced in editors, CI and agents)
// ============================================

export type InsightSeverity = 'error' | 'warning' | 'info' | 'hint';

export type InsightCode =
  | 'PROP_DRILLING'
  | 'PROP_PASSTHROUGH'
  | 'CONTEXT_LEAK'
  | 'PROP_BUNDLE'
  | 'UNUSED_PROP'
  | 'SERVER_COMPONENT_HOOK'
  | 'SERVER_TO_CLIENT_FUNCTION_PROP';

export interface Insight {
  id: string;                   // Stable across runs (no line numbers) — usable as a fingerprint
  code: InsightCode;
  severity: InsightSeverity;
  message: string;
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  componentId?: string;
  stateId?: string;
  drillingPathId?: string;
  propName?: string;
  related?: Array<SourceLocation & { message: string }>;
  fixable?: boolean;            // A code fix is available (see planLiftToContext / unused prop removal)
}

export interface ParseOptions {
  entryPoint?: string;
  rootDir: string;
  include?: string[];
  exclude?: string[];
  drillingThreshold?: number;
}

export interface ParseResult {
  graph: StateFlowGraph;
  errors: ParseError[];
  warnings: ParseWarning[];
}

export interface ParseError {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
}

export interface ParseWarning {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  code: string;
}

// ============================================
// Pass-Through Ratio Analysis Types
// ============================================

export interface PropUsage {
  propName: string;
  usedInRender: boolean;      // Used in JSX expression (not as prop to child)
  passedToChild: boolean;     // Forwarded to child component as prop
  usedInCallback: boolean;    // Used in useCallback/useMemo
  usedInEffect: boolean;      // Used in useEffect/useLayoutEffect
  usedInLogic: boolean;       // Used in conditionals, computations
  transformed: boolean;       // Assigned to new variable before use
}

export type ComponentRole = 'consumer' | 'passthrough' | 'transformer' | 'mixed';

export interface ComponentPropMetrics {
  componentId: string;
  componentName: string;
  filePath: string;

  // Prop counts
  totalPropsReceived: number;
  propsConsumed: number;        // Used in render logic or callbacks
  propsPassed: number;          // Forwarded to children
  propsTransformed: number;     // Modified before passing
  propsIgnored: number;         // Neither used nor passed

  // Ratios (0-1)
  passthroughRatio: number;     // propsPassed / totalPropsReceived
  consumptionRatio: number;     // propsConsumed / totalPropsReceived

  // Classification
  role: ComponentRole;

  // Details
  propUsages: PropUsage[];
}

// ============================================
// Bundle Detection Types
// ============================================

export interface PropBundle {
  id: string;
  propName: string;                 // The prop name used (e.g., 'formData', 'carInfoValue')
  sourceComponentId: string;        // Component that creates/originates the bundle
  sourceComponentName: string;
  estimatedSize: number;            // Number of properties in the bundle
  properties: string[];             // Known property names in the bundle
  passedThrough: string[];          // Component IDs that forward this bundle
  isObjectLiteral: boolean;         // True if created as inline object literal
  filePath: string;
  line: number;
}

export interface BundleFlow {
  bundleId: string;
  fromComponentId: string;
  toComponentId: string;
  propName: string;                 // May be renamed at each level
  consumedProperties: string[];     // Properties actually used at destination
  forwardedProperties: string[];    // Properties passed further down
}

export type BundleSeverity = 'low' | 'medium' | 'high';

export interface BundleWarning {
  bundle: PropBundle;
  severity: BundleSeverity;
  passedThroughCount: number;       // How many components just forward it
  utilizationRatio: number;         // % of bundle properties actually used
  recommendation: string;
}

// ============================================
// Context Leak Detection Types
// ============================================

export type ContextLeakSeverity = 'low' | 'medium' | 'high';

export interface ContextLeak {
  id: string;
  contextName: string;              // The context being leaked
  leakingComponentId: string;       // Component that extracts and re-passes
  leakingComponentName: string;
  extractedValues: string[];        // What was pulled from context
  passedTo: Array<{
    componentId: string;
    componentName: string;
    propNames: string[];            // Which props carry context values
  }>;
  severity: ContextLeakSeverity;
  potentialFix: string;             // Suggestion for how to fix
  filePath: string;
  line: number;
}

export interface EnhancedContextUsage {
  contextName: string;
  variableName: string;             // Variable assigned to (may be destructured)
  destructuredFields: string[];     // Fields extracted: const { user, settings } = useContext(...)
  usedInJsx: boolean;               // Is it rendered directly
  passedAsProps: string[];          // Which children receive context values
  line: number;
}

// ============================================
// Rename Tracking Types
// ============================================

export type RenameType = 'destructure' | 'alias' | 'accessor' | 'assignment' | 'spread';

export interface PropRename {
  fromName: string;                 // Original prop/variable name
  toName: string;                   // New name after rename
  componentId: string;
  componentName: string;
  renameType: RenameType;
  line: number;
  filePath: string;
}

export interface PropChain {
  id: string;
  originalStateId?: string;         // If traceable to a state node
  originalName: string;             // Starting prop name
  renames: PropRename[];            // Chain of renames through components
  finalName: string;                // Name at the end of chain
  depth: number;                    // How many components deep
}

export interface ScopeEntry {
  type: 'propAlias' | 'destructure' | 'contextValue' | 'computed';
  originalName: string;
  sourceProp?: string;              // For destructure: which prop it came from
  line: number;
}
