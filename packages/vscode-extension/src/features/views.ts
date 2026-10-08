import * as vscode from 'vscode';
import type { ComponentNode, ImpactReport } from '@react-state-map/core';
import type { GraphQuery } from '@react-state-map/core/query';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import { STATE_TYPE_LABEL, shortPath, plural } from '../util';

type Loc = { filePath: string; line: number; column?: number };

class Item extends vscode.TreeItem {
  children?: Item[];
  constructor(label: string, opts: { description?: string; tooltip?: string; icon?: string; color?: string; loc?: Loc; children?: Item[]; expanded?: boolean } = {}) {
    super(label, opts.children?.length
      ? (opts.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None);
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    this.children = opts.children;
    if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon, opts.color ? new vscode.ThemeColor(opts.color) : undefined);
    if (opts.loc) this.command = { title: 'Open', command: 'reactStateMap.openLocation', arguments: [opts.loc] };
  }
}

abstract class TreeProvider implements vscode.TreeDataProvider<Item> {
  protected readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  protected roots: Item[] = [];
  getTreeItem(item: Item): Item {
    return item;
  }
  getChildren(item?: Item): Item[] {
    return item ? item.children ?? [] : this.roots;
  }
}

/** Follows the cursor: everything about the component you're editing */
export class InspectorView extends TreeProvider implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<Item>;
  private currentId: string | undefined;

  constructor(private readonly manager: AnalysisManager) {
    super();
    this.view = vscode.window.createTreeView('reactStateMap.inspector', { treeDataProvider: this });
    this.disposables.push(
      this.view,
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      manager.onDidChange(() => this.refresh(true))
    );
    this.refresh(true);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(false), 150);
  }

  private refresh(force: boolean): void {
    const editor = vscode.window.activeTextEditor;
    const service = editor ? this.manager.serviceFor(editor.document.uri) : undefined;
    const q = service?.query;
    const component = editor && q ? q.componentAt(editor.document.uri.fsPath, editor.selection.active.line + 1) : undefined;
    if (!force && component?.id === this.currentId) return;
    this.currentId = component?.id;

    if (!q || !component) {
      this.roots = [];
      this.view.message = !editor
        ? 'Open a React file to inspect its components.'
        : q ? 'Move the cursor into a React component.' : 'Analyzing…';
      this.view.description = undefined;
    } else {
      this.view.message = undefined;
      this.view.description = component.name;
      this.roots = buildInspector(q, component, service!.rootDir);
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}

function buildInspector(q: GraphQuery, c: ComponentNode, rootDir: string): Item[] {
  const roots: Item[] = [];
  const badges = [c.kind, c.environment && `${c.environment} component`, c.isExported ? 'exported' : undefined].filter(Boolean).join(' · ');
  roots.push(new Item(c.name, { description: badges, icon: 'symbol-class', loc: c, tooltip: `${shortPath(c.filePath, rootDir)}:${c.line}` }));

  // Props with their origins
  const props = c.props.map(p => {
    const trace = q.traceProp(c.id, p.name);
    const origin = trace?.origins[0];
    let description: string;
    let loc: Loc | undefined = p.line ? { filePath: c.filePath, line: p.line, column: p.column } : undefined;
    if (origin) {
      description = `← ${origin.owner.name}.${origin.isSetter ? origin.state.setterName ?? origin.state.name : origin.state.name.split(',')[0]} · ${plural(origin.chain.length, 'hop')}`;
      loc = origin.state;
    } else if (trace?.callSites.length) {
      const values = [...new Set(trace.callSites.map(s => s.value).filter(Boolean))];
      description = values.length === 1 ? `= ${values[0]}` : `${plural(trace.callSites.length, 'call site')}`;
    } else {
      description = p.type ?? '';
    }
    return new Item(p.name, {
      description,
      icon: p.isUsed ? 'symbol-property' : 'circle-slash',
      tooltip: p.isUsed ? p.type : 'Never used or forwarded',
      loc,
    });
  });
  if (props.length) roots.push(new Item('Props', { description: String(props.length), icon: 'symbol-parameter', children: props, expanded: true }));

  const state = c.stateProvided.map(s => {
    const impact = q.impactOfState(s.id);
    const n = impact?.componentIds.length ?? 0;
    return new Item(s.name, {
      description: `${STATE_TYPE_LABEL[s.type] ?? s.type}${s.library && s.library !== 'react' ? ` · ${s.library}` : ''}${n ? ` · affects ${n}` : ''}`,
      icon: 'pulse',
      loc: s,
    });
  });
  if (state.length) roots.push(new Item('State', { description: String(state.length), icon: 'database', children: state, expanded: true }));

  const ctx = [
    ...c.contextProviders.map(p => new Item(p.contextName, { description: `provides → ${plural(q.contextConsumers(p.contextId).length, 'consumer')}`, icon: 'broadcast' })),
    ...c.contextConsumers.map(name => new Item(name, { description: 'consumes', icon: 'plug' })),
  ];
  if (ctx.length) roots.push(new Item('Context', { description: String(ctx.length), icon: 'broadcast', children: ctx, expanded: true }));

  const parents = q.parents(c.id).map(r => new Item(q.components.get(r.from)?.name ?? r.from, {
    description: `${shortPath(r.filePath, rootDir)}:${r.line}${(r.count ?? 1) > 1 ? ` · ${r.count}×` : ''}`,
    icon: 'arrow-up',
    loc: r,
  }));
  roots.push(new Item('Rendered by', { description: String(parents.length), icon: 'type-hierarchy-super', children: parents, expanded: parents.length <= 5 }));

  const children = q.children(c.id).map(r => {
    const child = q.components.get(r.to);
    return new Item(child?.name ?? r.to, { description: child ? shortPath(child.filePath, rootDir) : '', icon: 'arrow-down', loc: r });
  });
  if (children.length) roots.push(new Item('Renders', { description: String(children.length), icon: 'type-hierarchy-sub', children }));

  const insights = q.insights.filter(i => i.componentId === c.id || (i.code === 'PROP_DRILLING' && q.drillingFor(c.id).some(d => d.id === i.drillingPathId)));
  if (insights.length) {
    roots.push(new Item('Issues', {
      description: String(insights.length),
      icon: 'warning',
      color: 'problemsWarningIcon.foreground',
      expanded: true,
      children: insights.map(i => new Item(i.message, { icon: i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info', loc: i, tooltip: i.message })),
    }));
  }
  return roots;
}

/** Shows the last "Show Impact" report */
export class ImpactView extends TreeProvider implements vscode.Disposable {
  private view: vscode.TreeView<Item>;
  report: ImpactReport | undefined;

  constructor() {
    super();
    this.view = vscode.window.createTreeView('reactStateMap.impact', { treeDataProvider: this, showCollapseAll: true });
    this.view.message = 'Run "React State Map: Show Impact" on a component or a piece of state.';
  }

  show(report: ImpactReport, q: GraphQuery, rootDir: string): void {
    this.report = report;
    this.view.message = report.summary;
    this.view.description = report.target.name;
    this.roots = report.groups.map(g => new Item(g.label, {
      description: String(g.items.length),
      icon: g.key === 'direct' ? 'arrow-right' : g.key === 'subscribers' ? 'radio-tower' : g.key === 'consumers' ? 'broadcast' : g.key === 'callers' ? 'call-incoming' : 'type-hierarchy-sub',
      expanded: g.key !== 'rerender' && g.key !== 'descendants',
      children: g.items.map(i => new Item(i.component.name, {
        description: i.reason,
        tooltip: `${shortPath(i.component.filePath, rootDir)}:${i.component.line}`,
        icon: q.components.get(i.component.id)?.kind === 'memo' ? 'shield' : 'symbol-class',
        loc: i.component,
      })),
    }));
    void vscode.commands.executeCommand('setContext', 'reactStateMap.hasImpact', true);
    this._onDidChange.fire();
  }

  clear(): void {
    this.report = undefined;
    this.roots = [];
    this.view.message = 'Run "React State Map: Show Impact" on a component or a piece of state.';
    this.view.description = undefined;
    void vscode.commands.executeCommand('setContext', 'reactStateMap.hasImpact', false);
    this._onDidChange.fire();
  }

  dispose(): void {
    this.view.dispose();
    this._onDidChange.dispose();
  }
}
