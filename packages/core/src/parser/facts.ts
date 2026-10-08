import type { ComponentKind, PropUsage, PropRename } from '../types.js';

/**
 * Per-file facts. Plain data (no AST references) so they can be cached per file and
 * re-linked into a project graph cheaply whenever a single file changes.
 * Lines are 1-based, columns are 0-based.
 */
export interface FileFacts {
  filePath: string;
  directive?: 'use client' | 'use server';
  imports: ImportFact[];
  exports: ExportFact[];
  starExports: string[];             // export * from '<specifier>'
  components: ComponentFact[];
  hooks: HookDefFact[];
  contexts: ContextDefFact[];
  stores: StoreDefFact[];
  types: TypeDeclFact[];
  aliases: Record<string, string>;   // const MemoFoo = memo(Foo) → { MemoFoo: 'Foo' }
}

export interface ImportFact {
  local: string;
  imported: string;                  // 'default' | '*' | exported name
  specifier: string;
}

export interface ExportFact {
  exported: string;                  // 'default' or the public name
  local?: string;                    // local binding in this file
  from?: string;                     // re-export source specifier
  imported?: string;                 // name imported from `from` ('default' | '*' | name)
}

export interface Position {
  line: number;
  column: number;
}

export interface TypeRef {
  name: string;                      // Possibly qualified (Types.Props)
}

export interface TypeMember extends Position {
  name: string;
  type?: string;
  optional?: boolean;
}

export interface TypeShape {
  members: TypeMember[];
  refs: TypeRef[];
}

export interface TypeDeclFact extends TypeShape {
  name: string;
}

export interface HookCallFact extends Position {
  callee: string;                    // Hook name without namespace (React.useState → useState)
  calleeRoot: string;                // Identifier used to resolve the hook (useState, or React for React.useState)
  bindings: string[];                // Local identifiers introduced by the call
  displayName: string | null;        // Name shown for the state node
  setterName?: string;
  firstArgText?: string;
  firstArgIdent?: string;            // Identifier passed as first argument (context, atom, store…)
}

export interface HookDefFact extends Position {
  name: string;
  calls: HookCallFact[];
  usesClientOnlyHooks: boolean;
}

export interface ContextDefFact extends Position {
  name: string;
  typeText?: string;
  defaultText?: string;
}

export interface StoreDefFact extends Position {
  name: string;
  library: string;                   // 'zustand' | 'jotai' | 'recoil' | 'valtio' | 'redux'
  kind: 'store' | 'atom' | 'slice' | 'proxy';
}

export type JsxPropKind =
  | 'identifier'
  | 'member'
  | 'literal'
  | 'boolean'
  | 'function'
  | 'object'
  | 'jsx'
  | 'other'
  | 'spread';

export interface JsxPropFact extends Position {
  name: string;                      // '...spread' for spread attributes
  valueText: string;
  kind: JsxPropKind;
  root?: string;                     // Root identifier of the value (user in user.name, props in props.user)
  path?: string[];                   // Member path after root (['name'] for user.name)
  endLine: number;
  endColumn: number;
  objectProperties?: string[];
  functionUsesServerDirective?: boolean;
}

export interface JsxElementFact extends Position {
  tag: string;
  props: JsxPropFact[];
}

export interface PropFact extends Position {
  name: string;
  localName: string;
  type?: string;
  optional?: boolean;
  /** Declared in the destructuring pattern of the component's parameter */
  destructured: boolean;
}

export interface ComponentFact extends Position {
  name: string;
  localName: string;                 // Binding name in the file ('__default__' for anonymous default exports)
  kind: ComponentKind;
  endLine: number;
  isExported: boolean;
  props: PropFact[];
  propsTypes: TypeShape;             // Declared props type (members + unresolved references)
  propsParam?: string;               // `props` when not destructured
  restName?: string;                 // `rest` in ({ a, ...rest })
  hookCalls: HookCallFact[];
  classState?: Position & { keys: string[] };
  jsx: JsxElementFact[];
  propUsages: PropUsage[];
  renames: Omit<PropRename, 'componentId'>[];
  aliasToProp: Record<string, string>;   // local alias → prop name
  usesClientOnlyHooks: boolean;
}
