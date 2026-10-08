import * as vscode from 'vscode';
import type { SerializedStateFlowGraph, GraphSummary, ParseWarning } from '@react-state-map/core';
import { getWebviewContent } from './webviewContent';

/** Everything the webview needs to render a graph. */
export interface StateMapData {
  graph: SerializedStateFlowGraph;
  summary: GraphSummary;
  warnings: ParseWarning[];
}

/** Messages posted from the extension host to the webview. */
type HostToWebviewMessage =
  | { command: 'focusNode'; componentId: string }
  | { command: 'highlightSet'; componentIds: string[]; rootId?: string; label: string }
  | { command: 'clearHighlight' }
  | { command: 'updateGraph'; graph: SerializedStateFlowGraph; summary: GraphSummary; warnings: ParseWarning[] };

/** Messages posted from the webview to the extension host. */
type WebviewToHostMessage =
  | { command: 'ready' }
  | { command: 'refresh' }
  | { command: 'openFile'; filePath?: string; line?: number };

/**
 * Webview panel hosting the state map graph.
 *
 * This is a pure view: it never analyzes the project itself. The owner pushes data in with
 * `setData()` and drives it with `focusComponent()` / `highlight()` / `clearHighlight()`.
 * Messages are queued until the webview reports `ready`, and re-queued whenever the HTML is reset.
 */
export class StateMapPanel {
  public static currentPanel: StateMapPanel | undefined;
  public static readonly viewType = 'reactStateMap';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private readonly _onDidRequestRefresh = new vscode.EventEmitter<void>();
  /** Fired when the user presses the refresh button inside the webview. */
  public readonly onDidRequestRefresh: vscode.Event<void> = this._onDidRequestRefresh.event;

  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  /** Fired once when the panel is closed/disposed. */
  public readonly onDidDispose: vscode.Event<void> = this._onDidDispose.event;

  /** True once the graph webview (not a placeholder/error page) has been loaded. */
  private _hasGraphHtml = false;
  /** True once the currently loaded graph webview has posted `ready`. */
  private _ready = false;
  private _queue: HostToWebviewMessage[] = [];
  /** Active highlight, re-sent if the webview HTML is reset. */
  private _activeHighlight: Extract<HostToWebviewMessage, { command: 'highlightSet' }> | undefined;
  private _disposed = false;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // Placeholder until the first setData()
    this._panel.webview.html = this._getPlaceholderHtml('Analyzing React components…');

    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      (message: WebviewToHostMessage) => this._handleMessage(message),
      null,
      this._disposables
    );
  }

  public static createOrShow(extensionUri: vscode.Uri, data?: StateMapData): StateMapPanel {
    // If panel exists, show it (in whatever column it currently lives)
    if (StateMapPanel.currentPanel) {
      const existing = StateMapPanel.currentPanel;
      existing._panel.reveal(undefined);
      if (data) {
        existing.setData(data);
      }
      return existing;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      StateMapPanel.viewType,
      'React State Map',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const instance = new StateMapPanel(panel, extensionUri);
    StateMapPanel.currentPanel = instance;
    if (data) {
      instance.setData(data);
    }
    return instance;
  }

  /** Whether the panel is currently visible. */
  public get visible(): boolean {
    return !this._disposed && this._panel.visible;
  }

  /**
   * Replace the graph shown in the panel. The first call loads the webview HTML;
   * later calls update the graph in place (viewport/selection/view are preserved).
   */
  public setData(data: StateMapData): void {
    if (this._disposed) return;

    if (!this._hasGraphHtml) {
      // Pending graph updates are superseded by the freshly rendered HTML
      this._queue = this._queue.filter((m) => m.command !== 'updateGraph');
      this._setHtml(getWebviewContent(data.graph, data.summary, data.warnings), true);
      return;
    }

    this._post({
      command: 'updateGraph',
      graph: data.graph,
      summary: data.summary,
      warnings: data.warnings,
    });
  }

  /** Show an error page in the panel (e.g. when analysis failed). The next setData() reloads the graph. */
  public showError(message: string): void {
    if (this._disposed) return;
    this._setHtml(this._getErrorHtml(message), false);
  }

  /** Center, flash and select a component (by component id) in the State Flow view. */
  public focusComponent(componentId: string): void {
    this._post({ command: 'focusNode', componentId });
  }

  /** Enter "impact mode": dim everything outside `componentIds` and show a banner with `label`. */
  public highlight(componentIds: string[], label: string, rootId?: string): void {
    const message: Extract<HostToWebviewMessage, { command: 'highlightSet' }> = {
      command: 'highlightSet',
      componentIds: [...componentIds],
      label,
      ...(rootId !== undefined ? { rootId } : {}),
    };
    this._activeHighlight = message;
    // A newer highlight supersedes any queued highlight/clear
    this._queue = this._queue.filter((m) => m.command !== 'highlightSet' && m.command !== 'clearHighlight');
    this._post(message);
  }

  /** Leave impact mode. */
  public clearHighlight(): void {
    this._activeHighlight = undefined;
    this._queue = this._queue.filter((m) => m.command !== 'highlightSet' && m.command !== 'clearHighlight');
    this._post({ command: 'clearHighlight' });
  }

  public dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (StateMapPanel.currentPanel === this) {
      StateMapPanel.currentPanel = undefined;
    }

    this._queue = [];
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }

    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidRequestRefresh.dispose();
  }

  private _setHtml(html: string, isGraph: boolean) {
    // A new document has no listener yet: queue everything until it reports ready
    this._ready = false;
    this._hasGraphHtml = isGraph;
    if (isGraph && this._activeHighlight) {
      // Restore impact mode in the fresh document (dedupe against anything already queued)
      const active = this._activeHighlight;
      this._queue = this._queue.filter((m) => m.command !== 'highlightSet' && m.command !== 'clearHighlight');
      this._queue.push(active);
    }
    this._panel.webview.html = html;
  }

  private _post(message: HostToWebviewMessage) {
    if (this._disposed) return;

    if (this._ready && this._hasGraphHtml) {
      void this._panel.webview.postMessage(message);
      return;
    }

    if (message.command === 'updateGraph') {
      // Only the latest graph matters
      this._queue = this._queue.filter((m) => m.command !== 'updateGraph');
    }
    this._queue.push(message);
  }

  private _flushQueue() {
    const pending = this._queue;
    this._queue = [];
    // Apply graph updates first so focus/highlight target the latest graph
    const ordered = [
      ...pending.filter((m) => m.command === 'updateGraph'),
      ...pending.filter((m) => m.command !== 'updateGraph'),
    ];
    for (const message of ordered) {
      void this._panel.webview.postMessage(message);
    }
  }

  private _handleMessage(message: WebviewToHostMessage) {
    if (!message || typeof message !== 'object') return;
    switch (message.command) {
      case 'ready':
        if (!this._hasGraphHtml) return;
        this._ready = true;
        this._flushQueue();
        break;
      case 'openFile':
        if (message.filePath) {
          this._openFile(message.filePath, message.line);
        }
        break;
      case 'refresh':
        this._onDidRequestRefresh.fire();
        break;
    }
  }

  private async _openFile(filePath: string, line?: number) {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });

      if (line !== undefined && line > 0) {
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private _getPlaceholderHtml(message: string): string {
    return this._getMessageHtml('', message, false);
  }

  private _getErrorHtml(message: string): string {
    return this._getMessageHtml('Error', message, true);
  }

  private _getMessageHtml(title: string, message: string, isError: boolean): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .message {
      text-align: center;
      padding: 20px;
    }
    .message h2 {
      color: var(--vscode-errorForeground);
    }
    .message p {
      color: ${isError ? 'var(--vscode-editor-foreground)' : 'var(--vscode-descriptionForeground)'};
    }
  </style>
</head>
<body>
  <div class="message">
    ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
