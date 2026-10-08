import * as vscode from 'vscode';
import { AnalysisService } from './AnalysisService';

const WATCH_GLOB = '**/*.{tsx,jsx,ts,js,mts,mjs}';
const CONFIG_GLOB = '**/{package.json,tsconfig*.json,jsconfig.json}';

/** One AnalysisService per workspace folder; routes editor events to the right one */
export class AnalysisManager implements vscode.Disposable {
  private services = new Map<string, AnalysisService>();
  private disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<AnalysisService>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeBusy = new vscode.EventEmitter<void>();
  readonly onDidChangeBusy = this._onDidChangeBusy.event;

  constructor(private readonly extensionUri: vscode.Uri, private readonly output: vscode.OutputChannel) {}

  start(): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) this.add(folder);

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(e => {
        e.removed.forEach(f => this.remove(f));
        e.added.forEach(f => this.add(f));
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length === 0 || e.document.uri.scheme !== 'file') return;
        if (!vscode.workspace.getConfiguration('reactStateMap').get<boolean>('analyzeOnType', true)) return;
        this.serviceFor(e.document.uri)?.notifyChange(e.document.uri.fsPath, e.document.getText());
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;
        this.serviceFor(doc.uri)?.notifyChange(doc.uri.fsPath, doc.getText());
      }),
      // Reverting an unsaved buffer: fall back to the file on disk
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme === 'file' && doc.isDirty) this.serviceFor(doc.uri)?.notifyChange(doc.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('reactStateMap.include') ||
            e.affectsConfiguration('reactStateMap.exclude') ||
            e.affectsConfiguration('reactStateMap.drillingThreshold')) {
          void this.restart();
        }
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    const isOpenDirty = (uri: vscode.Uri) => vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString() && d.isDirty);
    watcher.onDidCreate(uri => this.serviceFor(uri)?.notifyChange(uri.fsPath));
    watcher.onDidDelete(uri => this.serviceFor(uri)?.notifyChange(uri.fsPath, null));
    // External changes (git checkout, formatters, other tools)
    watcher.onDidChange(uri => {
      if (!isOpenDirty(uri)) this.serviceFor(uri)?.notifyChange(uri.fsPath);
    });
    const configWatcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB);
    const onConfig = (uri: vscode.Uri) => {
      if (!uri.fsPath.includes('node_modules')) this.serviceFor(uri)?.notifyChange(uri.fsPath);
    };
    configWatcher.onDidChange(onConfig);
    configWatcher.onDidCreate(onConfig);
    this.disposables.push(watcher, configWatcher);
  }

  private add(folder: vscode.WorkspaceFolder): void {
    if (this.services.has(folder.uri.toString())) return;
    const service = new AnalysisService(folder, this.extensionUri, this.output);
    this.services.set(folder.uri.toString(), service);
    service.onDidChange(s => this._onDidChange.fire(s));
    service.onDidChangeBusy(() => this._onDidChangeBusy.fire());
    void service.start();
  }

  private remove(folder: vscode.WorkspaceFolder): void {
    const service = this.services.get(folder.uri.toString());
    service?.dispose();
    this.services.delete(folder.uri.toString());
  }

  async restart(): Promise<void> {
    await Promise.all([...this.services.values()].map(s => s.start()));
  }

  serviceFor(uri: vscode.Uri | string): AnalysisService | undefined {
    const filePath = typeof uri === 'string' ? uri : uri.fsPath;
    // Nested folders: prefer the deepest containing folder
    return [...this.services.values()]
      .filter(s => s.contains(filePath) || s.rootDir === filePath)
      .sort((a, b) => b.rootDir.length - a.rootDir.length)[0];
  }

  /** The service for the active editor, or the first folder with results */
  active(): AnalysisService | undefined {
    const editor = vscode.window.activeTextEditor;
    const fromEditor = editor ? this.serviceFor(editor.document.uri) : undefined;
    return fromEditor ?? [...this.services.values()].find(s => s.snapshot) ?? [...this.services.values()][0];
  }

  all(): AnalysisService[] {
    return [...this.services.values()];
  }

  get busy(): boolean {
    return this.all().some(s => s.busy);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.services.forEach(s => s.dispose());
    this._onDidChange.dispose();
    this._onDidChangeBusy.dispose();
  }
}
