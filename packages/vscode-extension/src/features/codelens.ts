import * as vscode from 'vscode';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import { toPosition, plural } from '../util';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescriptreact', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
  { language: 'typescript', scheme: 'file' },
  { language: 'javascript', scheme: 'file' },
];

/**
 * Lenses above components ("rendered by 3 · 2 state → 5 components · ⚠ drills count")
 * and above state declarations ("count → 3 components").
 */
export class CodeLensFeature implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: AnalysisManager) {
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(SELECTOR, this),
      manager.onDidChange(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('reactStateMap.codeLens')) this._onDidChange.fire();
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('reactStateMap').get<boolean>('codeLens.enabled', true)) return [];
    // Line numbers are stale while the user types; wait for the next analysis
    const service = this.manager.serviceFor(document.uri);
    const q = service?.query;
    if (!q) return [];
    const lenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;

    for (const c of q.componentsInFile(filePath)) {
      if (c.line - 1 >= document.lineCount) continue;
      const range = new vscode.Range(toPosition(c.line), toPosition(c.line));
      const parents = q.parents(c.id);
      const children = q.children(c.id);

      // Relations
      const parentText = parents.length === 0
        ? (c.isExported ? 'entry / not rendered here' : 'not rendered')
        : parents.length === 1
          ? `rendered by ${q.components.get(parents[0]!.from)?.name}`
          : `rendered by ${plural(parents.length, 'component')}`;
      const childText = children.length ? ` · renders ${children.length}` : '';
      lenses.push(new vscode.CodeLens(range, {
        title: `$(type-hierarchy) ${parentText}${childText}`,
        tooltip: 'Navigate to parents and children',
        command: 'reactStateMap.peekRelations',
        arguments: [{ componentId: c.id, filePath }],
      }));

      // State & context it shares
      const flows = new Set<string>();
      for (const s of c.stateProvided) {
        q.impactOfState(s.id)?.groups.filter(g => g.key === 'direct' || g.key === 'subscribers').forEach(g => g.items.forEach(i => flows.add(i.component.id)));
      }
      for (const p of c.contextProviders) q.contextConsumers(p.contextId).forEach(x => flows.add(x.id));
      flows.delete(c.id);
      if (flows.size > 0) {
        lenses.push(new vscode.CodeLens(range, {
          title: `$(pulse) shares state with ${plural(flows.size, 'component')}`,
          tooltip: 'Show everything affected when this component\'s state changes',
          command: 'reactStateMap.showImpact',
          arguments: [{ componentId: c.id, filePath }],
        }));
      }

      // Drilling involvement
      const drilling = q.drillingFor(c.id);
      const origin = drilling.find(d => d.origin === c.id);
      const forwards = drilling.find(d => d.passThroughIds?.includes(c.id));
      if (origin) {
        const values = [...new Set(drilling.filter(d => d.origin === c.id).map(d => d.stateName))];
        lenses.push(new vscode.CodeLens(range, {
          title: `$(warning) drills ${values.map(v => `"${v}"`).join(', ')} ${origin.path.length - 1} levels deep`,
          tooltip: origin.path.join(' → '),
          command: 'reactStateMap.liftToContext',
          arguments: [{ drillingPathId: origin.id, filePath }],
        }));
      } else if (forwards) {
        lenses.push(new vscode.CodeLens(range, {
          title: `$(arrow-right) only forwards "${forwards.stateName}" (${forwards.path[0]} → ${forwards.path[forwards.path.length - 1]})`,
          tooltip: forwards.path.join(' → '),
          command: 'reactStateMap.liftToContext',
          arguments: [{ drillingPathId: forwards.id, filePath }],
        }));
      }

      lenses.push(new vscode.CodeLens(range, {
        title: '$(graph) graph',
        tooltip: 'Show this component in the State Map',
        command: 'reactStateMap.showInStateMap',
        arguments: [{ componentId: c.id, filePath }],
      }));
    }

    // State declarations
    for (const c of q.componentsInFile(filePath)) {
      for (const s of c.stateProvided) {
        if (s.line - 1 >= document.lineCount) continue;
        const impact = q.impactOfState(s.id);
        const affected = impact?.groups.filter(g => g.key !== 'rerender').reduce((n, g) => n + g.items.length, 0) ?? 0;
        if (!affected) continue;
        const range = new vscode.Range(toPosition(s.line), toPosition(s.line));
        lenses.push(new vscode.CodeLens(range, {
          title: `$(pulse) ${s.name.split(',')[0]} → used by ${plural(affected, 'other component')}`,
          tooltip: impact!.summary,
          command: 'reactStateMap.showImpact',
          arguments: [{ stateId: s.id, filePath }],
        }));
      }
    }
    return lenses;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
