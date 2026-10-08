import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class GitError extends Error {}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : `: ${e.message}`}`);
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Repository top-level directory for a path, or null when not inside a git work tree */
export function gitTopLevel(dir: string): string | null {
  const top = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return top ? fs.realpathSync(top) : null;
}

/** Resolve a ref to a commit sha, fetching it from origin (shallow) when it is missing locally */
export function resolveBaseCommit(repoRoot: string, ref: string, log: (msg: string) => void): string {
  const verify = () => tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  let sha = verify();
  if (!sha) {
    log(`Base ref "${ref}" not found locally; fetching it from origin…`);
    const fetched = tryGit(repoRoot, ['fetch', '--no-tags', '--depth=1', 'origin', ref]);
    sha = verify() ?? (fetched !== null ? tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}']) : null);
  }
  if (!sha) {
    throw new GitError(
      `Base ref "${ref}" was not found in ${repoRoot} and could not be fetched from origin. ` +
      'Make sure the checkout has history for the base (actions/checkout with fetch-depth: 0) or pass an existing ref/sha.'
    );
  }
  return sha;
}

/**
 * Check out `commit` into a temporary detached worktree, run `fn` with its path, and remove it again.
 */
export async function withWorktree<T>(repoRoot: string, commit: string, fn: (worktreeDir: string) => T | Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'react-state-map-base-'));
  const dir = path.join(tmp, 'worktree');
  git(repoRoot, ['worktree', 'add', '--detach', dir, commit]);
  try {
    return await fn(fs.realpathSync(dir));
  } finally {
    tryGit(repoRoot, ['worktree', 'remove', '--force', dir]);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    tryGit(repoRoot, ['worktree', 'prune']);
  }
}
