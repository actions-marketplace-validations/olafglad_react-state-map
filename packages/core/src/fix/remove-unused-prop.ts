import { Project, Node } from 'ts-morph';
import type { Insight } from '../types.js';
import type { FixPlan } from './lift-to-context.js';

/**
 * Remove a prop that a component destructures but never uses (UNUSED_PROP insight).
 * Only the destructuring is changed; the declared type is left alone because callers may still pass it.
 */
export function planRemoveUnusedProp(
  sourceProject: Project,
  insight: Insight,
  readFile?: (filePath: string) => string | undefined
): FixPlan {
  const title = `Remove unused prop "${insight.propName}"`;
  const fail = (reason: string): FixPlan => ({ title, description: reason, applicable: false, reasons: [reason], notes: [], edits: [] });
  if (insight.code !== 'UNUSED_PROP' || !insight.propName) return fail('Not an unused-prop insight.');

  const text = readFile?.(insight.filePath) ?? sourceProject.getSourceFile(insight.filePath)?.getFullText();
  if (text === undefined) return fail('File not found.');

  const scratch = new Project({ useInMemoryFileSystem: true });
  const sf = scratch.createSourceFile(insight.filePath, text);
  const pos = sf.compilerNode.getPositionOfLineAndCharacter(insight.line - 1, insight.column);
  const element = sf.getDescendantAtPos(pos)?.getFirstAncestor(n => Node.isBindingElement(n));
  const pattern = element?.getParent();
  if (!element || !pattern || !Node.isObjectBindingPattern(pattern) || !Node.isBindingElement(element)) {
    return fail('Could not find the prop in the destructuring pattern.');
  }

  const remaining = pattern.getElements().filter(e => e !== element).map(e => e.getText());
  pattern.replaceWithText(remaining.length ? `{ ${remaining.join(', ')} }` : '{}');

  return {
    title,
    description: `Stops destructuring "${insight.propName}"; callers can still pass it.`,
    applicable: true,
    reasons: [],
    notes: [],
    edits: [{ filePath: insight.filePath, oldText: text, newText: sf.getFullText() }],
  };
}
