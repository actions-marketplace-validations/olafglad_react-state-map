import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FixPlan } from '@react-state-map/core';
import { diffLineEdits } from '@react-state-map/core/format';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import { insightForDiagnostic } from './diagnostics';

/** Quick fixes for drilling (lift into context) and unused props */
export class FixesFeature implements vscode.CodeActionProvider, vscode.Disposable {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: AnalysisManager) {
    this.disposables.push(
      vscode.languages.registerCodeActionsProvider(
        [{ language: 'typescriptreact' }, { language: 'javascriptreact' }, { language: 'typescript' }, { language: 'javascript' }],
        this,
        { providedCodeActionKinds: FixesFeature.kinds }
      ),
      vscode.commands.registerCommand('reactStateMap.liftToContext', (args?: { drillingPathId?: string; filePath?: string }) =>
        this.liftToContext(args)
      ),
      vscode.commands.registerCommand('reactStateMap.removeUnusedProp', (args: { insightId: string; filePath: string }) =>
        this.removeUnusedProp(args)
      )
    );
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const service = this.manager.serviceFor(document.uri);
    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();

    for (const diagnostic of context.diagnostics) {
      const insight = insightForDiagnostic(service, document.uri, diagnostic);
      if (!insight) continue;

      if ((insight.code === 'PROP_DRILLING' || insight.code === 'PROP_PASSTHROUGH') && insight.drillingPathId) {
        const path = service?.query?.drilling.find(d => d.id === insight.drillingPathId);
        const key = `lift:${path?.stateId}:${path?.componentIds?.join('>')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const action = new vscode.CodeAction(
          `Lift "${path?.stateName ?? insight.propName}" into a React context…`,
          vscode.CodeActionKind.QuickFix.append('reactStateMap')
        );
        action.diagnostics = [diagnostic];
        action.isPreferred = insight.code === 'PROP_DRILLING';
        action.command = {
          title: action.title,
          command: 'reactStateMap.liftToContext',
          arguments: [{ drillingPathId: insight.drillingPathId, filePath: document.uri.fsPath }],
        };
        actions.push(action);

        const impact = new vscode.CodeAction('Show the drilling chain', vscode.CodeActionKind.QuickFix.append('reactStateMap'));
        impact.diagnostics = [diagnostic];
        impact.command = {
          title: impact.title,
          command: 'reactStateMap.showImpact',
          arguments: [{ stateId: insight.stateId, filePath: document.uri.fsPath }],
        };
        actions.push(impact);
      }

      if (insight.code === 'UNUSED_PROP') {
        const action = new vscode.CodeAction(`Remove unused prop "${insight.propName}"`, vscode.CodeActionKind.QuickFix.append('reactStateMap'));
        action.diagnostics = [diagnostic];
        action.isPreferred = true;
        action.command = {
          title: action.title,
          command: 'reactStateMap.removeUnusedProp',
          arguments: [{ insightId: insight.id, filePath: document.uri.fsPath }],
        };
        actions.push(action);
      }
    }
    return actions;
  }

  private async liftToContext(args?: { drillingPathId?: string; filePath?: string }): Promise<void> {
    const service = args?.filePath ? this.manager.serviceFor(args.filePath) : this.manager.active();
    if (!service?.query) return;

    let drillingPathId = args?.drillingPathId;
    if (!drillingPathId) {
      // Invoked from the command palette: pick a drilling chain
      const routes = new Map<string, { label: string; description: string; id: string }>();
      for (const d of service.query.drilling) {
        const key = `${d.stateId}|${d.componentIds?.join('>')}`;
        if (!routes.has(key)) routes.set(key, { label: d.stateName, description: d.path.join(' → '), id: d.id! });
      }
      if (routes.size === 0) {
        void vscode.window.showInformationMessage('No prop drilling detected in this workspace. 🎉');
        return;
      }
      const pick = await vscode.window.showQuickPick([...routes.values()], { placeHolder: 'Which drilled value should move into a context?' });
      if (!pick) return;
      drillingPathId = pick.id;
    }

    const react19 = vscode.workspace.getConfiguration('reactStateMap', service.folder.uri).get<string>('fixes.providerSyntax', 'auto');
    const plan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'React State Map: planning refactor…' },
      () => service.planLift(drillingPathId!, react19 === 'auto' ? undefined : react19 === 'react19')
    );
    await this.applyPlan(plan, true);
  }

  private async removeUnusedProp(args: { insightId: string; filePath: string }): Promise<void> {
    const service = this.manager.serviceFor(args.filePath);
    if (!service) return;
    const plan = await service.planRemoveProp(args.insightId);
    await this.applyPlan(plan, false);
  }

  private async applyPlan(plan: FixPlan, confirm: boolean): Promise<void> {
    if (!plan.applicable) {
      const detail = plan.reasons.map(r => `• ${r}`).join('\n');
      void vscode.window.showWarningMessage(`Can't apply "${plan.title}" safely.`, { modal: true, detail });
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    // Opt-in: VS Code lists confirmable edits unchecked in the Refactor Preview, so users pick what to apply
    const preview = confirm && vscode.workspace.getConfiguration('reactStateMap').get<boolean>('fixes.preview', false);
    const metadata: vscode.WorkspaceEditEntryMetadata = { label: plan.title, needsConfirmation: preview };

    for (const fileEdit of plan.edits) {
      const uri = vscode.Uri.file(fileEdit.filePath);
      if (fileEdit.isNew) {
        edit.createFile(uri, { ignoreIfExists: false, contents: new TextEncoder().encode(fileEdit.newText) }, metadata);
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== fileEdit.oldText) {
        void vscode.window.showWarningMessage(
          `${path.basename(fileEdit.filePath)} changed while the refactor was being planned. Save your files and try again.`
        );
        return;
      }
      // One edit per changed block so the refactor preview reads like a diff
      for (const hunk of diffLineEdits(fileEdit.oldText, fileEdit.newText)) {
        const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const start = new vscode.Position(hunk.startLine, 0);
        if (hunk.deleteCount === 0 && hunk.startLine >= doc.lineCount) {
          const end = doc.lineAt(doc.lineCount - 1).range.end;
          edit.insert(uri, end, eol + hunk.lines.join(eol), metadata);
          continue;
        }
        const endLine = hunk.startLine + hunk.deleteCount;
        const end = endLine < doc.lineCount ? new vscode.Position(endLine, 0) : doc.lineAt(doc.lineCount - 1).rangeIncludingLineBreak.end;
        const text = hunk.lines.length ? hunk.lines.join(eol) + (endLine < doc.lineCount ? eol : '') : '';
        edit.replace(uri, new vscode.Range(start, end), text, metadata);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    if (!applied || preview) return;
    const created = plan.edits.find(e => e.isNew);
    const changed = plan.edits.length;
    const message = `${plan.title} — ${changed} file${changed === 1 ? '' : 's'} updated (unsaved; undo with ${process.platform === 'darwin' ? '⌘Z' : 'Ctrl+Z'}).` +
      (plan.notes.length ? ` ${plan.notes.join(' ')}` : '');
    const open = created ? `Open ${path.basename(created.filePath)}` : undefined;
    // Don't block the command on the notification
    void vscode.window.showInformationMessage(message, ...(open ? [open] : []), 'Save All').then(async choice => {
      if (choice === 'Save All') await vscode.workspace.saveAll(false);
      else if (choice && created) await vscode.window.showTextDocument(vscode.Uri.file(created.filePath), { preview: false });
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
