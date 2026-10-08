// Integration tests that run inside a real VS Code instance.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ws = process.env.RSM_WORKSPACE;
const file = rel => path.join(ws, rel);
const uri = rel => vscode.Uri.file(file(rel));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 60000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.stack}` : ''}`);
}

const ours = rel => vscode.languages.getDiagnostics(uri(rel)).filter(d => d.source === 'React State Map');
const codeOf = d => (typeof d.code === 'object' ? d.code.value : d.code);

function positionOf(doc, needle, offset = 0) {
  const index = doc.getText().indexOf(needle);
  assert.ok(index >= 0, `"${needle}" not found`);
  return doc.positionAt(index + offset);
}

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✖ ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
  }
}

exports.run = async function run() {
  console.log('React State Map integration tests');
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'react-state-map-vscode');
  assert.ok(ext, 'extension present');
  await ext.activate();

  await test('diagnostics: drilling, server component errors', async () => {
    const drilling = await waitFor(() => ours('src/components/Shell.tsx').find(d => codeOf(d) === 'PROP_DRILLING'), 'drilling diagnostic');
    assert.match(drilling.message, /drilled through 2 components/);
    assert.equal(drilling.severity, vscode.DiagnosticSeverity.Warning);
    assert.ok(drilling.relatedInformation.length >= 3, 'related locations along the chain');
    const hook = ours('src/app/bad/page.tsx').find(d => codeOf(d) === 'SERVER_COMPONENT_HOOK');
    assert.ok(hook && hook.severity === vscode.DiagnosticSeverity.Error);
    assert.ok(ours('src/app/settings/page.tsx').some(d => codeOf(d) === 'SERVER_TO_CLIENT_FUNCTION_PROP'));
  });

  await test('codelens above components and state', async () => {
    await vscode.workspace.openTextDocument(uri('src/components/Shell.tsx'));
    const lenses = await waitFor(async () => {
      const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('src/components/Shell.tsx'), 100);
      return l && l.length ? l : undefined;
    }, 'code lenses');
    const titles = lenses.map(l => l.command && l.command.title).join(' | ');
    assert.match(titles, /rendered by 2 components/);
    assert.match(titles, /drills "selectedId", "setSelectedId"/);
    assert.match(titles, /selectedId → used by 3 other components/);
  });

  await test('hover shows where a prop comes from', async () => {
    const doc = await vscode.workspace.openTextDocument(uri('src/components/UserMenu.tsx'));
    await vscode.window.showTextDocument(doc);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, positionOf(doc, 'onSelect }', 2));
    const text = hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /Comes from/);
    assert.match(text, /Shell › setSelectedId/);
    assert.match(text, /Lift into a context/);
  });

  await test('quick fix offered on the drilling diagnostic', async () => {
    const doc = await vscode.workspace.openTextDocument(uri('src/components/Shell.tsx'));
    const diag = ours('src/components/Shell.tsx').find(d => codeOf(d) === 'PROP_DRILLING');
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, diag.range);
    assert.ok(actions.some(a => /Lift "selectedId" into a React context/.test(a.title)), actions.map(a => a.title).join(', '));
  });

  await test('show impact fills the Impact view', async () => {
    const doc = await vscode.workspace.openTextDocument(uri('src/components/Shell.tsx'));
    const editor = await vscode.window.showTextDocument(doc);
    const pos = positionOf(doc, 'React.useState');
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand('reactStateMap.showImpact');
  });

  await test('Copilot / agent tools answer from the live analysis', async () => {
    const names = vscode.lm.tools.map(t => t.name).filter(n => n.startsWith('reactStateMap_'));
    assert.equal(names.length, 8, names.join(', '));
    const call = async (name, input) => {
      const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
      return result.content.map(p => p.value).join('');
    };
    assert.match(await call('reactStateMap_overview', {}), /next-app-router/);
    assert.match(await call('reactStateMap_traceProp', { component: 'UserMenu', prop: 'onSelect' }), /Shell/);
    assert.match(await call('reactStateMap_impact', { state: 'selectedId' }), /4 components affected/);
    assert.match(await call('reactStateMap_planFix', { insight_id: ours('src/components/Shell.tsx').length ? (await call('reactStateMap_issues', { code: 'PROP_DRILLING' })).match(/PROP_DRILLING:\S+/)[0] : '' }), /\+\+\+ b\/src\/components\/SelectedIdContext\.ts/);
  });

  await test('graph panel opens and focuses a component', async () => {
    await vscode.commands.executeCommand('reactStateMap.openPanel');
    await vscode.commands.executeCommand('reactStateMap.showInStateMap');
    await sleep(500);
  });

  await test('live analysis of unsaved edits', async () => {
    const doc = await vscode.workspace.openTextDocument(uri('src/components/ui/Button.tsx'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(b => b.replace(new vscode.Range(0, 0, doc.lineCount, 0),
      'export function Button({ label, onClick, ghost }: { label: string; onClick?: () => void; ghost?: boolean }) {\n  return <button onClick={onClick}>{label}</button>;\n}\n'));
    const unused = await waitFor(() => ours('src/components/ui/Button.tsx').find(d => codeOf(d) === 'UNUSED_PROP'), 'unused prop diagnostic from unsaved buffer');
    assert.ok(unused.tags.includes(vscode.DiagnosticTag.Unnecessary));
    await vscode.commands.executeCommand('reactStateMap.removeUnusedProp', {
      insightId: `UNUSED_PROP:c:src/components/ui/Button.tsx#Button:ghost`,
      filePath: doc.uri.fsPath,
    });
    assert.match(doc.getText(), /function Button\(\{ label, onClick \}/);
    await doc.save();
  });

  await test('lift into context refactors the chain and the warning disappears', async () => {
    // Expected result straight from the core planner on a pristine copy of the fixture
    const core = require(path.resolve(__dirname, '../../../core/dist/index.js'));
    const os = require('node:os');
    const pristine = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-expected-'));
    fs.cpSync(path.resolve(__dirname, '../../../core/test-fixtures/modern-app'), pristine, { recursive: true });
    const parser = new core.ReactParser({ rootDir: pristine });
    const graph = parser.parse().graph;
    const insight = graph.insights.find(i => i.code === 'PROP_DRILLING');
    const expected = core.planLiftToContext(parser.getProject(), graph, insight.drillingPathId, { react19: true });
    assert.ok(expected.applicable);

    const diag = ours('src/components/Shell.tsx').find(d => codeOf(d) === 'PROP_DRILLING');
    assert.ok(diag, 'still drilling before the fix');
    const doc = await vscode.workspace.openTextDocument(uri('src/components/Shell.tsx'));
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, diag.range);
    const lift = actions.find(a => /Lift/.test(a.title));
    await vscode.commands.executeCommand(lift.command.command, ...lift.command.arguments);
    await waitFor(() => fs.existsSync(file('src/components/SelectedIdContext.ts')), 'context file created');
    await vscode.workspace.saveAll();
    for (const e of expected.edits) {
      const base = e.filePath.startsWith(pristine) ? pristine : fs.realpathSync(pristine);
      const rel = path.relative(base, e.filePath);
      assert.equal(fs.readFileSync(file(rel), 'utf8'), e.newText, `${rel} matches the planned refactor exactly`);
    }
    await waitFor(() => !ours('src/components/Shell.tsx').some(d => codeOf(d) === 'PROP_DRILLING'), 'drilling diagnostic to clear');
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) throw new Error(`${failed.length} integration test(s) failed`);
};
