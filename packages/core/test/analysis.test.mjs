import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReactParser, GraphQuery } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'test-fixtures');

function analyze(dir, options = {}) {
  const parser = new ReactParser({ rootDir: dir, ...options });
  const result = parser.parse();
  return { parser, result, graph: result.graph, q: new GraphQuery(result.graph) };
}

function component(graph, name, fileHint) {
  const all = [...graph.components.values()].filter(c => c.name === name && (!fileHint || c.filePath.includes(fileHint)));
  assert.equal(all.length, 1, `expected exactly one ${name}${fileHint ? ` in ${fileHint}` : ''}, got ${all.length}`);
  return all[0];
}

const rendersTo = (graph, from, to) => graph.renders.some(r => r.from === from.id && r.to === to.id);

// ============================================
// Modern app: React 19, Next.js App Router, aliases, barrels, wrappers
// ============================================

const modern = analyze(path.join(fixtures, 'modern-app'));

test('detects frameworks', () => {
  assert.deepEqual(modern.graph.meta.frameworks.sort(), ['next-app-router', 'react-19']);
  assert.equal(modern.result.errors.length, 0);
});

test('component shapes: memo, forwardRef default export, class, anonymous names', () => {
  const g = modern.graph;
  assert.equal(component(g, 'Shell').kind, 'memo');
  assert.equal(component(g, 'Sidebar').kind, 'forwardRef');
  assert.equal(component(g, 'OldWidget').kind, 'class');
  assert.ok(component(g, 'Page', 'app/page.tsx'));
  assert.equal(component(g, 'OldWidget').props.map(p => p.name).join(), 'label');
});

test('stable, readable ids', () => {
  assert.equal(component(modern.graph, 'Shell').id, 'c:src/components/Shell.tsx#Shell');
});

test('resolves duplicate component names through imports', () => {
  const g = modern.graph;
  const shell = component(g, 'Shell');
  const uiButton = component(g, 'Button', 'components/ui');
  const legacyButton = component(g, 'Button', 'legacy');
  assert.ok(rendersTo(g, shell, uiButton), 'Shell renders ui/Button (via @/ alias)');
  assert.ok(!rendersTo(g, shell, legacyButton));
  assert.ok(rendersTo(g, component(g, 'OldWidget'), legacyButton), 'class component renders legacy/Button');
});

test('resolves barrels, `export *`, `export { default as X }` and aliased re-exports', () => {
  const g = modern.graph;
  assert.ok(rendersTo(g, component(g, 'Page'), component(g, 'Shell')), "Page → Shell via '@/components' barrel (export *)");
  assert.ok(rendersTo(g, component(g, 'Layout'), component(g, 'Sidebar')), "Layout → Sidebar via '.' barrel (default as Sidebar)");
  assert.ok(rendersTo(g, component(g, 'Sidebar'), component(g, 'UserMenu')), 'Sidebar → UserMenu via { UserMenu as Menu }');
});

test('props from imported interfaces (with extends), props.x access and rest spreads', () => {
  const layout = component(modern.graph, 'Layout');
  const names = layout.props.map(p => p.name).sort();
  assert.deepEqual(names, ['className', 'onSelect', 'selectedId', 'user']);
  assert.equal(layout.props.find(p => p.name === 'selectedId').type, 'string | null');
});

test('React 19 context provider (<Ctx value>) and custom hooks that wrap contexts', () => {
  const g = modern.graph;
  const providers = component(g, 'Providers');
  assert.ok(providers.contextProviders.some(p => p.contextId === 'ctx:src/context/theme.ts#ThemeContext'));
  const menu = component(g, 'UserMenu');
  assert.deepEqual(menu.contextConsumerIds.sort(), ['ctx:src/context/auth.tsx#AuthContext', 'ctx:src/context/theme.ts#ThemeContext']);
  const authBoundary = g.contextBoundaries.find(b => b.contextId === 'ctx:src/context/auth.tsx#AuthContext');
  assert.equal(g.components.get(authBoundary.providerComponent).name, 'AuthProvider');
  assert.ok(authBoundary.childComponents.includes(menu.id));
});

test('modern state libraries are classified', () => {
  const menu = component(modern.graph, 'UserMenu');
  const byName = Object.fromEntries(menu.stateProvided.map(s => [s.name, s]));
  assert.equal(byName.items.type, 'serverState');
  assert.equal(byName.items.library, 'tanstack-query');
  assert.equal(byName.items.storeName, "['menu-items']");
  assert.equal(byName.filter.type, 'atom');
  assert.equal(byName.filter.library, 'jotai');
  assert.equal(byName.filter.storeName, 'filterAtom');
  const shell = component(modern.graph, 'Shell');
  assert.equal(shell.stateProvided[0].type, 'useState', 'React.useState is detected');
});

test('Next.js server/client environments and boundary errors', () => {
  const g = modern.graph;
  assert.equal(component(g, 'Page').environment, 'server');
  assert.equal(component(g, 'Shell').environment, 'client');
  assert.equal(component(g, 'Layout').environment, 'client', 'rendered by a client component');
  const codes = g.insights.map(i => i.code);
  assert.ok(codes.includes('SERVER_COMPONENT_HOOK'));
  const fnProp = g.insights.find(i => i.code === 'SERVER_TO_CLIENT_FUNCTION_PROP');
  assert.equal(fnProp.propName, 'onLogout');
});

test('drilling through props.x and {...rest}, grouped per route', () => {
  const g = modern.graph;
  const paths = g.propDrillingPaths;
  assert.equal(paths.length, 2, 'value and setter threads');
  assert.deepEqual(paths[0].path, ['Shell', 'Layout', 'Sidebar', 'UserMenu']);
  assert.ok(paths.every(p => p.passThroughIds.length === 2));
  const drilling = g.insights.filter(i => i.code === 'PROP_DRILLING');
  assert.equal(drilling.length, 1, 'one warning per route');
  assert.match(drilling[0].message, /"selectedId" and "setSelectedId"/);
});

test('query: trace a prop back to its origin through renames and spreads', () => {
  const menu = modern.q.resolveComponent('UserMenu');
  const trace = modern.q.traceProp(menu.id, 'onSelect');
  assert.equal(trace.origins.length, 1);
  const origin = trace.origins[0];
  assert.equal(origin.owner.name, 'Shell');
  assert.equal(origin.isSetter, true);
  assert.deepEqual(origin.chain.map(h => h.component.name), ['Layout', 'Sidebar', 'UserMenu']);
  assert.equal(origin.chain[2].viaSpread, true);
});

test('query: impact of state, component and context', () => {
  const state = modern.q.findState('selectedId')[0];
  const impact = modern.q.impactOfState(state.id);
  const direct = impact.groups.find(g => g.key === 'direct').items.map(i => i.component.name);
  assert.deepEqual(direct.sort(), ['Layout', 'Sidebar', 'UserMenu']);
  const ctx = modern.q.impactOfContext('ctx:src/context/auth.tsx#AuthContext');
  assert.ok(ctx.componentIds.includes(modern.q.resolveComponent('UserMenu').id));
  assert.deepEqual(
    modern.q.findRenderPath(modern.q.resolveComponent('RootLayout').id, modern.q.resolveComponent('AuthProvider').id).length,
    3
  );
});

// ============================================
// Classic sample app (regression)
// ============================================

const sample = analyze(path.join(fixtures, 'sample-app'));

test('sample app: count drilling, context leak, bundle', () => {
  const g = sample.graph;
  assert.equal(g.propDrillingPaths.length, 1);
  assert.deepEqual(g.propDrillingPaths[0].path, ['App', 'Header', 'NavBar', 'NavItem']);
  assert.equal(g.contextLeaks.length, 1);
  assert.equal(g.contextLeaks[0].leakingComponentName, 'SettingsPanel');
  assert.ok(g.bundles.some(b => b.propName === 'userData' && b.estimatedSize === 5));
  const header = component(g, 'Header');
  assert.ok(header.contextConsumerIds.includes('ctx:App.tsx#ThemeContext'));
});

// ============================================
// Path styles & incremental updates (temp projects)
// ============================================

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return fs.realpathSync(dir);
}

test('Vite-style solution tsconfig with references and ~ alias', () => {
  const dir = tempProject({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] }),
    'tsconfig.app.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '~/*': ['src/*'] } }, include: ['src'] }),
    'tsconfig.node.json': JSON.stringify({ compilerOptions: {}, include: ['vite.config.ts'] }),
    'src/App.tsx': `import { Card } from '~/ui/Card';\nexport function App() { return <Card title="x" />; }`,
    'src/ui/Card.tsx': `export function Card({ title }: { title: string }) { return <h1>{title}</h1>; }`,
  });
  const { graph } = analyze(dir);
  assert.ok(rendersTo(graph, component(graph, 'App'), component(graph, 'Card')));
});

test('jsconfig paths, default imports under another name, namespace imports', () => {
  const dir = tempProject({
    'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#ui/*': ['src/ui/*'] } } }),
    'src/App.jsx': `import Fancy from '#ui/Button';\nimport * as Forms from './forms';\nexport default function App() { return <div><Fancy /><Forms.Input /></div>; }`,
    'src/ui/Button.jsx': `export default function Button() { return <button />; }`,
    'src/forms/index.js': `export { Input } from './Input';`,
    'src/forms/Input.jsx': `export const Input = () => <input />;`,
  });
  const { graph } = analyze(dir);
  const app = component(graph, 'App');
  assert.ok(rendersTo(graph, app, component(graph, 'Button')), 'default import renamed (Fancy → Button)');
  assert.ok(rendersTo(graph, app, component(graph, 'Input')), 'namespace member through barrel');
});

test('incremental updates re-link the graph', () => {
  const dir = tempProject({
    'A.tsx': `import { useState } from 'react';\nimport { B } from './B';\nexport function A() { const [v] = useState(1); return <B v={v} />; }`,
    'B.tsx': `import { C } from './C';\nexport function B({ v }: { v: number }) { return <C v={v} />; }`,
    'C.tsx': `import { D } from './D';\nexport function C({ v }: { v: number }) { return <D v={v} />; }`,
    'D.tsx': `export function D({ v }: { v: number }) { return <b>{v}</b>; }`,
  });
  const parser = new ReactParser({ rootDir: dir });
  assert.equal(parser.parse().graph.propDrillingPaths.length, 1);

  // C starts using the value → no longer a pure pass-through → below threshold
  parser.updateFiles([{ filePath: path.join(dir, 'C.tsx'), content: `import { D } from './D';\nexport function C({ v }: { v: number }) { return <D v={v * 2} />; }` }]);
  assert.equal(parser.parse().graph.propDrillingPaths.length, 0);

  // New file appears and is linked
  parser.updateFiles([
    { filePath: path.join(dir, 'E.tsx'), content: `import { A } from './A';\nexport function E() { return <A />; }` },
  ]);
  const g = parser.parse().graph;
  assert.ok(rendersTo(g, component(g, 'E'), component(g, 'A')));

  parser.updateFiles([{ filePath: path.join(dir, 'E.tsx'), content: null }]);
  assert.equal([...parser.parse().graph.components.values()].some(c => c.name === 'E'), false);
});

test('unused props are reported; DOM forwarding and rendering a component prop count as usage', () => {
  const dir = tempProject({
    'Btn.tsx': `export function Btn({ label, onClick, unused }: { label: string; onClick(): void; unused?: string }) {\n  return <button onClick={onClick}>{label}</button>;\n}`,
    'Title.tsx': `import type { ComponentType } from 'react';\nexport function Title({ Glyph, Icon }: { Glyph: ComponentType; Icon: ComponentType }) {\n  return <span><Glyph size={14} /><Icon></Icon></span>;\n}`,
  });
  const { graph } = analyze(dir);
  const unused = graph.insights.filter(i => i.code === 'UNUSED_PROP').map(i => i.propName);
  assert.deepEqual(unused, ['unused']);
});
