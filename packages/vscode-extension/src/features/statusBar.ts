import * as vscode from 'vscode';
import type { AnalysisManager } from '../analysis/AnalysisManager';

export class StatusBarFeature implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('reactStateMap.status', vscode.StatusBarAlignment.Left, 50);
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: AnalysisManager) {
    this.item.name = 'React State Map';
    this.item.command = 'reactStateMap.openPanel';
    this.disposables.push(
      this.item,
      manager.onDidChange(() => this.update()),
      manager.onDidChangeBusy(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update())
    );
    this.update();
  }

  private update(): void {
    const service = this.manager.active();
    const q = service?.query;
    if (!service) {
      this.item.hide();
      return;
    }
    if (!q) {
      this.item.text = '$(sync~spin) State Map';
      this.item.tooltip = 'React State Map: analyzing…';
      this.item.show();
      return;
    }
    const counts = { error: 0, warning: 0 };
    for (const i of q.insights) {
      if (i.severity === 'error') counts.error++;
      else if (i.severity === 'warning') counts.warning++;
    }
    const busy = this.manager.busy ? '$(sync~spin)' : '$(type-hierarchy)';
    const issues = counts.error + counts.warning;
    this.item.text = `${busy} ${q.components.size}${issues ? ` $(warning) ${issues}` : ''}`;
    const meta = service.snapshot?.graph.meta;
    this.item.tooltip = new vscode.MarkdownString(
      `**React State Map** — ${service.folder.name}\n\n` +
        `${q.components.size} components · ${q.stateNodes.size} state · ${q.boundaries.length} contexts\n\n` +
        `${counts.error} errors · ${counts.warning} warnings · ${q.drilling.length} drilling chains\n\n` +
        (meta ? `Analyzed ${meta.filesAnalyzed} files${meta.frameworks.length ? ` · ${meta.frameworks.join(', ')}` : ''}\n\n` : '') +
        'Click to open the graph'
    );
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
