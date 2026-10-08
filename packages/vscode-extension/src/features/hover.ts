import * as vscode from 'vscode';
import type { ComponentNode, StateNode } from '@react-state-map/core';
import type { GraphQuery } from '@react-state-map/core/query';
import type { AnalysisManager } from '../analysis/AnalysisManager';
import { commandLink, openLocationLink, shortPath, plural, STATE_TYPE_LABEL } from '../util';

const ENABLED_COMMANDS = [
  'reactStateMap.openLocation',
  'reactStateMap.showImpact',
  'reactStateMap.liftToContext',
  'reactStateMap.showInStateMap',
];

/** Hover on a prop → where it really comes from. Hover on state → who depends on it. */
export class HoverFeature implements vscode.HoverProvider, vscode.Disposable {
  private disposable: vscode.Disposable;

  constructor(private readonly manager: AnalysisManager) {
    this.disposable = vscode.languages.registerHoverProvider(
      [{ language: 'typescriptreact', scheme: 'file' }, { language: 'javascriptreact', scheme: 'file' }],
      this
    );
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!vscode.workspace.getConfiguration('reactStateMap').get<boolean>('hover.enabled', true)) return undefined;
    const service = this.manager.serviceFor(document.uri);
    const q = service?.query;
    if (!q) return undefined;
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
    if (!wordRange) return undefined;
    const word = document.getText(wordRange);
    const component = q.componentAt(document.uri.fsPath, position.line + 1);
    if (!component) return undefined;

    // `props.user` → hover on `user`
    const before = document.getText(new vscode.Range(wordRange.start.with({ character: Math.max(0, wordRange.start.character - 7) }), wordRange.start));
    const isMemberOfOther = /\.\s*$/.test(before) && !/props\s*\.\s*$/.test(before);

    const prop = component.props.find(p => (p.localName ?? p.name) === word || (p.name === word && /props\s*\.\s*$/.test(before)));
    let md: vscode.MarkdownString | undefined;
    if (prop && !isMemberOfOther) {
      md = this.propHover(q, component, prop.name, service.rootDir);
    } else {
      const state = component.stateProvided.find(s => s.bindings?.includes(word));
      if (state && !isMemberOfOther) md = this.stateHover(q, component, state, word, service.rootDir);
    }
    if (!md) return undefined;
    md.isTrusted = { enabledCommands: ENABLED_COMMANDS };
    md.supportThemeIcons = true;
    return new vscode.Hover(md, wordRange);
  }

  private propHover(q: GraphQuery, component: ComponentNode, propName: string, rootDir: string): vscode.MarkdownString | undefined {
    const trace = q.traceProp(component.id, propName);
    if (!trace) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`$(symbol-property) **${propName}** · prop of \`${component.name}\` — *React State Map*\n\n`);

    if (trace.origins.length) {
      for (const origin of trace.origins.slice(0, 3)) {
        const s = origin.state;
        const kind = s.library && s.library !== 'react' ? `${STATE_TYPE_LABEL[s.type] ?? s.type} · ${s.library}` : STATE_TYPE_LABEL[s.type] ?? s.type;
        const value = origin.isSetter ? (s.setterName ?? s.name) : s.name.split(',')[0];
        md.appendMarkdown(`**Comes from** ${openLocationLink(`${origin.owner.name} › ${value}`, s)} (${kind})\n\n`);
        const hops = [
          openLocationLink(origin.owner.name, origin.owner),
          ...origin.chain.map(h => {
            const label = h.component.name + (h.propName !== propName || h.viaSpread ? ` (${h.viaSpread ? '…spread' : h.propName})` : '');
            return h.location ? openLocationLink(label, h.location) : label;
          }),
        ];
        md.appendMarkdown(`${hops.join(' → ')}\n\n`);
      }
      const drilling = q.drilling.find(d => d.consumerId === component.id && trace.origins.some(o => o.state.id === d.stateId));
      if (drilling) {
        md.appendMarkdown(
          `$(warning) Drilled through ${plural(drilling.passThroughIds?.length ?? 0, 'component')} that only forward it. ` +
            `${commandLink('Lift into a context…', 'reactStateMap.liftToContext', { drillingPathId: drilling.id, filePath: component.filePath })}\n\n`
        );
      }
    } else if (trace.callSites.length) {
      md.appendMarkdown(`**Passed by**\n\n`);
      for (const site of trace.callSites.slice(0, 6)) {
        const value = site.value ? ` \`${propName}=${site.value.length > 40 ? site.value.slice(0, 39) + '…' : site.value}\`` : ' *(not passed)*';
        md.appendMarkdown(`- ${openLocationLink(site.parent.name, site)}${value}${site.count > 1 ? ` · ${site.count} sites` : ''}\n`);
      }
      if (trace.callSites.length > 6) md.appendMarkdown(`- …and ${trace.callSites.length - 6} more\n`);
    } else {
      md.appendMarkdown(`*No call sites found in ${shortPath(rootDir)} — it's rendered from outside the analyzed code or not at all.*`);
    }
    return md;
  }

  private stateHover(q: GraphQuery, component: ComponentNode, state: StateNode, word: string, _rootDir: string): vscode.MarkdownString | undefined {
    const impact = q.impactOfState(state.id);
    const md = new vscode.MarkdownString();
    const kind = STATE_TYPE_LABEL[state.type] ?? state.type;
    const source = state.storeName ? ` · \`${state.storeName}\`` : state.hookName ? ` · \`${state.hookName}()\`` : '';
    md.appendMarkdown(`$(pulse) **${word}** · ${kind}${state.library && state.library !== 'react' ? ` (${state.library})` : ''}${source} in \`${component.name}\` — *React State Map*\n\n`);
    if (!impact || impact.groups.length === 0) {
      md.appendMarkdown('Only used inside this component.');
      return md;
    }
    for (const g of impact.groups.slice(0, 4)) {
      const names = g.items.slice(0, 5).map(i => openLocationLink(i.component.name, i.component)).join(', ');
      md.appendMarkdown(`**${g.label}:** ${names}${g.items.length > 5 ? ` +${g.items.length - 5}` : ''}\n\n`);
    }
    md.appendMarkdown(commandLink('$(references) Show full impact', 'reactStateMap.showImpact', { stateId: state.id, filePath: component.filePath }));
    return md;
  }

  dispose(): void {
    this.disposable.dispose();
  }
}
