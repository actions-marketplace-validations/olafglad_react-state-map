import { ts } from 'ts-morph';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolves import specifiers to files on disk the same way the TypeScript compiler would,
 * using the nearest tsconfig/jsconfig of the importing file. Handles `paths`, `baseUrl`,
 * `extends`, solution-style configs with `references` (Vite), and plain relative imports.
 */
export class ModuleResolver {
  private configCache = new Map<string, ts.CompilerOptions>();
  private configForDir = new Map<string, string | null>();
  private resolutionCache = new Map<string, string | null>();
  private externalCache = new Set<string>();

  /** Clear resolution results (call when files are added or removed) */
  invalidate(): void {
    this.resolutionCache.clear();
    this.externalCache.clear();
  }

  /** Clear everything, including parsed tsconfig files */
  reset(): void {
    this.resolutionCache.clear();
    this.externalCache.clear();
    this.configCache.clear();
    this.configForDir.clear();
  }

  resolve(specifier: string, fromFile: string): string | null {
    const key = `${path.dirname(fromFile)}\0${specifier}`;
    const cached = this.resolutionCache.get(key);
    if (cached !== undefined) return cached;

    const resolved = this.resolveUncached(specifier, fromFile, key);
    this.resolutionCache.set(key, resolved);
    return resolved;
  }

  /** True when the specifier resolved to a package (node_modules), not a project file */
  isExternal(specifier: string, fromFile: string): boolean {
    this.resolve(specifier, fromFile);
    return this.externalCache.has(`${path.dirname(fromFile)}\0${specifier}`);
  }

  private resolveUncached(specifier: string, fromFile: string, key: string): string | null {
    const options = this.getCompilerOptions(fromFile);
    const result = ts.resolveModuleName(specifier, fromFile, options, ts.sys);
    const resolved = result.resolvedModule;

    if (resolved && !resolved.isExternalLibraryImport) {
      return normalizePath(resolved.resolvedFileName);
    }
    if (resolved?.isExternalLibraryImport) {
      this.externalCache.add(key);
      return null;
    }

    // Fallback for projects without a tsconfig that still use relative imports with odd extensions
    if (specifier.startsWith('.')) {
      const base = path.resolve(path.dirname(fromFile), specifier);
      for (const candidate of candidatePaths(base)) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return normalizePath(candidate);
        }
      }
    }

    return null;
  }

  private getCompilerOptions(fromFile: string): ts.CompilerOptions {
    const configPath = this.findConfig(path.dirname(fromFile));
    if (!configPath) return defaultOptions();

    const cached = this.configCache.get(configPath);
    if (cached) return cached;

    const options = this.loadConfig(configPath, fromFile) ?? defaultOptions();
    this.configCache.set(configPath, options);
    return options;
  }

  private loadConfig(configPath: string, fromFile: string, depth = 0): ts.CompilerOptions | null {
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      });
      if (!parsed) return null;

      const options = { ...defaultOptions(), ...parsed.options };

      // Solution-style config (e.g. Vite: files: [] + references to tsconfig.app.json).
      // The paths live in a referenced project; prefer one that includes the importing file.
      if (!options.paths && !options.baseUrl && parsed.projectReferences?.length && depth < 3) {
        let fallback: ts.CompilerOptions | null = null;
        for (const ref of parsed.projectReferences) {
          const refPath = ts.resolveProjectReferencePath(ref);
          if (!fs.existsSync(refPath)) continue;
          const refParsed = ts.getParsedCommandLineOfConfigFile(refPath, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => {},
          });
          if (!refParsed) continue;
          const refOptions = { ...defaultOptions(), ...refParsed.options };
          const normalizedFrom = normalizePath(fromFile);
          if (refParsed.fileNames.some(f => normalizePath(f) === normalizedFrom)) {
            return refOptions;
          }
          if (!fallback && (refOptions.paths || refOptions.baseUrl)) {
            fallback = refOptions;
          }
        }
        if (fallback) return fallback;
      }

      return options;
    } catch {
      return null;
    }
  }

  private findConfig(dir: string): string | null {
    const visited: string[] = [];
    let current = dir;
    let found: string | null = null;

    while (true) {
      const cached = this.configForDir.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(current);

      const tsconfig = path.join(current, 'tsconfig.json');
      const jsconfig = path.join(current, 'jsconfig.json');
      if (fs.existsSync(tsconfig)) {
        found = tsconfig;
        break;
      }
      if (fs.existsSync(jsconfig)) {
        found = jsconfig;
        break;
      }

      // Keep walking above rootDir: a monorepo's tsconfig may live higher up
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    for (const v of visited) this.configForDir.set(v, found);
    return found;
  }
}

function defaultOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    resolveJsonModule: false,
  };
}

function candidatePaths(base: string): string[] {
  const exts = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.cts', '.cjs'];
  const out: string[] = [base];
  for (const ext of exts) out.push(base + ext);
  for (const ext of exts) out.push(path.join(base, 'index' + ext));
  // import './Foo.js' that actually points at Foo.tsx
  const jsExt = path.extname(base);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(jsExt)) {
    const stem = base.slice(0, -jsExt.length);
    out.push(stem + '.tsx', stem + '.ts');
  }
  return out;
}

export function normalizePath(p: string): string {
  return path.resolve(p).split(path.sep).join('/');
}
