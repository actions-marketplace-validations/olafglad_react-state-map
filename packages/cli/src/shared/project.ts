import { ReactParser } from '@react-state-map/core';
import type { FileChange } from '@react-state-map/core';
import { watch } from 'chokidar';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectOptions {
  threshold?: string | number;
  include?: string[];
  exclude?: string[];
}

export function parseThreshold(value: string | number | undefined, fallback = 3): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || n < 2) throw new Error(`Invalid threshold "${value}" (expected an integer >= 2)`);
  return n;
}

/** Create a parser; include/exclude stay undefined when the user gave none so core defaults apply */
export function createParser(rootDir: string, options: ProjectOptions): ReactParser {
  return new ReactParser({
    rootDir,
    drillingThreshold: parseThreshold(options.threshold),
    include: options.include?.length ? options.include : undefined,
    exclude: options.exclude?.length ? options.exclude : undefined,
  });
}

export function resolveRootDir(directory: string | undefined): string {
  const rootDir = path.resolve(directory ?? '.');
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Directory "${rootDir}" does not exist`);
  }
  return rootDir;
}

const IGNORED_DIRS = /(^|[\\/])(node_modules|\.git|dist|\.next|\.turbo|coverage)([\\/]|$)/;
const CONFIG_FILE = /^(package\.json|tsconfig.*\.json|jsconfig\.json)$/;

export interface WatchHandle {
  close(): Promise<void>;
  /** Apply pending (debounced) changes right away; resolves when the parser is up to date */
  flush(): void;
}

/**
 * Watch the project and feed changes into the parser incrementally (debounced).
 * `onUpdate` runs after `parser.updateFiles()` with the changed paths; call `parser.parse()` there.
 */
export function watchProject(
  parser: ReactParser,
  rootDir: string,
  onUpdate: (changed: string[]) => void,
  options: { debounceMs?: number; log?: (msg: string) => void } = {}
): WatchHandle {
  const pending = new Map<string, FileChange>();
  let configChanged = false;
  let timer: NodeJS.Timeout | null = null;

  const watcher = watch(rootDir, {
    ignored: (p: string) => IGNORED_DIRS.test(path.relative(rootDir, p)),
    ignoreInitial: true,
    persistent: true,
  });

  const apply = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.size && !configChanged) return;
    const changes = [...pending.values()];
    pending.clear();
    if (configChanged) {
      parser.invalidateConfig();
      configChanged = false;
    }
    if (changes.length) parser.updateFiles(changes);
    onUpdate(changes.map(c => c.filePath));
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, options.debounceMs ?? 250);
  };

  const handle = (kind: 'add' | 'change' | 'unlink') => (filePath: string) => {
    const abs = path.resolve(filePath);
    if (CONFIG_FILE.test(path.basename(abs))) {
      configChanged = true;
      schedule();
      return;
    }
    // Deleted files are always forwarded (the parser ignores unknown ones)
    if (kind !== 'unlink' && !parser.isIncluded(abs)) return;
    pending.set(abs, kind === 'unlink' ? { filePath: abs, content: null } : { filePath: abs });
    schedule();
  };

  watcher.on('add', handle('add'));
  watcher.on('change', handle('change'));
  watcher.on('unlink', handle('unlink'));
  watcher.on('error', (err) => options.log?.(`watch error: ${err instanceof Error ? err.message : String(err)}`));

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      return watcher.close();
    },
    flush: apply,
  };
}
