import * as vscode from 'vscode';
import type { Insight } from '@react-state-map/core';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import type { AnalysisService } from '../analysis/AnalysisService';
import { toPosition } from '../util';

export const DIAGNOSTIC_SOURCE = 'React State Map';
const DOCS = 'https://github.com/olafglad/react-state-map#what-it-detects';

const SEVERITY: Record<Insight['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

/** Publishes analysis insights to the Problems panel and as squiggles */
export class DiagnosticsFeature implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection('reactStateMap');
  private filesByService = new Map<AnalysisService, Set<string>>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: AnalysisManager) {
    this.disposables.push(
      manager.onDidChange(service => this.publish(service)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('reactStateMap.diagnostics')) manager.all().forEach(s => this.publish(s));
      })
    );
  }

  private publish(service: AnalysisService): void {
    const config = vscode.workspace.getConfiguration('reactStateMap.diagnostics', service.folder.uri);
    const enabled = config.get<boolean>('enabled', true);
    const disabledCodes = new Set(config.get<string[]>('disabledCodes', []));
    const insights = enabled ? (service.query?.insights ?? []).filter(i => !disabledCodes.has(i.code)) : [];

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const insight of insights) {
      const list = byFile.get(insight.filePath) ?? [];
      list.push(toDiagnostic(insight));
      byFile.set(insight.filePath, list);
    }

    // Clear files that no longer have issues
    const previous = this.filesByService.get(service) ?? new Set<string>();
    for (const file of previous) {
      if (!byFile.has(file)) this.collection.delete(vscode.Uri.file(file));
    }
    for (const [file, diagnostics] of byFile) this.collection.set(vscode.Uri.file(file), diagnostics);
    this.filesByService.set(service, new Set(byFile.keys()));
  }

  dispose(): void {
    this.collection.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

export function toDiagnostic(insight: Insight): vscode.Diagnostic {
  const start = toPosition(insight.line, insight.column);
  const end = insight.endLine !== undefined
    ? toPosition(insight.endLine, insight.endColumn ?? insight.column + 1)
    : start.translate(0, Math.max(1, insight.propName?.length ?? 1));
  const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), insight.message, SEVERITY[insight.severity]);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = { value: insight.code, target: vscode.Uri.parse(`${DOCS}`) };
  if (insight.code === 'UNUSED_PROP') diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
  if (insight.related?.length) {
    diagnostic.relatedInformation = insight.related.map(r =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(r.filePath), toPosition(r.line, r.column)),
        r.message
      )
    );
  }
  return diagnostic;
}

/** Find the insight behind a diagnostic VS Code hands back to a code action provider */
export function insightForDiagnostic(service: AnalysisService | undefined, uri: vscode.Uri, diagnostic: vscode.Diagnostic): Insight | undefined {
  if (diagnostic.source !== DIAGNOSTIC_SOURCE || !service?.query) return undefined;
  const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
  return service.query.insightsInFile(uri.fsPath).find(i =>
    i.code === code &&
    i.line - 1 === diagnostic.range.start.line &&
    i.column === diagnostic.range.start.character
  );
}
