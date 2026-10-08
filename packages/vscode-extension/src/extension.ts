import * as vscode from 'vscode';
import { AnalysisManager } from './analysis/AnalysisManager';
import { DiagnosticsFeature } from './features/diagnostics';
import { FixesFeature } from './features/fixes';
import { CodeLensFeature } from './features/codelens';
import { HoverFeature } from './features/hover';
import { InspectorView, ImpactView } from './features/views';
import { CommandsFeature } from './features/commands';
import { StatusBarFeature } from './features/statusBar';
import { registerLanguageModelTools } from './features/lmTools';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('React State Map');
  const manager = new AnalysisManager(context.extensionUri, output);
  const impactView = new ImpactView();

  context.subscriptions.push(
    output,
    manager,
    impactView,
    new DiagnosticsFeature(manager),
    new FixesFeature(manager),
    new CodeLensFeature(manager),
    new HoverFeature(manager),
    new InspectorView(manager),
    new CommandsFeature(context, manager, impactView),
    new StatusBarFeature(manager),
    ...registerLanguageModelTools(manager)
  );

  manager.start();
}

export function deactivate() {
  // Disposables registered on the context clean everything up
}
