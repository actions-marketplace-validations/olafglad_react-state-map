import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ReactParser, planLiftToContext, planRemoveUnusedProp } from '../dist/index.js';

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-fix-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return fs.realpathSync(dir);
}

const chain = {
  'App.tsx': `import { useState } from 'react';
import { Page } from './Page';

export function App() {
  const [user, setUser] = useState<string | null>(null);
  return <Page user={user} onLogin={setUser} title="Home" />;
}
`,
  'Page.tsx': `import { Sidebar } from './Sidebar';

interface PageProps {
  user: string | null;
  onLogin: (u: string) => void;
  title: string;
}

export function Page({ user, onLogin, title }: PageProps) {
  return <main><h1>{title}</h1><Sidebar user={user} onLogin={onLogin} /></main>;
}
`,
  'Sidebar.tsx': `import { Avatar } from './Avatar';

export const Sidebar = ({ user, onLogin }: { user: string | null; onLogin: (u: string) => void }) => (
  <aside><Avatar user={user} onLogin={onLogin} /></aside>
);
`,
  'Avatar.tsx': `export function Avatar({ user, onLogin }: { user: string | null; onLogin: (u: string) => void }) {
  return user ? <img alt={user} /> : <button onClick={() => onLogin('me')}>Log in</button>;
}
`,
};

test('lift-to-context rewrites the whole chain', () => {
  const dir = tempProject(chain);
  const parser = new ReactParser({ rootDir: dir });
  const { graph } = parser.parse();
  const insight = graph.insights.find(i => i.code === 'PROP_DRILLING');
  assert.ok(insight, 'drilling detected');

  const plan = planLiftToContext(parser.getProject(), graph, insight.drillingPathId);
  assert.equal(plan.applicable, true, plan.reasons.join('; '));
  const byFile = Object.fromEntries(plan.edits.map(e => [path.basename(e.filePath), e.newText]));

  assert.match(byFile['UserContext.ts'], /export function useUser\(\): \{ user: string \| null; setUser: \(u: string\) => void \}/);
  assert.match(byFile['App.tsx'], /const userContextValue = useMemo\(\(\) => \(\{ user, setUser \}\), \[user, setUser\]\);/);
  assert.match(byFile['App.tsx'], /<UserContext\.Provider value=\{userContextValue\}><Page title="Home" \/><\/UserContext\.Provider>/);
  assert.match(byFile['Page.tsx'], /export function Page\(\{ title \}: PageProps\)/);
  assert.doesNotMatch(byFile['Page.tsx'], /onLogin/);
  assert.match(byFile['Sidebar.tsx'], /export const Sidebar = \(\) => \(/);
  assert.match(byFile['Avatar.tsx'], /const \{ user, setUser: onLogin \} = useUser\(\);/);
  assert.match(byFile['Avatar.tsx'], /export function Avatar\(\)/);
});

test('lift-to-context refuses when a chain component is rendered elsewhere', () => {
  const dir = tempProject({
    ...chain,
    'Other.tsx': `import { Avatar } from './Avatar';\nexport function Other() { return <Avatar user="x" onLogin={() => {}} />; }\n`,
  });
  const parser = new ReactParser({ rootDir: dir });
  const { graph } = parser.parse();
  const insight = graph.insights.find(i => i.code === 'PROP_DRILLING');
  const plan = planLiftToContext(parser.getProject(), graph, insight.drillingPathId);
  assert.equal(plan.applicable, false);
  assert.match(plan.reasons.join(' '), /Avatar is also rendered by Other/);
});

test('React 19 provider syntax', () => {
  const dir = tempProject(chain);
  const parser = new ReactParser({ rootDir: dir });
  const { graph } = parser.parse();
  const insight = graph.insights.find(i => i.code === 'PROP_DRILLING');
  const plan = planLiftToContext(parser.getProject(), graph, insight.drillingPathId, { react19: true });
  const app = plan.edits.find(e => e.filePath.endsWith('App.tsx')).newText;
  assert.match(app, /<UserContext value=\{userContextValue\}>/);
});

test('remove unused prop', () => {
  const dir = tempProject({
    'Btn.tsx': `export function Btn({ label, unused }: { label: string; unused?: string }) {\n  return <b>{label}</b>;\n}\n`,
  });
  const parser = new ReactParser({ rootDir: dir });
  const { graph } = parser.parse();
  const insight = graph.insights.find(i => i.code === 'UNUSED_PROP');
  const plan = planRemoveUnusedProp(parser.getProject(), insight);
  assert.equal(plan.applicable, true);
  assert.match(plan.edits[0].newText, /function Btn\(\{ label \}: /);
});
