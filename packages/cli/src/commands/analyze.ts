import { serializeGraph, GraphAnalyzer } from '@react-state-map/core';
import type { ReactParser, SerializedStateFlowGraph } from '@react-state-map/core';
import { generateHTML } from '../renderers/html-renderer.js';
import { createParser, watchProject } from '../shared/project.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { platform } from 'node:os';

interface AnalyzeOptions {
  output: string;
  format: string;
  watch?: boolean;
  threshold: string;
  open?: boolean;
  exclude?: string[];
  include?: string[];
}

function openInBrowser(filePath: string): void {
  const absolutePath = path.resolve(filePath);
  const cmd = platform() === 'darwin'
    ? `open "${absolutePath}"`
    : platform() === 'win32'
      ? `start "" "${absolutePath}"`
      : `xdg-open "${absolutePath}"`;

  exec(cmd, (error) => {
    if (error) {
      console.log(`  Open manually: file://${absolutePath}`);
    }
  });
}

function analyze(parser: ReactParser): SerializedStateFlowGraph {
  const result = parser.parse();

  if (result.errors.length > 0) {
    console.log('⚠️  Errors during parsing:');
    for (const error of result.errors) {
      console.log(`   ${error.filePath}: ${error.message}`);
    }
    console.log('');
  }

  const serialized = serializeGraph(result.graph);
  const analyzer = new GraphAnalyzer(result.graph);
  const summary = analyzer.getSummary();

  console.log(`   Components: ${summary.components.totalComponents}`);
  console.log(`   State nodes: ${summary.state.totalStateNodes}`);
  console.log(`   Flow edges: ${summary.flow.totalEdges}`);
  console.log(`   Context boundaries: ${summary.contextBoundaries}`);

  if (summary.propDrillingPaths > 0) {
    console.log(`   ⚠️  Prop drilling paths: ${summary.propDrillingPaths}`);
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    for (const warning of result.warnings) {
      console.log(`   [${warning.code}] ${path.basename(warning.filePath)}:${warning.line}`);
      console.log(`      ${warning.message}`);
    }
  }

  return serialized;
}

function writeOutput(
  graph: SerializedStateFlowGraph,
  options: AnalyzeOptions,
  isWatch: boolean = false
): void {
  const outputPath = path.resolve(options.output);

  if (options.format === 'json') {
    fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2));
  } else {
    const html = generateHTML(graph);
    fs.writeFileSync(outputPath, html);
  }

  console.log(`\n✅ Output written to: ${outputPath}`);

  if (options.open !== false && !isWatch) {
    openInBrowser(outputPath);
  }
}

export function analyzeCommand(directory: string, options: AnalyzeOptions): void {
  const rootDir = path.resolve(directory);

  if (!fs.existsSync(rootDir)) {
    console.error(`Error: Directory "${rootDir}" does not exist`);
    process.exit(1);
  }

  let parser: ReactParser;
  try {
    parser = createParser(rootDir, options);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`\n📊 Analyzing ${rootDir}...\n`);
  writeOutput(analyze(parser), options);

  if (options.watch) {
    console.log('\n👀 Watching for changes...\n');

    // One parser stays alive; file events are applied incrementally (only changed files are re-parsed)
    const watcher = watchProject(parser, rootDir, (changed) => {
      const names = changed.map(p => path.basename(p));
      console.log(`\n📝 Changed: ${names.length ? names.slice(0, 5).join(', ') + (names.length > 5 ? ` (+${names.length - 5})` : '') : 'project config'}`);
      try {
        writeOutput(analyze(parser), options, true);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, { debounceMs: 300, log: (msg) => console.error(msg) });

    process.on('SIGINT', () => {
      console.log('\n\n👋 Stopping watcher...');
      void watcher.close().finally(() => process.exit(0));
    });
  }
}
