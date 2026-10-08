import { Project, SourceFile, ts } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ParseOptions, ParseResult, ParseError } from '../types.js';
import type { FileFacts } from './facts.js';
import { extractFileFacts } from './extract.js';
import { ModuleResolver, normalizePath } from './module-resolver.js';
import { GraphBuilder, type ProjectInfo } from '../graph/build.js';
import { matchesGlob } from './glob.js';

export const DEFAULT_INCLUDE = ['**/*.tsx', '**/*.jsx', '**/*.ts', '**/*.js', '**/*.mts', '**/*.mjs'];
export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/storybook-static/**',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/*.bundle.js',
  '**/*.min.js',
];

export interface FileChange {
  filePath: string;
  /** New contents; omit to re-read from disk; null when the file was deleted */
  content?: string | null;
}

/**
 * Parses a React project into a state flow graph.
 *
 * The parser is incremental: per-file facts are cached, so after the first `parse()`
 * call `updateFiles()` + `parse()` only re-extracts the changed files and re-links the graph.
 */
export class ReactParser {
  private project: Project;
  private options: ParseOptions & { drillingThreshold: number };
  private errors: ParseError[] = [];
  private factsCache = new Map<string, FileFacts>();
  private resolver: ModuleResolver;
  private loaded = false;
  private packageJsonCache = new Map<string, Record<string, string> | null>();

  constructor(options: ParseOptions) {
    this.options = {
      ...options,
      rootDir: path.resolve(options.rootDir),
      drillingThreshold: options.drillingThreshold ?? 3,
    };

    // The type checker is never needed for analysis, so no tsconfig is loaded here;
    // module resolution uses each file's nearest tsconfig (see ModuleResolver).
    this.project = new Project({
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    this.resolver = new ModuleResolver();
  }

  get rootDir(): string {
    return this.options.rootDir;
  }

  /** The underlying ts-morph project (used by code fixes) */
  getProject(): Project {
    return this.project;
  }

  parse(): ParseResult {
    const started = Date.now();
    this.errors = [];

    if (!this.loaded) {
      this.loadSourceFiles();
      this.loaded = true;
    }

    for (const sf of this.project.getSourceFiles()) {
      const filePath = sf.getFilePath();
      if (this.factsCache.has(filePath)) continue;
      this.extract(sf);
    }

    const projectInfo = this.detectProject();
    const builder = new GraphBuilder(this.factsCache.values(), this.resolver, projectInfo);
    const { graph, warnings } = builder.build();

    const frameworks: string[] = [];
    if (projectInfo.nextRoots.length) frameworks.push('next-app-router');
    if (projectInfo.reactMajor) frameworks.push(`react-${projectInfo.reactMajor}`);

    graph.meta = {
      rootDir: this.options.rootDir,
      filesAnalyzed: this.factsCache.size,
      durationMs: Date.now() - started,
      frameworks,
      drillingThreshold: this.options.drillingThreshold,
    };

    return { graph, errors: this.errors, warnings };
  }

  /** Apply file changes (from an editor or file watcher). Call parse() afterwards. */
  updateFiles(changes: FileChange[]): void {
    if (!this.loaded) return;
    let structural = false;

    for (const change of changes) {
      const filePath = normalizePath(change.filePath);
      const base = path.basename(filePath);
      if (base === 'package.json' || /^(tsconfig|jsconfig).*\.json$/.test(base)) {
        this.invalidateConfig();
        continue;
      }
      const existing = this.project.getSourceFile(filePath);
      this.factsCache.delete(filePath);

      if (change.content === null) {
        if (existing) {
          this.project.removeSourceFile(existing);
          structural = true;
        }
        continue;
      }

      if (!this.isIncluded(filePath)) continue;

      const content = change.content ?? safeRead(filePath);
      if (content === null) continue;

      if (existing) {
        existing.replaceWithText(content);
      } else {
        this.project.createSourceFile(filePath, content, { overwrite: true });
        structural = true;
      }
    }

    if (structural) this.resolver.invalidate();
  }

  /** Notify the parser that a config file (package.json, tsconfig) changed */
  invalidateConfig(): void {
    this.packageJsonCache.clear();
    this.resolver.reset();
  }

  isIncluded(filePath: string): boolean {
    const rel = path.relative(this.options.rootDir, filePath).split(path.sep).join('/');
    if (rel.startsWith('..')) return false;
    const include = this.options.include?.length ? this.options.include : DEFAULT_INCLUDE;
    const exclude = this.options.exclude?.length ? this.options.exclude : DEFAULT_EXCLUDE;
    return include.some(p => matchesGlob(rel, p)) && !exclude.some(p => matchesGlob(rel, p));
  }

  private extract(sf: SourceFile): void {
    const filePath = sf.getFilePath();
    try {
      this.factsCache.set(filePath, extractFileFacts(sf));
    } catch (error) {
      this.errors.push({
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private loadSourceFiles(): void {
    const include = this.options.include?.length ? this.options.include : DEFAULT_INCLUDE;
    const exclude = this.options.exclude?.length ? this.options.exclude : DEFAULT_EXCLUDE;
    const toGlob = (p: string) => path.join(this.options.rootDir, p).split(path.sep).join('/');
    this.project.addSourceFilesAtPaths([
      ...include.map(toGlob),
      ...exclude.map(p => '!' + toGlob(p)),
    ]);
  }

  // ============================================
  // Project detection (Next.js App Router, React version)
  // ============================================

  private readDeps(dir: string): Record<string, string> | null {
    const cached = this.packageJsonCache.get(dir);
    if (cached !== undefined) return cached;
    let deps: Record<string, string> | null = null;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        deps = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };
      } catch {
        deps = {};
      }
    }
    this.packageJsonCache.set(dir, deps);
    return deps;
  }

  private detectProject(): ProjectInfo {
    const packageDirs = new Set<string>();
    const dirsSeen = new Set<string>();

    for (const filePath of this.factsCache.keys()) {
      let dir = path.dirname(filePath);
      while (!dirsSeen.has(dir)) {
        dirsSeen.add(dir);
        if (this.readDeps(dir)) {
          packageDirs.add(dir);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // The root package.json may sit above rootDir (monorepo root); include it as well
    let dir = this.options.rootDir;
    for (let i = 0; i < 4; i++) {
      if (this.readDeps(dir)) packageDirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    const nextRoots: string[] = [];
    let reactMajor: number | null = null;
    for (const d of packageDirs) {
      const deps = this.readDeps(d)!;
      if (deps.next && (fs.existsSync(path.join(d, 'app')) || fs.existsSync(path.join(d, 'src', 'app')))) {
        nextRoots.push(normalizePath(d));
      }
      const react = deps.react?.match(/(\d+)/);
      if (react) reactMajor = Math.max(reactMajor ?? 0, Number(react[1]));
    }

    return {
      rootDir: this.options.rootDir,
      drillingThreshold: this.options.drillingThreshold,
      nextRoots,
      reactMajor,
    };
  }

  /** React major version detected from package.json (null if unknown) */
  getReactMajor(): number | null {
    return this.detectProject().reactMajor;
  }
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
