// Main entry point for @react-state-map/core

// Types
export type {
  StateNode,
  ComponentNode,
  PropDefinition,
  ContextInfo,
  StateFlowEdge,
  ContextBoundary,
  PropDrillingPath,
  StateFlowGraph,
  SerializedStateFlowGraph,
  ParseOptions,
  ParseResult,
  ParseError,
  ParseWarning,
  StateType,
  ComponentKind,
  SourceLocation,
  RenderEdge,
  PropDrillingStep,
  GraphMeta,
  Insight,
  InsightCode,
  InsightSeverity,
  ComponentPropMetrics,
  ComponentRole,
  PropUsage,
  PropBundle,
  ContextLeak,
  PropChain,
  PropRename,
} from './types.js';

// Parser
export { ReactParser, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from './parser/react-parser.js';
export type { FileChange } from './parser/react-parser.js';
export { matchesGlob } from './parser/glob.js';

// Graph utilities
export { serializeGraph, deserializeGraph, toJSON, fromJSON } from './graph/serializer.js';
export { GraphAnalyzer } from './graph/analyzer.js';
export type { ComponentStats, StateStats, FlowStats, GraphSummary } from './graph/analyzer.js';
export { GraphQuery } from './graph/query.js';
export type {
  ComponentRef,
  PropOrigin,
  PropOriginHop,
  PropTrace,
  CallSite,
  ImpactItem,
  ImpactGroup,
  ImpactReport,
  ComponentInsightSummary,
} from './graph/query.js';

// Code fixes
export { planLiftToContext } from './fix/lift-to-context.js';
export type { FixPlan, FileEdit, LiftToContextOptions } from './fix/lift-to-context.js';
export { planRemoveUnusedProp } from './fix/remove-unused-prop.js';

// LLM-friendly text formatters (MCP server, editor language-model tools) and diff helpers
export * from './format/llm.js';
