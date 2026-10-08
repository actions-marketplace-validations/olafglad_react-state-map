import { parentPort } from 'node:worker_threads';
import {
  ReactParser,
  GraphAnalyzer,
  serializeGraph,
  planLiftToContext,
  planRemoveUnusedProp,
  type StateFlowGraph,
} from '@react-state-map/core';
import type { WorkerRequest, WorkerResponse, AnalysisSnapshot } from './protocol';

/**
 * Analysis runs off the extension host thread: parsing a large project with ts-morph
 * would otherwise freeze every other extension while it runs.
 */
let parser: ReactParser | undefined;
let graph: StateFlowGraph | undefined;

function snapshot(): AnalysisSnapshot {
  const result = parser!.parse();
  graph = result.graph;
  return {
    graph: serializeGraph(result.graph),
    summary: new GraphAnalyzer(result.graph).getSummary(),
    warnings: result.warnings,
    errors: result.errors,
    reactMajor: parser!.getReactMajor(),
  };
}

function handle(req: WorkerRequest): WorkerResponse {
  switch (req.type) {
    case 'init':
      parser = new ReactParser({
        rootDir: req.rootDir,
        include: req.options.include,
        exclude: req.options.exclude,
        drillingThreshold: req.options.drillingThreshold,
      });
      return { id: req.id, ok: true, snapshot: snapshot() };

    case 'update':
      if (!parser) return { id: req.id, ok: false, error: 'Analyzer not initialized' };
      parser.updateFiles(req.changes);
      return { id: req.id, ok: true, snapshot: snapshot() };

    case 'planLift':
      if (!parser || !graph) return { id: req.id, ok: false, error: 'Analyzer not initialized' };
      return {
        id: req.id,
        ok: true,
        plan: planLiftToContext(parser.getProject(), graph, req.drillingPathId, {
          react19: req.react19 ?? (parser.getReactMajor() ?? 0) >= 19,
        }),
      };

    case 'planRemoveProp': {
      if (!parser || !graph) return { id: req.id, ok: false, error: 'Analyzer not initialized' };
      const insight = graph.insights.find(i => i.id === req.insightId);
      if (!insight) return { id: req.id, ok: false, error: 'This issue no longer exists — the file changed.' };
      return { id: req.id, ok: true, plan: planRemoveUnusedProp(parser.getProject(), insight) };
    }
  }
}

parentPort?.on('message', (req: WorkerRequest) => {
  let response: WorkerResponse;
  try {
    response = handle(req);
  } catch (error) {
    response = { id: req.id, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
  parentPort!.postMessage(response);
});
