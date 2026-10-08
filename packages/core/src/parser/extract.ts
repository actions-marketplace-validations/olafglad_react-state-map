import {
  Node,
  SyntaxKind,
  SourceFile,
  CallExpression,
  TypeNode,
  ArrowFunction,
  FunctionExpression,
  FunctionDeclaration,
  ClassDeclaration,
  ObjectBindingPattern,
  JsxOpeningElement,
  JsxSelfClosingElement,
} from 'ts-morph';
import * as path from 'node:path';
import type { ComponentKind, PropUsage, PropRename } from '../types.js';
import type {
  FileFacts,
  ImportFact,
  ExportFact,
  ComponentFact,
  HookDefFact,
  HookCallFact,
  ContextDefFact,
  StoreDefFact,
  TypeDeclFact,
  TypeShape,
  TypeMember,
  JsxElementFact,
  JsxPropFact,
  PropFact,
  Position,
} from './facts.js';
import { isHookName, CLIENT_ONLY_REACT_HOOKS } from './hooks.js';

type FunctionLike = ArrowFunction | FunctionExpression | FunctionDeclaration;

const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef', 'observer']);
const PROPS_TYPE_WRAPPERS = new Set([
  'FC', 'FunctionComponent', 'VFC', 'VoidFunctionComponent', 'PropsWithChildren', 'PropsWithRef',
  'Readonly', 'Partial', 'Required', 'Omit', 'Pick', 'NamedExoticComponent', 'MemoExoticComponent',
  'ForwardRefExoticComponent', 'ComponentType', 'PropsWithoutRef', 'RefAttributes',
]);
const CLASS_BASES = new Set(['Component', 'PureComponent']);
const DEFAULT_LOCAL = '__default__';

export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

export function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || /^[a-z_$][\w$]*\.[A-Z]/.test(tag);
}

function pos(node: Node): Position {
  const sf = node.getSourceFile();
  const lc = sf.getLineAndColumnAtPos(node.getStart());
  return { line: lc.line, column: lc.column - 1 };
}

function endPos(node: Node): Position {
  const sf = node.getSourceFile();
  const lc = sf.getLineAndColumnAtPos(node.getEnd());
  return { line: lc.line, column: lc.column - 1 };
}

function lastSegment(text: string): string {
  const parts = text.split('.');
  return parts[parts.length - 1] ?? text;
}

function truncate(text: string, max = 160): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? single.slice(0, max - 1) + '…' : single;
}

function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function containsJsx(node: Node): boolean {
  return !!node.getFirstDescendant(
    n => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n) || Node.isJsxFragment(n)
  );
}

function containsHookCall(node: Node): boolean {
  return !!node.getFirstDescendant(n => {
    if (!Node.isCallExpression(n)) return false;
    const callee = n.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    return isHookName(name);
  });
}

function getDirective(sf: SourceFile): FileFacts['directive'] {
  for (const stmt of sf.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) break;
    const expr = stmt.getExpression();
    if (!Node.isStringLiteral(expr)) break;
    const value = expr.getLiteralValue();
    if (value === 'use client' || value === 'use server') return value;
  }
  return undefined;
}

/** Derive a component name for anonymous default exports from the file path */
function nameFromFile(filePath: string): string {
  const ext = path.extname(filePath);
  let base = path.basename(filePath, ext);
  const dir = path.basename(path.dirname(filePath));
  const pascal = (s: string) =>
    s.replace(/[[\]()@.]/g, ' ')
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map(w => w[0]!.toUpperCase() + w.slice(1))
      .join('');
  if (base === 'index') return pascal(dir) || 'Index';
  // Next.js route files: app/dashboard/page.tsx → DashboardPage
  if (['page', 'layout', 'template', 'loading', 'error', 'not-found', 'default'].includes(base)) {
    return (pascal(dir) || '') + pascal(base);
  }
  return pascal(base) || 'Anonymous';
}

// ============================================
// Types (syntactic props type resolution)
// ============================================

function typeShapeOf(typeNode: TypeNode | undefined, depth = 0): TypeShape {
  const shape: TypeShape = { members: [], refs: [] };
  if (!typeNode || depth > 6) return shape;

  if (Node.isTypeLiteral(typeNode)) {
    for (const member of typeNode.getMembers()) {
      if (Node.isPropertySignature(member) || Node.isMethodSignature(member)) {
        const nameNode = member.getNameNode();
        const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
        const typeText = Node.isPropertySignature(member)
          ? member.getTypeNode()?.getText()
          : truncate(member.getText());
        shape.members.push({
          name,
          type: typeText ? truncate(typeText, 120) : undefined,
          optional: member.hasQuestionToken(),
          ...pos(member),
        });
      }
    }
    return shape;
  }

  if (Node.isParenthesizedTypeNode(typeNode)) {
    return typeShapeOf(typeNode.getTypeNode(), depth + 1);
  }

  if (Node.isIntersectionTypeNode(typeNode) || Node.isUnionTypeNode(typeNode)) {
    const isUnion = Node.isUnionTypeNode(typeNode);
    for (const part of typeNode.getTypeNodes()) {
      const inner = typeShapeOf(part, depth + 1);
      shape.members.push(...inner.members.map(m => (isUnion ? { ...m, optional: true } : m)));
      shape.refs.push(...inner.refs);
    }
    return shape;
  }

  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    const args = typeNode.getTypeArguments();
    if (PROPS_TYPE_WRAPPERS.has(lastSegment(name))) {
      return args[0] ? typeShapeOf(args[0], depth + 1) : shape;
    }
    if (/^[A-Z]/.test(lastSegment(name)) && !['Record', 'Array', 'Promise', 'ReactNode', 'ReactElement'].includes(lastSegment(name))) {
      shape.refs.push({ name });
    }
    return shape;
  }

  return shape;
}

function extractTypeDecls(sf: SourceFile): TypeDeclFact[] {
  const decls: TypeDeclFact[] = [];

  for (const iface of sf.getInterfaces()) {
    const members: TypeMember[] = [];
    for (const member of iface.getMembers()) {
      if (Node.isPropertySignature(member) || Node.isMethodSignature(member)) {
        const nameNode = member.getNameNode();
        const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();
        const typeText = Node.isPropertySignature(member) ? member.getTypeNode()?.getText() : truncate(member.getText());
        members.push({
          name,
          type: typeText ? truncate(typeText, 120) : undefined,
          optional: member.hasQuestionToken(),
          ...pos(member),
        });
      }
    }
    const refs = iface.getExtends().flatMap(ext => {
      const text = ext.getExpression().getText();
      const args = ext.getTypeArguments();
      if (PROPS_TYPE_WRAPPERS.has(lastSegment(text)) && args[0]) return typeShapeOf(args[0]).refs;
      return [{ name: text }];
    });
    decls.push({ name: iface.getName(), members, refs });
  }

  for (const alias of sf.getTypeAliases()) {
    const shape = typeShapeOf(alias.getTypeNode());
    decls.push({ name: alias.getName(), ...shape });
  }

  return decls;
}

// ============================================
// Imports / exports
// ============================================

function extractImports(sf: SourceFile): ImportFact[] {
  const imports: ImportFact[] = [];
  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const def = decl.getDefaultImport();
    if (def) imports.push({ local: def.getText(), imported: 'default', specifier });
    const ns = decl.getNamespaceImport();
    if (ns) imports.push({ local: ns.getText(), imported: '*', specifier });
    for (const named of decl.getNamedImports()) {
      imports.push({
        local: named.getAliasNode()?.getText() ?? named.getName(),
        imported: named.getName(),
        specifier,
      });
    }
  }
  return imports;
}

function extractExports(sf: SourceFile): { exports: ExportFact[]; starExports: string[] } {
  const exports: ExportFact[] = [];
  const starExports: string[] = [];

  for (const decl of sf.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const named = decl.getNamedExports();
    const nsExport = decl.getNamespaceExport();

    if (specifier && !named.length && !nsExport) {
      starExports.push(specifier);
      continue;
    }
    if (specifier && nsExport) {
      exports.push({ exported: nsExport.getName(), from: specifier, imported: '*' });
      continue;
    }
    for (const spec of named) {
      const name = spec.getName();
      const exported = spec.getAliasNode()?.getText() ?? name;
      if (specifier) {
        exports.push({ exported, from: specifier, imported: name });
      } else {
        exports.push({ exported, local: name });
      }
    }
  }

  for (const stmt of sf.getStatements()) {
    if (Node.isExportAssignment(stmt) && !stmt.isExportEquals()) {
      const expr = unwrapExpression(stmt.getExpression());
      if (Node.isIdentifier(expr)) {
        exports.push({ exported: 'default', local: expr.getText() });
      } else if (Node.isCallExpression(expr)) {
        // export default memo(Foo) / connect(...)(Foo)
        const ident = findWrappedIdentifier(expr);
        exports.push({ exported: 'default', local: ident ?? DEFAULT_LOCAL });
      } else {
        exports.push({ exported: 'default', local: DEFAULT_LOCAL });
      }
      continue;
    }

    if (!Node.isExportable(stmt) || !stmt.hasExportKeyword()) continue;

    if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) {
        const nameNode = d.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          exports.push({ exported: nameNode.getText(), local: nameNode.getText() });
        }
      }
      continue;
    }

    if (
      Node.isFunctionDeclaration(stmt) ||
      Node.isClassDeclaration(stmt) ||
      Node.isInterfaceDeclaration(stmt) ||
      Node.isTypeAliasDeclaration(stmt) ||
      Node.isEnumDeclaration(stmt)
    ) {
      const name = stmt.getName();
      const isDefault = Node.isFunctionDeclaration(stmt) || Node.isClassDeclaration(stmt)
        ? stmt.isDefaultExport()
        : false;
      if (isDefault) {
        exports.push({ exported: 'default', local: name ?? DEFAULT_LOCAL });
      } else if (name) {
        exports.push({ exported: name, local: name });
      }
    }
  }

  return { exports, starExports };
}

/** memo(Foo) → 'Foo', connect(a, b)(Foo) → 'Foo' */
function findWrappedIdentifier(call: CallExpression): string | null {
  for (const arg of call.getArguments()) {
    const inner = unwrapExpression(arg);
    if (Node.isIdentifier(inner) && isComponentName(inner.getText())) return inner.getText();
    if (Node.isCallExpression(inner)) {
      const found = findWrappedIdentifier(inner);
      if (found) return found;
    }
  }
  return null;
}

// ============================================
// Hooks
// ============================================

function bindingInfo(call: CallExpression): {
  bindings: string[];
  displayName: string | null;
  setterName?: string;
} {
  let current: Node | undefined = call.getParent();
  while (
    current &&
    (Node.isNonNullExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isAwaitExpression(current) ||
      Node.isSatisfiesExpression(current))
  ) {
    current = current.getParent();
  }

  if (!current || !Node.isVariableDeclaration(current)) {
    return { bindings: [], displayName: null };
  }

  const nameNode = current.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    return { bindings: [nameNode.getText()], displayName: nameNode.getText() };
  }
  if (Node.isArrayBindingPattern(nameNode)) {
    const names: (string | null)[] = nameNode.getElements().map(el =>
      Node.isBindingElement(el) ? el.getName() : null
    );
    const bindings = names.filter((n): n is string => !!n);
    return {
      bindings,
      displayName: names[0] ?? bindings[0] ?? null,
      setterName: names.length >= 2 && names[1] ? names[1] : undefined,
    };
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    const bindings = objectBindingNames(nameNode);
    return { bindings, displayName: bindings.length ? bindings.join(', ') : null };
  }
  return { bindings: [], displayName: null };
}

function objectBindingNames(pattern: ObjectBindingPattern): string[] {
  const names: string[] = [];
  for (const el of pattern.getElements()) {
    const nameNode = el.getNameNode();
    if (Node.isIdentifier(nameNode)) names.push(nameNode.getText());
    else if (Node.isObjectBindingPattern(nameNode)) names.push(...objectBindingNames(nameNode));
  }
  return names;
}

function collectHookCalls(scope: Node): HookCallFact[] {
  const calls: HookCallFact[] = [];
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    let name: string;
    let root: string;
    if (Node.isIdentifier(callee)) {
      name = callee.getText();
      root = name;
    } else if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression())) {
      name = callee.getName();
      root = callee.getExpression().getText();
    } else {
      continue;
    }
    if (!isHookName(name)) continue;

    const args = call.getArguments();
    const first = args[0] ? unwrapExpression(args[0]) : undefined;
    const info = bindingInfo(call);

    calls.push({
      callee: name,
      calleeRoot: root,
      ...info,
      firstArgText: first ? truncate(first.getText()) : undefined,
      firstArgIdent: first && Node.isIdentifier(first) ? first.getText() : undefined,
      ...pos(call),
    });
  }
  return calls;
}

function usesClientOnly(calls: HookCallFact[]): boolean {
  return calls.some(c => CLIENT_ONLY_REACT_HOOKS.has(c.callee));
}

// ============================================
// JSX
// ============================================

function memberChain(node: Node): { root?: string; path: string[] } {
  const pathParts: string[] = [];
  let current = unwrapExpression(node);
  while (Node.isPropertyAccessExpression(current)) {
    pathParts.unshift(current.getName());
    current = unwrapExpression(current.getExpression());
  }
  if (Node.isIdentifier(current)) return { root: current.getText(), path: pathParts };
  if (current.getKind() === SyntaxKind.ThisKeyword) return { root: 'this', path: pathParts };
  return { path: pathParts };
}

function jsxPropFact(attr: Node): JsxPropFact | null {
  const start = pos(attr);
  const end = endPos(attr);
  const base = { ...start, endLine: end.line, endColumn: end.column };

  if (Node.isJsxSpreadAttribute(attr)) {
    const expr = attr.getExpression();
    const chain = memberChain(expr);
    return {
      name: '...spread',
      valueText: truncate(expr.getText()),
      kind: 'spread',
      root: chain.root,
      path: chain.path,
      ...base,
    };
  }

  if (!Node.isJsxAttribute(attr)) return null;
  const name = attr.getNameNode().getText();
  const init = attr.getInitializer();

  if (!init) return { name, valueText: 'true', kind: 'boolean', ...base };
  if (Node.isStringLiteral(init)) return { name, valueText: init.getText(), kind: 'literal', ...base };
  if (!Node.isJsxExpression(init)) return { name, valueText: truncate(init.getText()), kind: 'jsx', ...base };

  const rawExpr = init.getExpression();
  if (!rawExpr) return { name, valueText: '', kind: 'other', ...base };
  const expr = unwrapExpression(rawExpr);
  const valueText = truncate(rawExpr.getText());

  if (Node.isIdentifier(expr)) {
    return { name, valueText, kind: 'identifier', root: expr.getText(), path: [], ...base };
  }
  if (Node.isPropertyAccessExpression(expr)) {
    const chain = memberChain(expr);
    return { name, valueText, kind: 'member', root: chain.root, path: chain.path, ...base };
  }
  if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
    const body = expr.getBody();
    const usesServer = Node.isBlock(body) && body.getStatements().some(s =>
      Node.isExpressionStatement(s) && Node.isStringLiteral(s.getExpression()) &&
      (s.getExpression() as any).getLiteralValue() === 'use server'
    );
    return { name, valueText, kind: 'function', functionUsesServerDirective: usesServer, ...base };
  }
  if (Node.isObjectLiteralExpression(expr)) {
    const objectProperties: string[] = [];
    for (const p of expr.getProperties()) {
      if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) || Node.isMethodDeclaration(p)) {
        objectProperties.push(p.getName());
      } else if (Node.isSpreadAssignment(p)) {
        objectProperties.push('...spread');
      }
    }
    return { name, valueText, kind: 'object', objectProperties, ...base };
  }
  if (
    Node.isNumericLiteral(expr) ||
    Node.isStringLiteral(expr) ||
    Node.isNoSubstitutionTemplateLiteral(expr) ||
    Node.isTrueLiteral(expr) ||
    Node.isFalseLiteral(expr) ||
    Node.isNullLiteral(expr)
  ) {
    return { name, valueText, kind: 'literal', ...base };
  }
  if (Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr) || Node.isJsxFragment(expr)) {
    return { name, valueText, kind: 'jsx', ...base };
  }
  return { name, valueText, kind: 'other', ...base };
}

function collectJsx(scope: Node): JsxElementFact[] {
  const elements: JsxElementFact[] = [];
  const nodes: (JsxOpeningElement | JsxSelfClosingElement)[] = [
    ...scope.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...scope.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  nodes.sort((a, b) => a.getStart() - b.getStart());

  for (const el of nodes) {
    const tag = el.getTagNameNode().getText();
    if (!isComponentTag(tag)) continue;
    const props: JsxPropFact[] = [];
    for (const attr of el.getAttributes()) {
      const fact = jsxPropFact(attr);
      if (fact) props.push(fact);
    }
    elements.push({ tag, props, ...pos(el) });
  }
  return elements;
}

// ============================================
// Props
// ============================================

function propsFromBindingPattern(pattern: ObjectBindingPattern, destructured: boolean): {
  props: PropFact[];
  restName?: string;
} {
  const props: PropFact[] = [];
  let restName: string | undefined;
  for (const el of pattern.getElements()) {
    if (el.getDotDotDotToken()) {
      restName = el.getName();
      continue;
    }
    const nameNode = el.getNameNode();
    const propName = el.getPropertyNameNode()?.getText() ?? (Node.isIdentifier(nameNode) ? nameNode.getText() : null);
    if (!propName) continue;
    props.push({
      name: propName.replace(/^['"]|['"]$/g, ''),
      localName: Node.isIdentifier(nameNode) ? nameNode.getText() : propName,
      optional: !!el.getInitializer(),
      destructured,
      ...pos(el),
    });
  }
  return { props, restName };
}

interface PropsInfo {
  props: PropFact[];
  propsTypes: TypeShape;
  propsParam?: string;
  restName?: string;
}

function analyzeFunctionProps(fn: FunctionLike, externalTypeNode?: TypeNode): PropsInfo {
  const info: PropsInfo = { props: [], propsTypes: { members: [], refs: [] } };
  const param = fn.getParameters()[0];

  const typeNode = param?.getTypeNode() ?? externalTypeNode;
  info.propsTypes = typeShapeOf(typeNode);

  if (param) {
    const nameNode = param.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      const r = propsFromBindingPattern(nameNode, true);
      info.props.push(...r.props);
      info.restName = r.restName;
    } else if (Node.isIdentifier(nameNode)) {
      info.propsParam = nameNode.getText();
      collectAccessorProps(fn, info.propsParam, info);
    }
  }

  // Attach declared types to destructured props
  for (const p of info.props) {
    const member = info.propsTypes.members.find(m => m.name === p.name);
    if (member) {
      p.type = member.type;
      p.optional = p.optional || member.optional;
    }
  }

  return info;
}

/** props.x accesses and `const { a, b } = props` in the body */
function collectAccessorProps(scope: Node, accessor: string, info: PropsInfo): void {
  const seen = new Set(info.props.map(p => p.name));

  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    const nameNode = decl.getNameNode();
    if (!init || !Node.isObjectBindingPattern(nameNode)) continue;
    if (unwrapExpression(init).getText() !== accessor) continue;
    const r = propsFromBindingPattern(nameNode, false);
    for (const p of r.props) {
      if (!seen.has(p.name)) {
        info.props.push(p);
        seen.add(p.name);
      }
    }
    if (r.restName) info.restName = r.restName;
  }

  for (const access of scope.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getExpression().getText() !== accessor) continue;
    const name = access.getName();
    if (seen.has(name)) continue;
    seen.add(name);
    info.props.push({ name, localName: name, destructured: false, ...pos(access.getNameNode()) });
  }
}

// ============================================
// Prop usage analysis
// ============================================

type UsageKind = 'passed' | 'render' | 'effect' | 'callback' | 'logic' | 'transform';

function enclosingJsxTag(attr: Node): string | null {
  const owner = attr.getParent()?.getParent();
  if (owner && (Node.isJsxOpeningElement(owner) || Node.isJsxSelfClosingElement(owner))) {
    return owner.getTagNameNode().getText();
  }
  return null;
}

function classifyOccurrence(occ: Node, stopAt: Node): UsageKind {
  // Direct value of a JSX attribute: <Child user={user} /> or <Child user={props.user} />
  let direct: Node = occ;
  let parent = direct.getParent();
  while (
    parent &&
    (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent) || Node.isAsExpression(parent))
  ) {
    direct = parent;
    parent = direct.getParent();
  }
  if (parent && Node.isJsxExpression(parent)) {
    const attr = parent.getParent();
    if (attr && Node.isJsxAttribute(attr)) {
      const tag = enclosingJsxTag(attr);
      return tag && isComponentTag(tag) ? 'passed' : 'render';
    }
    return 'render';
  }
  if (parent && Node.isJsxSpreadAttribute(parent)) {
    const tag = enclosingJsxTag(parent);
    return tag && isComponentTag(tag) ? 'passed' : 'render';
  }

  let current: Node | undefined = occ.getParent();
  while (current && current !== stopAt) {
    if (Node.isJsxAttribute(current) || Node.isJsxExpression(current) || Node.isJsxSpreadAttribute(current)) {
      return 'render';
    }
    if (Node.isCallExpression(current)) {
      const callee = lastSegment(current.getExpression().getText());
      if (callee === 'useEffect' || callee === 'useLayoutEffect' || callee === 'useInsertionEffect') return 'effect';
      if (callee === 'useCallback' || callee === 'useMemo') return 'callback';
    }
    if (Node.isVariableDeclaration(current)) return 'transform';
    if (
      Node.isIfStatement(current) ||
      Node.isConditionalExpression(current) ||
      Node.isBinaryExpression(current) ||
      Node.isPrefixUnaryExpression(current) ||
      Node.isSwitchStatement(current)
    ) {
      return 'logic';
    }
    if (Node.isReturnStatement(current)) return 'render';
    current = current.getParent();
  }
  return 'logic';
}

function isReferenceOccurrence(id: Node): boolean {
  const parent = id.getParent();
  if (!parent) return false;
  if (Node.isBindingElement(parent)) {
    // { user } — the name is a declaration; { user: u } — the property name too
    return false;
  }
  if (Node.isParameterDeclaration(parent)) return false;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false;
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return false;
  if (Node.isJsxAttribute(parent)) return false;
  if (Node.isPropertySignature(parent) || Node.isMethodSignature(parent) || Node.isMethodDeclaration(parent)) return false;
  if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === id) return false;
  if (Node.isVariableDeclaration(parent) && parent.getNameNode() === id) return false;
  if (Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent)) return false;
  if (Node.isTypeReference(parent) || Node.isQualifiedName(parent)) return false;
  if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) return false;
  if (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent)) return false;
  return true;
}

function analyzeUsages(scope: Node, props: PropFact[], accessor?: string): PropUsage[] {
  const usages = new Map<string, PropUsage>();
  for (const p of props) {
    usages.set(p.name, {
      propName: p.name,
      usedInRender: false,
      passedToChild: false,
      usedInCallback: false,
      usedInEffect: false,
      usedInLogic: false,
      transformed: false,
    });
  }

  const apply = (propName: string, kind: UsageKind) => {
    const u = usages.get(propName);
    if (!u) return;
    switch (kind) {
      case 'passed': u.passedToChild = true; break;
      case 'render': u.usedInRender = true; break;
      case 'effect': u.usedInEffect = true; break;
      case 'callback': u.usedInCallback = true; break;
      case 'logic': u.usedInLogic = true; break;
      case 'transform': u.transformed = true; break;
    }
  };

  const byLocal = new Map<string, string>();
  for (const p of props) byLocal.set(p.localName, p.name);

  for (const id of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const propName = byLocal.get(id.getText());
    if (!propName || !isReferenceOccurrence(id)) continue;
    apply(propName, classifyOccurrence(id, scope));
  }

  if (accessor) {
    for (const access of scope.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getExpression().getText() !== accessor) continue;
      // `const { a } = props` is handled through the destructured identifiers
      apply(access.getName(), classifyOccurrence(access, scope));
    }
  }

  return [...usages.values()];
}

// ============================================
// Aliases / renames (scope map)
// ============================================

function collectAliases(
  scope: Node,
  props: PropFact[],
  accessor: string | undefined,
  componentName: string,
  filePath: string
): { aliasToProp: Record<string, string>; renames: Omit<PropRename, 'componentId'>[] } {
  const aliasToProp: Record<string, string> = {};
  const renames: Omit<PropRename, 'componentId'>[] = [];
  const localToProp = new Map<string, string>();

  for (const p of props) {
    localToProp.set(p.localName, p.name);
    if (p.localName !== p.name) {
      renames.push({
        fromName: p.name,
        toName: p.localName,
        componentName,
        renameType: 'destructure',
        line: p.line,
        filePath,
      });
    }
  }

  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    const value = unwrapExpression(init);
    const nameNode = decl.getNameNode();
    const line = decl.getStartLineNumber();

    if (Node.isIdentifier(nameNode)) {
      const local = nameNode.getText();
      if (Node.isPropertyAccessExpression(value) && accessor && value.getExpression().getText() === accessor) {
        const prop = value.getName();
        aliasToProp[local] = prop;
        localToProp.set(local, prop);
        if (local !== prop) {
          renames.push({ fromName: prop, toName: local, componentName, renameType: 'accessor', line, filePath });
        }
      } else if (Node.isIdentifier(value)) {
        const source = localToProp.get(value.getText());
        if (source) {
          aliasToProp[local] = source;
          localToProp.set(local, source);
          renames.push({ fromName: value.getText(), toName: local, componentName, renameType: 'assignment', line, filePath });
        }
      }
    } else if (Node.isObjectBindingPattern(nameNode) && Node.isIdentifier(value)) {
      // const { id, name: title } = deal  (fields of a prop)
      const source = localToProp.get(value.getText());
      if (!source || value.getText() === accessor) continue;
      for (const el of nameNode.getElements()) {
        const local = el.getName();
        aliasToProp[local] = source;
        const original = el.getPropertyNameNode()?.getText();
        if (original && original !== local) {
          renames.push({ fromName: original, toName: local, componentName, renameType: 'destructure', line: el.getStartLineNumber(), filePath });
        }
      }
    }
  }

  return { aliasToProp, renames };
}

// ============================================
// Components
// ============================================

interface ComponentCandidate {
  node: FunctionLike | ClassDeclaration;
  name: string;
  localName: string;
  kind: ComponentKind;
  isExported: boolean;
  outerNode: Node;                 // Node spanning the full declaration
  externalPropsType?: TypeNode;    // From FC<Props> annotations or forwardRef<Ref, Props>
}

interface UnwrappedInit {
  fn?: FunctionLike;
  kind: ComponentKind;
  aliasOf?: string;
  propsType?: TypeNode;
}

function unwrapComponentInit(expr: Node, depth = 0): UnwrappedInit | null {
  if (depth > 4) return null;
  const node = unwrapExpression(expr);
  if (Node.isArrowFunction(node)) return { fn: node, kind: 'arrow' };
  if (Node.isFunctionExpression(node)) return { fn: node, kind: 'function' };
  if (Node.isCallExpression(node)) {
    const wrapper = lastSegment(node.getExpression().getText());
    if (!COMPONENT_WRAPPERS.has(wrapper)) return null;
    const arg = node.getArguments()[0];
    if (!arg) return null;
    const argNode = unwrapExpression(arg);
    const kind: ComponentKind = wrapper === 'forwardRef' ? 'forwardRef' : wrapper === 'memo' ? 'memo' : 'function';
    const typeArgs = node.getTypeArguments();
    const ownPropsType = wrapper === 'forwardRef' ? typeArgs[1] : undefined;
    if (Node.isIdentifier(argNode)) return { kind, aliasOf: argNode.getText() };
    const inner = unwrapComponentInit(argNode, depth + 1);
    if (!inner) return null;
    return {
      fn: inner.fn,
      aliasOf: inner.aliasOf,
      kind: kind === 'function' ? inner.kind : kind,
      propsType: ownPropsType ?? inner.propsType,
    };
  }
  return null;
}

function isClassComponent(cls: ClassDeclaration): boolean {
  const base = cls.getExtends();
  if (!base) return false;
  return CLASS_BASES.has(lastSegment(base.getExpression().getText()));
}

function findComponentCandidates(sf: SourceFile, exportedLocals: Set<string>, aliases: Record<string, string>): ComponentCandidate[] {
  const candidates: ComponentCandidate[] = [];
  const filePath = sf.getFilePath();

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    const isDefault = fn.isDefaultExport();
    if (!name && !isDefault) continue;
    if (name && !isComponentName(name)) continue;
    if (!containsJsx(fn) && !containsHookCall(fn)) continue;
    const resolvedName = name ?? nameFromFile(filePath);
    candidates.push({
      node: fn,
      name: resolvedName,
      localName: name ?? DEFAULT_LOCAL,
      kind: 'function',
      isExported: fn.isExported() || (!!name && exportedLocals.has(name)),
      outerNode: fn,
    });
  }

  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const nameNode = decl.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;
      const name = nameNode.getText();
      const init = decl.getInitializer();
      if (!init || !isComponentName(name)) continue;

      const unwrapped = unwrapComponentInit(init);
      if (!unwrapped) continue;
      if (unwrapped.aliasOf && !unwrapped.fn) {
        aliases[name] = unwrapped.aliasOf;
        continue;
      }
      const fn = unwrapped.fn;
      if (!fn) continue;
      if (!containsJsx(fn) && !containsHookCall(fn) && unwrapped.kind !== 'memo' && unwrapped.kind !== 'forwardRef') continue;

      // const Foo: React.FC<Props> = (...) => ...
      let externalPropsType = unwrapped.propsType;
      const declType = decl.getTypeNode();
      if (!externalPropsType && declType && Node.isTypeReference(declType)) {
        externalPropsType = declType.getTypeArguments()[0];
      }

      candidates.push({
        node: fn,
        name,
        localName: name,
        kind: unwrapped.kind,
        isExported: stmt.isExported() || exportedLocals.has(name),
        outerNode: stmt,
        externalPropsType,
      });
    }
  }

  for (const cls of sf.getClasses()) {
    if (!isClassComponent(cls)) continue;
    const name = cls.getName() ?? nameFromFile(filePath);
    candidates.push({
      node: cls,
      name,
      localName: cls.getName() ?? DEFAULT_LOCAL,
      kind: 'class',
      isExported: cls.isExported() || exportedLocals.has(name),
      outerNode: cls,
    });
  }

  // export default memo(function Foo() {}) / export default () => <div />
  for (const stmt of sf.getStatements()) {
    if (!Node.isExportAssignment(stmt) || stmt.isExportEquals()) continue;
    const unwrapped = unwrapComponentInit(stmt.getExpression());
    if (!unwrapped?.fn) continue;
    if (!containsJsx(unwrapped.fn) && !containsHookCall(unwrapped.fn)) continue;
    const innerName = Node.isFunctionExpression(unwrapped.fn) ? unwrapped.fn.getName() : undefined;
    candidates.push({
      node: unwrapped.fn,
      name: innerName && isComponentName(innerName) ? innerName : nameFromFile(filePath),
      localName: DEFAULT_LOCAL,
      kind: unwrapped.kind,
      isExported: true,
      outerNode: stmt,
      externalPropsType: unwrapped.propsType,
    });
  }

  return candidates;
}

function buildComponentFact(c: ComponentCandidate, filePath: string): ComponentFact {
  let propsInfo: PropsInfo;
  let accessor: string | undefined;
  let classState: ComponentFact['classState'];

  if (Node.isClassDeclaration(c.node)) {
    const cls = c.node;
    const typeArgs = cls.getExtends()?.getTypeArguments() ?? [];
    propsInfo = { props: [], propsTypes: typeShapeOf(typeArgs[0]) };
    accessor = 'this.props';
    collectAccessorProps(cls, accessor, propsInfo);

    const stateKeys = new Set<string>(typeShapeOf(typeArgs[1]).members.map(m => m.name));
    let statePos: Position | undefined;
    const stateProp = cls.getProperty('state');
    const stateInit = stateProp?.getInitializer();
    if (stateProp && stateInit && Node.isObjectLiteralExpression(stateInit)) {
      stateInit.getProperties().forEach(p => {
        if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) stateKeys.add(p.getName());
      });
      statePos = pos(stateProp);
    }
    for (const assign of cls.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (assign.getLeft().getText() !== 'this.state') continue;
      const right = assign.getRight();
      if (Node.isObjectLiteralExpression(right)) {
        right.getProperties().forEach(p => {
          if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) stateKeys.add(p.getName());
        });
      }
      statePos = statePos ?? pos(assign);
    }
    if (statePos || stateKeys.size) {
      classState = { ...(statePos ?? pos(cls)), keys: [...stateKeys] };
    }
  } else {
    propsInfo = analyzeFunctionProps(c.node, c.externalPropsType);
    accessor = propsInfo.propsParam;
  }

  // Attach declared types to props discovered via accessor
  for (const p of propsInfo.props) {
    if (p.type) continue;
    const member = propsInfo.propsTypes.members.find(m => m.name === p.name);
    if (member) {
      p.type = member.type;
      p.optional = p.optional || member.optional;
    }
  }

  const hookCalls = collectHookCalls(c.node);
  const { aliasToProp, renames } = collectAliases(c.node, propsInfo.props, accessor, c.name, filePath);
  const end = endPos(c.outerNode);

  return {
    name: c.name,
    localName: c.localName,
    kind: c.kind,
    ...pos(c.outerNode),
    endLine: end.line,
    isExported: c.isExported,
    props: propsInfo.props,
    propsTypes: propsInfo.propsTypes,
    propsParam: Node.isClassDeclaration(c.node) ? 'this.props' : propsInfo.propsParam,
    restName: propsInfo.restName,
    hookCalls,
    classState,
    jsx: collectJsx(c.node),
    propUsages: analyzeUsages(c.node, propsInfo.props, accessor),
    renames,
    aliasToProp,
    usesClientOnlyHooks: usesClientOnly(hookCalls),
  };
}

// ============================================
// Hook / context / store definitions
// ============================================

function extractHookDefs(sf: SourceFile): HookDefFact[] {
  const hooks: HookDefFact[] = [];
  const add = (name: string, fn: Node, at: Node) => {
    const calls = collectHookCalls(fn);
    hooks.push({ name, calls, usesClientOnlyHooks: usesClientOnly(calls), ...pos(at) });
  };

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && isHookName(name)) add(name, fn, fn);
  }
  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const name = decl.getName();
      const init = decl.getInitializer();
      if (!init || !isHookName(name)) continue;
      const value = unwrapExpression(init);
      if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) add(name, value, decl);
    }
  }
  return hooks;
}

const STORE_FACTORIES: Record<string, Pick<StoreDefFact, 'library' | 'kind'>> = {
  create: { library: 'zustand', kind: 'store' },
  createStore: { library: 'zustand', kind: 'store' },
  createWithEqualityFn: { library: 'zustand', kind: 'store' },
  atom: { library: 'jotai', kind: 'atom' },
  atomWithStorage: { library: 'jotai', kind: 'atom' },
  atomWithReset: { library: 'jotai', kind: 'atom' },
  atomFamily: { library: 'jotai', kind: 'atom' },
  selector: { library: 'recoil', kind: 'atom' },
  proxy: { library: 'valtio', kind: 'proxy' },
  createSlice: { library: 'redux', kind: 'slice' },
};

function rootCallee(call: CallExpression): string {
  // create<T>()(...) → create
  let callee: Node = call.getExpression();
  while (Node.isCallExpression(callee)) callee = callee.getExpression();
  return lastSegment(callee.getText());
}

function extractContextsAndStores(sf: SourceFile): { contexts: ContextDefFact[]; stores: StoreDefFact[] } {
  const contexts: ContextDefFact[] = [];
  const stores: StoreDefFact[] = [];

  for (const stmt of sf.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const nameNode = decl.getNameNode();
      const init = decl.getInitializer();
      if (!init || !Node.isIdentifier(nameNode)) continue;
      const value = unwrapExpression(init);
      if (!Node.isCallExpression(value)) continue;

      const callee = rootCallee(value);
      const name = nameNode.getText();

      if (callee === 'createContext') {
        contexts.push({
          name,
          typeText: value.getTypeArguments()[0]?.getText(),
          defaultText: value.getArguments()[0] ? truncate(value.getArguments()[0]!.getText(), 80) : undefined,
          ...pos(decl),
        });
        continue;
      }

      const store = STORE_FACTORIES[callee];
      if (store) {
        // Only treat `create(...)` as zustand when the result looks like a hook or store
        if (callee === 'create' && !/^use|Store$/i.test(name)) continue;
        if (callee === 'atom' && !/atom$/i.test(name) && !/^[a-z]/.test(name)) continue;
        stores.push({ name, ...store, ...pos(decl) });
        continue;
      }

      // const recoilAtom = atom({ key: ... }) handled above; Recoil `atom` shares the name with Jotai
    }
  }

  return { contexts, stores };
}

// ============================================
// Entry
// ============================================

/** Locate a component's function/class node in a source file (used by code fixes) */
export function locateComponent(
  sf: SourceFile,
  name: string,
  line: number
): { fn: FunctionLike | ClassDeclaration; outer: Node } | undefined {
  const candidates = findComponentCandidates(sf, new Set(), {});
  const match =
    candidates.find(c => c.name === name && c.outerNode.getStartLineNumber() === line) ??
    candidates.find(c => c.name === name);
  return match ? { fn: match.node, outer: match.outerNode } : undefined;
}

export function extractFileFacts(sf: SourceFile): FileFacts {
  const filePath = sf.getFilePath();
  const imports = extractImports(sf);
  const { exports, starExports } = extractExports(sf);
  const exportedLocals = new Set(exports.filter(e => e.local).map(e => e.local!));
  const aliases: Record<string, string> = {};

  const candidates = findComponentCandidates(sf, exportedLocals, aliases);
  const components = candidates.map(c => buildComponentFact(c, filePath));
  const { contexts, stores } = extractContextsAndStores(sf);

  return {
    filePath,
    directive: getDirective(sf),
    imports,
    exports,
    starExports,
    components,
    hooks: extractHookDefs(sf),
    contexts,
    stores,
    types: extractTypeDecls(sf),
    aliases,
  };
}
