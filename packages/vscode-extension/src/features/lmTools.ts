import * as vscode from 'vscode';
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
} from '@react-state-map/core/format';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import type { AnalysisService } from '../analysis/AnalysisService';

type Args = Record<string, any>;
type Handler = (service: AnalysisService, args: Args) => string | Promise<string>;

/**
 * Tools for Copilot agent mode (and any chat participant): the same answers the MCP server
 * gives, computed from the live in-editor analysis.
 */
export function registerLanguageModelTools(manager: AnalysisManager): vscode.Disposable[] {
  const lm = (vscode as any).lm as typeof vscode.lm | undefined;
  if (!lm?.registerTool) return [];

  const tools: Record<string, Handler> = {
    reactStateMap_overview: s => formatOverview(s.query!, s.snapshot!.graph),
    reactStateMap_findComponents: (s, a) => formatFindComponents(s.query!, s.snapshot!.graph, { query: String(a.query ?? ''), limit: a.limit }),
    reactStateMap_component: (s, a) => formatComponent(s.query!, s.snapshot!.graph, { component: String(a.component ?? '') }),
    reactStateMap_traceProp: (s, a) => formatTraceProp(s.query!, s.snapshot!.graph, { component: String(a.component ?? ''), prop: String(a.prop ?? '') }),
    reactStateMap_impact: (s, a) => formatImpact(s.query!, s.snapshot!.graph, { component: a.component, state: a.state, context: a.context }),
    reactStateMap_renderPath: (s, a) => formatRenderPath(s.query!, s.snapshot!.graph, { from: String(a.from ?? ''), to: String(a.to ?? '') }),
    reactStateMap_issues: (s, a) => formatIssues(s.query!, s.snapshot!.graph, { code: a.code, severity: a.severity, file: a.file, limit: a.limit }),
    reactStateMap_planFix: async (s, a) => {
      const ref = String(a.drilling_path_id ?? a.insight_id ?? '');
      const target = resolveFixTarget(s.query!, s.snapshot!.graph, ref);
      if (typeof target === 'string') return target;
      const plan = target.kind === 'remove-unused-prop'
        ? await s.planRemoveProp(target.insight.id)
        : await s.planLift(target.drillingPathId!);
      return formatFixPlan(s.query!, s.snapshot!.graph, {
        plan,
        target,
        applyHint: 'Apply these diffs by editing the files, or ask the user to run the "Lift into a React context" quick fix.',
      });
    },
  };

  return Object.entries(tools).map(([name, handler]) =>
    lm.registerTool<Args>(name, {
      async invoke(options) {
        const service = manager.active();
        if (!service) return text('No React project is open in this workspace.');
        await service.flush();
        if (!service.query || !service.snapshot) return text('React State Map is still analyzing the workspace; try again in a moment.');
        return text(await handler(service, options.input ?? {}));
      },
    })
  );
}

function text(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}
