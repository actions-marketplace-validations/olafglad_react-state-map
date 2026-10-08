import * as vscode from 'vscode';
import * as path from 'node:path';
import type { SourceLocation } from '@react-state-map/core';

/** Our data uses 1-based lines and 0-based columns */
export function toPosition(line: number, column = 0): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
}

export function toLocation(loc: SourceLocation): vscode.Location {
  return new vscode.Location(vscode.Uri.file(loc.filePath), toPosition(loc.line, loc.column));
}

export function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

export function shortPath(filePath: string, rootDir?: string): string {
  if (rootDir) {
    const rel = path.relative(rootDir, filePath);
    if (!rel.startsWith('..')) return rel.split(path.sep).join('/');
  }
  return filePath.split(/[\\/]/).slice(-2).join('/');
}

/** command: link for MarkdownString (must be listed in isTrusted.enabledCommands) */
export function commandLink(label: string, command: string, args: unknown, tooltip?: string): string {
  const encoded = encodeURIComponent(JSON.stringify([args]));
  const title = tooltip ? ` "${tooltip.replace(/"/g, "'")}"` : '';
  return `[${label}](command:${command}?${encoded}${title})`;
}

export function openLocationLink(label: string, loc: { filePath: string; line: number; column?: number }): string {
  return commandLink(label, 'reactStateMap.openLocation', { filePath: loc.filePath, line: loc.line, column: loc.column ?? 0 }, `${path.basename(loc.filePath)}:${loc.line}`);
}

export async function openLocation(loc: { filePath: string; line: number; column?: number }, preserveFocus = false): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.filePath));
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus, preview: true });
  const pos = toPosition(loc.line, loc.column ?? 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

export const STATE_TYPE_LABEL: Record<string, string> = {
  useState: 'useState',
  useReducer: 'useReducer',
  useContext: 'context',
  zustand: 'Zustand',
  redux: 'Redux',
  customHook: 'hook',
  props: 'props',
  serverState: 'server state',
  atom: 'atom',
  machine: 'state machine',
  form: 'form',
  router: 'router',
  useActionState: 'useActionState',
  useOptimistic: 'useOptimistic',
  externalStore: 'external store',
};
