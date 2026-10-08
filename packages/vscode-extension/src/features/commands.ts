import * as vscode from 'vscode';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import type { AnalysisService } from '../analysis/AnalysisService';
import { StateMapPanel } from '../panels/StateMapPanel';
import type { ImpactView } from './views';
import { openLocation, shortPath, plural } from '../util';

interface Target {
  componentId?: string;
  stateId?: string;
  contextId?: string;
  filePath?: string;
}

/** Graph panel + navigation/impact commands */
export class CommandsFeature implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private panelService: AnalysisService | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: AnalysisManager,
    private readonly impactView: ImpactView
  ) {
    const reg = (id: string, fn: (...args: any[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));

    reg('reactStateMap.openPanel', () => this.openPanel());
    reg('reactStateMap.refresh', async () => {
      await this.manager.restart();
      void vscode.window.setStatusBarMessage('$(check) React State Map refreshed', 2000);
    });
    reg('reactStateMap.openLocation', (loc: { filePath: string; line: number; column?: number }) => openLocation(loc));
    reg('reactStateMap.showInStateMap', (target?: Target) => this.showInStateMap(target));
    reg('reactStateMap.showImpact', (target?: Target) => this.showImpact(target));
    reg('reactStateMap.clearImpact', () => {
      this.impactView.clear();
      StateMapPanel.currentPanel?.clearHighlight();
    });
    reg('reactStateMap.highlightImpact', () => {
      const report = this.impactView.report;
      if (!report) return;
      const panel = this.openPanel();
      panel?.highlight(report.componentIds, `Impact of ${report.target.name}: ${report.summary}`, report.target.kind === 'component' ? report.target.id : undefined);
    });
    reg('reactStateMap.peekRelations', (target?: Target) => this.peekRelations(target));
    reg('reactStateMap.goToComponent', () => this.goToComponent());

    this.disposables.push(
      manager.onDidChange(service => {
        const panel = StateMapPanel.currentPanel;
        if (panel && service === this.panelService && service.snapshot) panel.setData(service.snapshot);
        this.refreshImpact(service);
      })
    );
  }

  private openPanel(service = this.manager.active()): StateMapPanel | undefined {
    if (!service) {
      void vscode.window.showInformationMessage('Open a folder containing a React project to use React State Map.');
      return undefined;
    }
    const existed = !!StateMapPanel.currentPanel;
    const panel = StateMapPanel.createOrShow(this.context.extensionUri, service.snapshot);
    if (this.panelService !== service && service.snapshot) panel.setData(service.snapshot);
    this.panelService = service;
    if (!existed) {
      panel.onDidRequestRefresh(() => void this.manager.restart());
      panel.onDidDispose(() => (this.panelService = undefined));
    }
    return panel;
  }

  /** Resolve the command target: explicit args, else whatever is under the cursor */
  private resolveTarget(target?: Target): { service: AnalysisService; target: Target } | undefined {
    const editor = vscode.window.activeTextEditor;
    const service = target?.filePath
      ? this.manager.serviceFor(target.filePath)
      : editor ? this.manager.serviceFor(editor.document.uri) : this.manager.active();
    const q = service?.query;
    if (!service || !q) {
      void vscode.window.showInformationMessage('React State Map is still analyzing this workspace…');
      return undefined;
    }
    if (target?.componentId || target?.stateId || target?.contextId) return { service, target };
    if (!editor) return undefined;

    const line = editor.selection.active.line + 1;
    const filePath = editor.document.uri.fsPath;
    const component = q.componentAt(filePath, line);
    if (!component) {
      void vscode.window.showInformationMessage('Place the cursor inside a React component.');
      return undefined;
    }
    // On a state declaration line → that state, otherwise the component
    const state = component.stateProvided.find(s => s.line === line);
    return { service, target: state ? { stateId: state.id } : { componentId: component.id } };
  }

  private showInStateMap(target?: Target): void {
    const resolved = this.resolveTarget(target);
    if (!resolved) return;
    const id = resolved.target.componentId ?? (resolved.target.stateId && resolved.service.query?.stateNodes.get(resolved.target.stateId)?.ownerId);
    const panel = this.openPanel(resolved.service);
    if (panel && id) panel.focusComponent(id);
  }

  private impactTarget: { service: AnalysisService; target: Target } | undefined;

  private computeImpact(service: AnalysisService, t: Target) {
    const q = service.query;
    if (!q) return undefined;
    return t.stateId ? q.impactOfState(t.stateId) : t.contextId ? q.impactOfContext(t.contextId) : t.componentId ? q.impactOfComponent(t.componentId) : undefined;
  }

  /** Keep the Impact view in sync with edits (or clear it when its target disappears) */
  private refreshImpact(service: AnalysisService): void {
    if (!this.impactTarget || this.impactTarget.service !== service || !this.impactView.report) return;
    const report = this.computeImpact(service, this.impactTarget.target);
    if (report) this.impactView.show(report, service.query!, service.rootDir);
    else {
      this.impactView.clear();
      this.impactTarget = undefined;
    }
  }

  private async showImpact(target?: Target): Promise<void> {
    const resolved = this.resolveTarget(target);
    if (!resolved) return;
    const { service, target: t } = resolved;
    const q = service.query!;
    const report = this.computeImpact(service, t);
    if (!report) return;
    this.impactTarget = { service, target: t };
    this.impactView.show(report, q, service.rootDir);
    await vscode.commands.executeCommand('reactStateMap.impact.focus');
    StateMapPanel.currentPanel?.highlight(report.componentIds, `Impact of ${report.target.name}: ${report.summary}`, t.componentId);
  }

  private async peekRelations(target?: Target): Promise<void> {
    const resolved = this.resolveTarget(target);
    if (!resolved?.target.componentId) return;
    const q = resolved.service.query!;
    const id = resolved.target.componentId;
    const c = q.components.get(id)!;
    type Pick = vscode.QuickPickItem & { loc?: { filePath: string; line: number; column?: number } };
    const items: Pick[] = [];
    const parents = q.parents(id);
    items.push({ label: `Rendered by (${parents.length})`, kind: vscode.QuickPickItemKind.Separator });
    for (const r of parents) {
      const props = r.props?.filter(p => p.name !== '...spread').map(p => p.name).join(', ');
      items.push({ label: `$(arrow-up) ${q.components.get(r.from)?.name}`, description: `${shortPath(r.filePath, resolved.service.rootDir)}:${r.line}`, detail: props ? `passes ${props}` : undefined, loc: r });
    }
    const children = q.children(id);
    items.push({ label: `Renders (${children.length})`, kind: vscode.QuickPickItemKind.Separator });
    for (const r of children) {
      const child = q.components.get(r.to);
      items.push({ label: `$(arrow-down) ${child?.name}`, description: child ? shortPath(child.filePath, resolved.service.rootDir) : '', loc: child ? { filePath: child.filePath, line: child.line } : r });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${c.name}: ${plural(parents.length, 'parent')}, ${plural(children.length, 'child', 'children')}`, matchOnDescription: true });
    if (pick?.loc) await openLocation(pick.loc);
  }

  private async goToComponent(): Promise<void> {
    const service = this.manager.active();
    const q = service?.query;
    if (!q) return;
    const items = [...q.components.values()].map(c => ({
      label: c.name,
      description: shortPath(c.filePath, service!.rootDir),
      detail: [c.environment, c.stateProvided.length ? plural(c.stateProvided.length, 'state') : '', c.contextProviders.length ? 'provider' : ''].filter(Boolean).join(' · ') || undefined,
      c,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Go to React component…', matchOnDescription: true });
    if (pick) await openLocation(pick.c);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
