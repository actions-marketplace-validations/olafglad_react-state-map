import * as vscode from 'vscode';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GraphQuery } from '@react-state-map/core/query';
import type { FixPlan } from '@react-state-map/core';
import type { AnalysisSnapshot, AnalyzerOptions, FileChange, WorkerRequest, WorkerRequestBody, WorkerResponse } from './protocol';

type PendingRequest = { resolve: (r: WorkerResponse) => void };

const SOURCE_EXTENSIONS = /\.(tsx|jsx|ts|js|mts|mjs)$/;

/**
 * Keeps an incremental analysis of one workspace folder alive in a worker thread and
 * feeds it file changes (including unsaved editor buffers). Features read `query`.
 */
export class AnalysisService implements vscode.Disposable {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private queued = new Map<string, FileChange>();
  private flushTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private _snapshot: AnalysisSnapshot | undefined;
  private _query: GraphQuery | undefined;
  private _busy = false;

  private readonly _onDidChange = new vscode.EventEmitter<AnalysisService>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeBusy = new vscode.EventEmitter<boolean>();
  readonly onDidChangeBusy = this._onDidChangeBusy.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {}

  get snapshot(): AnalysisSnapshot | undefined {
    return this._snapshot;
  }

  get query(): GraphQuery | undefined {
    return this._query;
  }

  get busy(): boolean {
    return this._busy;
  }

  get rootDir(): string {
    return this.folder.uri.fsPath;
  }

  contains(filePath: string): boolean {
    const rel = path.relative(this.rootDir, filePath);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  async start(): Promise<void> {
    this.stopWorker();
    const workerPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'worker.js').fsPath;
    this.worker = new Worker(workerPath);
    this.worker.on('message', (res: WorkerResponse) => {
      const p = this.pending.get(res.id);
      if (p) {
        this.pending.delete(res.id);
        p.resolve(res);
      }
    });
    this.worker.on('error', err => this.output.appendLine(`[worker] ${err.stack ?? err.message}`));
    this.worker.on('exit', code => {
      if (!this.disposed && code !== 0) this.output.appendLine(`[worker] exited with code ${code}`);
      for (const p of this.pending.values()) p.resolve({ id: -1, ok: false, error: 'Analyzer stopped' });
      this.pending.clear();
    });

    const started = Date.now();
    await this.run({ type: 'init', rootDir: this.rootDir, options: readOptions(this.folder) });
    if (this._snapshot) {
      const meta = this._snapshot.graph.meta;
      this.output.appendLine(
        `[${this.folder.name}] analyzed ${meta?.filesAnalyzed ?? '?'} files in ${Date.now() - started}ms` +
          (meta?.frameworks.length ? ` (${meta.frameworks.join(', ')})` : '')
      );
    }

    // Pick up edits made in buffers that were already open and dirty
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty) this.notifyChange(doc.uri.fsPath, doc.getText());
    }
  }

  /** content: string = new buffer text; undefined = read from disk; null = deleted */
  notifyChange(filePath: string, content?: string | null): void {
    const isConfig = /(package|tsconfig|jsconfig)[^/\\]*\.json$/.test(filePath);
    if (!this.contains(filePath) || (!SOURCE_EXTENSIONS.test(filePath) && !isConfig)) return;
    this.queued.set(filePath, { filePath, content });
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 350);
  }

  /** Force an immediate re-analysis of pending changes */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // Serialize: wait for the current request, then send everything that queued up meanwhile
    await this.inFlight;
    if (this.queued.size === 0) return;
    const changes = [...this.queued.values()];
    this.queued.clear();
    await this.run({ type: 'update', changes });
  }

  async planLift(drillingPathId: string, react19?: boolean): Promise<FixPlan> {
    await this.flush();
    const res = await this.request({ type: 'planLift', drillingPathId, react19 });
    if (!res.ok) throw new Error(res.error);
    return res.plan!;
  }

  async planRemoveProp(insightId: string): Promise<FixPlan> {
    await this.flush();
    const res = await this.request({ type: 'planRemoveProp', insightId });
    if (!res.ok) throw new Error(res.error);
    return res.plan!;
  }

  private async run(req: WorkerRequestBody): Promise<void> {
    this.setBusy(true);
    const promise = this.request(req).then(res => {
      if (res.ok && res.snapshot) {
        this._snapshot = res.snapshot;
        this._query = new GraphQuery(res.snapshot.graph);
        for (const e of res.snapshot.errors) this.output.appendLine(`[parse error] ${e.filePath}: ${e.message}`);
        this._onDidChange.fire(this);
      } else if (!res.ok) {
        this.output.appendLine(`[analysis failed] ${res.error}`);
      }
    });
    this.inFlight = promise.catch(() => undefined);
    try {
      await promise;
    } finally {
      if (this.queued.size === 0) this.setBusy(false);
    }
  }

  private request(req: WorkerRequestBody): Promise<WorkerResponse> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({ id: -1, ok: false, error: 'Analyzer not running' });
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._onDidChangeBusy.fire(busy);
  }

  private stopWorker(): void {
    if (this.worker) {
      void this.worker.terminate();
      this.worker = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.stopWorker();
    this._onDidChange.dispose();
    this._onDidChangeBusy.dispose();
  }
}

export function readOptions(folder: vscode.WorkspaceFolder): AnalyzerOptions {
  const config = vscode.workspace.getConfiguration('reactStateMap', folder.uri);
  const include = config.get<string[]>('include');
  const exclude = config.get<string[]>('exclude');
  return {
    include: include?.length ? include : undefined,
    exclude: exclude?.length ? exclude : undefined,
    drillingThreshold: config.get<number>('drillingThreshold', 3),
  };
}
