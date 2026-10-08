import type {
  SerializedStateFlowGraph,
  GraphSummary,
  ParseWarning,
  ParseError,
  FixPlan,
} from '@react-state-map/core';

export interface AnalyzerOptions {
  include?: string[];
  exclude?: string[];
  drillingThreshold: number;
}

export interface AnalysisSnapshot {
  graph: SerializedStateFlowGraph;
  summary: GraphSummary;
  warnings: ParseWarning[];
  errors: ParseError[];
  reactMajor: number | null;
}

export interface FileChange {
  filePath: string;
  /** New contents; omitted = re-read from disk; null = deleted */
  content?: string | null;
}

export type WorkerRequest =
  | { id: number; type: 'init'; rootDir: string; options: AnalyzerOptions }
  | { id: number; type: 'update'; changes: FileChange[] }
  | { id: number; type: 'planLift'; drillingPathId: string; react19?: boolean }
  | { id: number; type: 'planRemoveProp'; insightId: string };

export type WorkerResponse =
  | { id: number; ok: true; snapshot?: AnalysisSnapshot; plan?: FixPlan }
  | { id: number; ok: false; error: string };

/** A request before the service assigns its id */
export type WorkerRequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;
