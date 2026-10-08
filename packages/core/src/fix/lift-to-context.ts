import {
  Project,
  QuoteKind,
  IndentationText,
  SourceFile,
  Node,
  SyntaxKind,
  JsxOpeningElement,
  JsxSelfClosingElement,
  JsxAttribute,
  ClassDeclaration,
} from 'ts-morph';
import * as path from 'node:path';
import type { StateFlowGraph, PropDrillingPath, ComponentNode, StateNode } from '../types.js';
import { GraphQuery } from '../graph/query.js';
import { locateComponent } from '../parser/extract.js';

export interface FileEdit {
  filePath: string;
  /** Full original text ('' for new files) */
  oldText: string;
  /** Full new text */
  newText: string;
  isNew?: boolean;
}

export interface FixPlan {
  title: string;
  description: string;
  applicable: boolean;
  /** Why the fix can't be applied safely (when applicable is false) */
  reasons: string[];
  /** Things the user should double-check (types that fell back to `any`, etc.) */
  notes: string[];
  edits: FileEdit[];
}

export interface LiftToContextOptions {
  /** Use `<Ctx value>` (React 19) instead of `<Ctx.Provider value>`; auto-detected when omitted */
  react19?: boolean;
  /** Read current file text (e.g. unsaved editor buffers); defaults to the parser project's text */
  readFile?: (filePath: string) => string | undefined;
}

interface Thread {
  path: PropDrillingPath;
  /** Owner binding passed down (selectedId / setSelectedId) */
  ownerBinding: string;
  /** Prop name at each hop, aligned with steps */
  propNames: string[];
}

const pascal = (s: string) => s.replace(/(^|[_\-\s])(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/[^\w]/g, '');

function lineColToPos(sf: SourceFile, line: number, column: number): number {
  return sf.compilerNode.getPositionOfLineAndCharacter(line - 1, column);
}

function relativeImport(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  rel = rel.replace(/\.(tsx?|jsx?|mts|mjs)$/, '');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function attributeAt(sf: SourceFile, line: number, column: number): JsxAttribute | Node | undefined {
  const node = sf.getDescendantAtPos(lineColToPos(sf, line, column));
  return node?.getFirstAncestor(n => Node.isJsxAttribute(n) || Node.isJsxSpreadAttribute(n)) ??
    (node && (Node.isJsxAttribute(node) || Node.isJsxSpreadAttribute(node)) ? node : undefined);
}

function ownerElement(attr: Node): JsxOpeningElement | JsxSelfClosingElement | undefined {
  const el = attr.getParent()?.getParent();
  return el && (Node.isJsxOpeningElement(el) || Node.isJsxSelfClosingElement(el)) ? el : undefined;
}

/**
 * Plan the "lift drilled state into a context" refactor for one drilling route.
 * The plan is computed on an in-memory copy; nothing is written to disk.
 */
export function planLiftToContext(
  sourceProject: Project,
  graph: StateFlowGraph,
  drillingPathId: string,
  options: LiftToContextOptions = {}
): FixPlan {
  const query = new GraphQuery(graph);
  const target = graph.propDrillingPaths.find(p => p.id === drillingPathId);
  const fail = (reason: string, title = 'Lift drilled state into a context'): FixPlan => ({
    title,
    description: reason,
    applicable: false,
    reasons: [reason],
    notes: [],
    edits: [],
  });
  if (!target?.componentIds || !target.steps) return fail('Drilling path not found — re-run the analysis.');

  const state = graph.stateNodes.get(target.stateId);
  if (!state || !state.ownerId) return fail('The drilled value is not owned by a component.');

  // All threads of the same state along the same route (value + setter, …)
  const route = target.componentIds.join('>');
  const threadPaths = graph.propDrillingPaths.filter(p => p.stateId === target.stateId && p.componentIds?.join('>') === route);
  const ids = target.componentIds;
  const components = ids.map(id => graph.components.get(id)!);
  const [owner] = components;
  const consumer = components[components.length - 1]!;
  const intermediates = components.slice(1, -1);
  const reasons: string[] = [];
  const notes: string[] = [];

  const threads: Thread[] = [];
  for (const p of threadPaths) {
    const first = p.steps![0]!;
    const sf = sourceProject.getSourceFile(owner!.filePath);
    const attr = first.location && sf ? attributeAt(sf, first.location.line, first.location.column) : undefined;
    let binding: string | undefined;
    if (attr && Node.isJsxAttribute(attr)) {
      const init = attr.getInitializer();
      const expr = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
      if (expr && Node.isIdentifier(expr)) binding = expr.getText();
    }
    if (!binding || !state.bindings?.includes(binding)) {
      reasons.push(`${owner!.name} passes "${first.propName}" as an expression, not a plain variable.`);
      continue;
    }
    threads.push({ path: p, ownerBinding: binding, propNames: p.steps!.map(s => s.propName) });
  }

  const contextBase = pascal(state.setterName && threads.every(t => t.ownerBinding === state.setterName)
    ? state.setterName.replace(/^set/, '')
    : (state.bindings?.[0] ?? state.name));
  const contextName = `${contextBase}Context`;
  const hookName = `use${contextBase}`;
  const title = `Lift "${threads.map(t => t.ownerBinding).join('", "') || state.name}" into ${contextName}`;

  // ---------- Safety checks ----------
  for (const c of components) {
    if (c.kind === 'class') reasons.push(`${c.name} is a class component (not supported by this fix).`);
  }
  for (const c of intermediates) {
    if (!target.passThroughIds?.includes(c.id) || threadPaths.some(p => !p.passThroughIds?.includes(c.id))) {
      reasons.push(`${c.name} also uses the value, so it can't simply stop receiving it.`);
    }
  }
  for (let i = 1; i < ids.length; i++) {
    const parents = query.parents(ids[i]!).map(r => r.from);
    const outside = parents.filter(pid => pid !== ids[i - 1]);
    if (outside.length) {
      const names = outside.map(pid => graph.components.get(pid)?.name ?? pid).join(', ');
      reasons.push(`${components[i]!.name} is also rendered by ${names}; those call sites would need the prop or the provider too.`);
    }
  }
  if (reasons.length) return { title, description: reasons[0]!, applicable: false, reasons, notes, edits: [] };

  // ---------- Scratch project (matches the owner file's quotes & indentation) ----------
  const ownerText = options.readFile?.(owner!.filePath) ?? sourceProject.getSourceFile(owner!.filePath)?.getFullText() ?? '';
  const scratch = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: detectStyle(ownerText),
  });
  const originals = new Map<string, string>();
  const load = (filePath: string): SourceFile => {
    const existing = scratch.getSourceFile(filePath);
    if (existing) return existing;
    const text = options.readFile?.(filePath) ?? sourceProject.getSourceFile(filePath)?.getFullText() ?? '';
    originals.set(filePath, text);
    return scratch.createSourceFile(filePath, text, { overwrite: true });
  };

  const isTs = /\.(tsx?|mts)$/.test(owner!.filePath);
  const ownerFile = load(owner!.filePath);
  const react19 = options.react19 ?? false;

  // New context file next to the owner
  const ext = isTs ? '.ts' : '.js';
  let contextFile = path.join(path.dirname(owner!.filePath), `${contextBase}Context${ext}`).split(path.sep).join('/');
  for (let n = 2; sourceProject.getSourceFile(contextFile) || scratch.getSourceFile(contextFile); n++) {
    contextFile = path.join(path.dirname(owner!.filePath), `${contextBase}Context${n}${ext}`).split(path.sep).join('/');
  }

  // ---------- Context value types ----------
  const typeImports = new Map<string, Set<string>>();   // specifier → names
  const typeFor = (thread: Thread): string => {
    if (!isTs) return '';
    const consumerProp = consumer.props.find(p => p.name === thread.propNames[thread.propNames.length - 1]);
    let typeText = consumerProp?.type;
    let typeSource = consumer.filePath;
    if (!typeText) {
      typeText = stateTypeFromDeclaration(ownerFile, state, thread.ownerBinding === state.setterName);
      typeSource = owner!.filePath;
    }
    if (!typeText) {
      notes.push(`Couldn't infer the type of "${thread.ownerBinding}" — the context uses \`any\`; tighten it in ${path.basename(contextFile)}.`);
      return 'any';
    }
    return collectTypeImports(load(typeSource), typeText, contextFile, typeImports, notes);
  };

  const multi = threads.length > 1;
  const valueType = isTs
    ? multi
      ? `{ ${threads.map(t => `${t.ownerBinding}: ${typeFor(t)}`).join('; ')} }`
      : typeFor(threads[0]!)
    : '';
  const memoName = `${contextBase.charAt(0).toLowerCase()}${contextBase.slice(1)}ContextValue`;
  const providerValue = multi ? memoName : threads[0]!.ownerBinding;
  const memoStatement = `const ${memoName} = useMemo(() => ({ ${threads.map(t => t.ownerBinding).join(', ')} }), [${threads.map(t => t.ownerBinding).join(', ')}]);`;

  // ---------- Context file ----------
  const importLines = [`import { createContext, useContext } from 'react';`];
  for (const [spec, names] of typeImports) importLines.push(`import type { ${[...names].join(', ')} } from '${spec}';`);
  const contextSource = isTs
    ? `${importLines.join('\n')}

const missing = Symbol('${contextName}');

export const ${contextName} = createContext<${valueType} | typeof missing>(missing);

export function ${hookName}(): ${valueType} {
  const value = useContext(${contextName});
  if (value === missing) {
    throw new Error('${hookName} must be used inside <${contextName}> (provided by ${owner!.name})');
  }
  return value;
}
`
    : `${importLines.join('\n')}

const missing = Symbol('${contextName}');

export const ${contextName} = createContext(missing);

export function ${hookName}() {
  const value = useContext(${contextName});
  if (value === missing) {
    throw new Error('${hookName} must be used inside <${contextName}> (provided by ${owner!.name})');
  }
  return value;
}
`;

  // ---------- Owner: remove first-hop props, wrap with provider ----------
  const ownerLoc = locateComponent(ownerFile, owner!.name, owner!.line);
  if (!ownerLoc || ownerLoc.fn instanceof ClassDeclaration) return fail(`Couldn't locate ${owner!.name} in its file.`, title);
  const firstHop = threads[0]!.path.steps![0]!;
  const firstAttr = attributeAt(ownerFile, firstHop.location!.line, firstHop.location!.column);
  const firstElement = firstAttr ? ownerElement(firstAttr) : undefined;
  if (!firstElement) return fail(`Couldn't find where ${owner!.name} renders ${components[1]!.name}.`, title);
  const firstTag = firstElement.getTagNameNode().getText();

  const sites = jsxSites(ownerLoc.fn, firstTag);
  for (const el of sites) {
    for (const t of threads) removeAttribute(el, t.propNames[0]!);
  }
  for (const el of jsxSites(ownerLoc.fn, firstTag).reverse()) {
    const target = Node.isJsxSelfClosingElement(el) ? el : el.getParentOrThrow();
    const open = react19 ? `<${contextName} value={${providerValue}}>` : `<${contextName}.Provider value={${providerValue}}>`;
    const close = react19 ? `</${contextName}>` : `</${contextName}.Provider>`;
    target.replaceWithText(`${open}${target.getText()}${close}`);
  }
  if (multi) insertAfterLine(ownerLoc.fn, state.line, memoStatement);
  addNamedImport(ownerFile, relativeImport(owner!.filePath, contextFile), contextName);
  if (multi) addNamedImport(ownerFile, 'react', 'useMemo');

  // ---------- Intermediates: stop receiving & forwarding ----------
  for (let i = 1; i < components.length - 1; i++) {
    const c = components[i]!;
    const sf = load(c.filePath);
    const loc = locateComponent(sf, c.name, c.line);
    if (!loc || loc.fn instanceof ClassDeclaration) return fail(`Couldn't locate ${c.name} in its file.`, title);
    const nextTag = (() => {
      const step = threads[0]!.path.steps![i]!;
      const attr = step.location ? attributeAt(sf, step.location.line, step.location.column) : undefined;
      return attr ? ownerElement(attr)?.getTagNameNode().getText() : undefined;
    })();
    for (const t of threads) {
      const received = t.propNames[i - 1]!;
      const forwarded = t.propNames[i]!;
      if (nextTag) for (const el of jsxSites(loc.fn, nextTag)) removeAttribute(el, forwarded);
      removePropFromSignature(loc.fn, received, c, load, notes, sourceProject);
    }
  }

  // ---------- Consumer: read from the context ----------
  {
    const sf = load(consumer.filePath);
    const loc = locateComponent(sf, consumer.name, consumer.line);
    if (!loc || loc.fn instanceof ClassDeclaration) return fail(`Couldn't locate ${consumer.name} in its file.`, title);
    const fn = loc.fn;
    const locals: Array<{ local: string; key: string }> = [];
    for (const t of threads) {
      const received = t.propNames[t.propNames.length - 1]!;
      const local = removePropFromSignature(fn, received, consumer, load, notes, sourceProject) ?? received;
      locals.push({ local, key: t.ownerBinding });
    }
    const statement = multi
      ? `const { ${locals.map(l => (l.local === l.key ? l.key : `${l.key}: ${l.local}`)).join(', ')} } = ${hookName}();`
      : `const ${locals[0]!.local} = ${hookName}();`;
    insertAtBodyStart(fn, statement);
    addNamedImport(sf, relativeImport(consumer.filePath, contextFile), hookName);
  }

  // ---------- Collect edits ----------
  const edits: FileEdit[] = [{ filePath: contextFile, oldText: '', newText: contextSource, isNew: true }];
  for (const [filePath, oldText] of originals) {
    const newText = scratch.getSourceFileOrThrow(filePath).getFullText();
    if (newText !== oldText) edits.push({ filePath, oldText, newText });
  }

  const chain = components.map(c => c.name).join(' → ');
  return {
    title,
    description: `Creates ${path.basename(contextFile)}, provides it in ${owner!.name}, removes the prop from ${intermediates.map(c => c.name).join(', ') || 'the chain'} and reads it with ${hookName}() in ${consumer.name} (${chain}).`,
    applicable: true,
    reasons: [],
    notes,
    edits,
  };
}

// ============================================
// Helpers
// ============================================

function jsxSites(scope: Node, tag: string): Array<JsxOpeningElement | JsxSelfClosingElement> {
  return [
    ...scope.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...scope.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]
    .filter(el => el.getTagNameNode().getText() === tag)
    .sort((a, b) => a.getStart() - b.getStart());
}

function removeAttribute(el: JsxOpeningElement | JsxSelfClosingElement, name: string): void {
  for (const attr of el.getAttributes()) {
    if (Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name) {
      attr.remove();
      return;
    }
  }
}

function addNamedImport(sf: SourceFile, specifier: string, name: string): void {
  const existing = sf.getImportDeclarations().find(d => d.getModuleSpecifierValue() === specifier && !d.isTypeOnly());
  if (existing) {
    if (!existing.getNamedImports().some(n => n.getName() === name)) existing.addNamedImport(name);
    return;
  }
  const imports = sf.getImportDeclarations();
  const index = imports.length ? imports[imports.length - 1]!.getChildIndex() + 1 : directiveCount(sf);
  sf.insertImportDeclaration(index, { moduleSpecifier: specifier, namedImports: [name] });
}

function directiveCount(sf: SourceFile): number {
  let n = 0;
  for (const stmt of sf.getStatements()) {
    if (Node.isExpressionStatement(stmt) && Node.isStringLiteral(stmt.getExpression())) n++;
    else break;
  }
  return n;
}

function detectStyle(text: string): { quoteKind: QuoteKind; indentationText: IndentationText } {
  const single = (text.match(/from '/g) ?? []).length;
  const double = (text.match(/from "/g) ?? []).length;
  const indent = text.match(/\n( +|\t)\S/)?.[1] ?? '  ';
  const indentationText = indent === '\t'
    ? IndentationText.Tab
    : indent.length >= 4 ? IndentationText.FourSpaces : IndentationText.TwoSpaces;
  return { quoteKind: double > single ? QuoteKind.Double : QuoteKind.Single, indentationText };
}

/** Insert a statement right after the statement that contains `line` inside a function body */
function insertAfterLine(fn: Node, line: number, statement: string): void {
  if (!(Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) return;
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return;
  const statements = body.getStatements();
  const index = statements.findIndex(st => st.getStartLineNumber() <= line && st.getEndLineNumber() >= line);
  body.insertStatements(index >= 0 ? index + 1 : 0, statement);
}

function insertAtBodyStart(fn: Node, statement: string): void {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (!Node.isBlock(body)) {
      fn.setBodyText(`${statement}\nreturn ${body.getText()};`);
      return;
    }
  }
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn)) {
    fn.insertStatements(0, statement);
  }
}

/**
 * Remove a prop from a component's parameter destructuring and its declared type.
 * Returns the local binding name the component used for the prop.
 */
function removePropFromSignature(
  fn: Node,
  propName: string,
  component: ComponentNode,
  load: (filePath: string) => SourceFile,
  notes: string[],
  sourceProject: Project
): string | undefined {
  if (!(Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn))) return undefined;
  const param = fn.getParameters()[0];
  if (!param) return undefined;
  let local: string | undefined;

  // Declared type first (inline literal, local interface/type, or an imported interface used only here)
  const typeNode = param.getTypeNode() ?? externalPropsType(fn);
  const emptiedType = removeTypeMember(typeNode, propName, component, load, notes, sourceProject, fn.getSourceFile());

  const nameNode = param.getNameNode();
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      if (prop === propName && !el.getDotDotDotToken()) {
        local = el.getName();
        const remaining = nameNode.getElements().filter(e => e !== el).map(e => e.getText());
        if (remaining.length) {
          nameNode.replaceWithText(`{ ${remaining.join(', ')} }`);
        } else if (fn.getParameters().length === 1) {
          // Nothing left to destructure: the component no longer needs props at all
          param.remove();
          emptiedType?.remove();
          return local;
        } else {
          nameNode.replaceWithText('_props');
        }
        break;
      }
    }
  } else if (Node.isIdentifier(nameNode)) {
    const accessor = nameNode.getText();
    const accesses = fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter(a => a.getExpression().getText() === accessor && a.getName() === propName);
    if (accesses.length) {
      local = propName;
      // props.x is only forwarded in intermediates (attribute already removed); in the consumer rename usages
      for (const a of accesses.reverse()) {
        if (!a.wasForgotten()) a.replaceWithText(propName);
      }
    }
  }

  return local;
}

function externalPropsType(fn: Node): Node | undefined {
  // forwardRef<Ref, Props>(function …) / memo(…)
  const call = fn.getParent();
  if (call && Node.isCallExpression(call)) {
    const callee = call.getExpression().getText().split('.').pop();
    if (callee === 'forwardRef') return call.getTypeArguments()[1];
  }
  // const X: React.FC<Props> = (…) => …
  const decl = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const t = decl?.getTypeNode();
  if (t && Node.isTypeReference(t)) return t.getTypeArguments()[0];
  return undefined;
}

function removeTypeMember(
  typeNode: Node | undefined,
  propName: string,
  component: ComponentNode,
  load: (filePath: string) => SourceFile,
  notes: string[],
  sourceProject: Project,
  sf: SourceFile,
  depth = 0
): { remove(): void } | undefined {
  if (!typeNode || depth > 4) return undefined;
  if (Node.isTypeLiteral(typeNode)) {
    typeNode.getProperty(propName)?.remove();
    return undefined;
  }
  if (Node.isIntersectionTypeNode(typeNode)) {
    typeNode.getTypeNodes().forEach(t => removeTypeMember(t, propName, component, load, notes, sourceProject, sf, depth + 1));
    return undefined;
  }
  if (!Node.isTypeReference(typeNode)) return undefined;

  const name = typeNode.getTypeName().getText();
  const wrapper = name.split('.').pop()!;
  if (['FC', 'FunctionComponent', 'PropsWithChildren', 'Readonly'].includes(wrapper)) {
    removeTypeMember(typeNode.getTypeArguments()[0], propName, component, load, notes, sourceProject, sf, depth + 1);
    return undefined;
  }

  // Find the declaration: same file, or an imported file
  let declFile: SourceFile | undefined = sf;
  let declName = name;
  if (!sf.getInterface(name) && !sf.getTypeAlias(name)) {
    const imp = sf.getImportDeclarations().find(d => d.getNamedImports().some(n => (n.getAliasNode()?.getText() ?? n.getName()) === name));
    const spec = imp?.getNamedImports().find(n => (n.getAliasNode()?.getText() ?? n.getName()) === name);
    const target = imp ? findImportedFile(sourceProject, sf.getFilePath(), imp.getModuleSpecifierValue()) : undefined;
    if (!target || !spec) {
      notes.push(`Remove "${propName}" from ${name} manually (couldn't locate the type).`);
      return undefined;
    }
    declFile = load(target);
    declName = spec.getName();
  }

  // Only edit a named type when this component is its only user
  const uses = countTypeUses(sourceProject, declName);
  if (uses > 1) {
    const iface = declFile.getInterface(declName);
    const member = iface?.getProperty(propName);
    if (member && !member.hasQuestionToken()) {
      member.setHasQuestionToken(true);
      notes.push(`${declName} is shared, so "${propName}" was made optional instead of removed.`);
    }
    return undefined;
  }

  const iface = declFile.getInterface(declName);
  if (iface) {
    iface.getProperty(propName)?.remove();
    const unused = iface.getMembers().length === 0 && iface.getExtends().length === 0 && !iface.isExported();
    return unused ? iface : undefined;
  }
  const alias = declFile.getTypeAlias(declName);
  if (alias) {
    removeTypeMember(alias.getTypeNode(), propName, component, load, notes, sourceProject, declFile, depth + 1);
    const t = alias.getTypeNode();
    const unused = !!t && Node.isTypeLiteral(t) && t.getMembers().length === 0 && !alias.isExported();
    return unused ? alias : undefined;
  }
  return undefined;
}

function findImportedFile(project: Project, fromFile: string, specifier: string): string | undefined {
  const candidates = project.getSourceFiles().map(f => f.getFilePath());
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier).split(path.sep).join('/');
    return candidates.find(c => c.replace(/\.(tsx?|jsx?)$/, '') === base || c.replace(/\/index\.(tsx?|jsx?)$/, '') === base);
  }
  // Path alias: match by suffix (e.g. "@/types" → ".../src/types.ts")
  const tail = specifier.replace(/^[@~#$][^/]*\//, '');
  return candidates.find(c => c.replace(/\.(tsx?|jsx?)$/, '').endsWith('/' + tail));
}

function countTypeUses(project: Project, typeName: string): number {
  let count = 0;
  const re = new RegExp(`\\b${typeName}\\b`);
  for (const f of project.getSourceFiles()) {
    if (!re.test(f.getFullText())) continue;
    for (const ref of f.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      if (ref.getTypeName().getText() === typeName) count++;
    }
    for (const h of f.getDescendantsOfKind(SyntaxKind.ExpressionWithTypeArguments)) {
      if (h.getExpression().getText() === typeName) count++;
    }
  }
  return count;
}

function stateTypeFromDeclaration(sf: SourceFile, state: StateNode, isSetter: boolean): string | undefined {
  const pos = lineColToPos(sf, state.line, state.column);
  const call = sf.getDescendantAtPos(pos)?.getFirstAncestorByKind(SyntaxKind.CallExpression)
    ?? sf.getDescendantsOfKind(SyntaxKind.CallExpression).find(c => c.getStartLineNumber() === state.line);
  if (!call) return undefined;
  const typeArg = call.getTypeArguments()[0]?.getText();
  let valueType = typeArg;
  if (!valueType) {
    const init = call.getArguments()[0];
    if (init && Node.isNumericLiteral(init)) valueType = 'number';
    else if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) valueType = 'string';
    else if (init && (Node.isTrueLiteral(init) || Node.isFalseLiteral(init))) valueType = 'boolean';
  }
  if (!valueType) return undefined;
  if (isSetter && state.type === 'useState') return `Dispatch<SetStateAction<${valueType}>>`;
  return isSetter ? undefined : valueType;
}

function collectTypeImports(
  source: SourceFile,
  typeText: string,
  contextFile: string,
  out: Map<string, Set<string>>,
  notes: string[]
): string {
  const add = (spec: string, name: string) => {
    const set = out.get(spec) ?? new Set<string>();
    set.add(name);
    out.set(spec, set);
  };
  // React.Dispatch<…> → Dispatch<…> imported from react (works without esModuleInterop)
  const text = typeText.replace(/\bReact\.(\w+)/g, (_, name: string) => {
    add('react', name);
    return name;
  });
  for (const id of ['Dispatch', 'SetStateAction', 'ReactNode', 'ReactElement', 'MouseEvent', 'ChangeEvent', 'FormEvent', 'RefObject']) {
    if (new RegExp(`\\b${id}\\b`).test(text) && !source.getInterface(id) && !source.getTypeAlias(id)) add('react', id);
  }

  const identifiers = new Set(text.match(/\b[A-Z]\w*\b/g) ?? []);
  for (const id of identifiers) {
    if (out.get('react')?.has(id)) continue;
    if (['Array', 'Record', 'Promise', 'Partial', 'Readonly', 'Map', 'Set', 'Date', 'HTMLElement', 'Element'].includes(id)) continue;
    const imp = source.getImportDeclarations().find(d => d.getNamedImports().some(n => (n.getAliasNode()?.getText() ?? n.getName()) === id));
    if (imp) {
      let spec = imp.getModuleSpecifierValue();
      if (spec.startsWith('.')) spec = relativeImport(contextFile, path.resolve(path.dirname(source.getFilePath()), spec));
      add(spec, id);
      continue;
    }
    const local = source.getInterface(id) ?? source.getTypeAlias(id);
    if (local) {
      if (!local.isExported()) {
        notes.push(`Type ${id} isn't exported from ${path.basename(source.getFilePath())}; export it so the context file can import it.`);
      }
      add(relativeImport(contextFile, source.getFilePath()), id);
    }
  }
  return text;
}
