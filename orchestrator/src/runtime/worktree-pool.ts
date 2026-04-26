import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileAsync } from '../shared.js';
import {
  assertOwnership,
  isExistingWorktree,
  slugifyBranch,
  verifyOwnership,
  WorktreeOwnershipError,
} from './worktree.js';

export const DEFAULT_POOL_ROOT = '~/.ai-sdlc/worktrees';
export const DEFAULT_STALE_THRESHOLD_DAYS = 14;

export interface WorktreePoolSpec {
  rootDir?: string;
  staleThresholdDays?: number;
  ownershipGuard?: 'strict' | 'advisory';
}

export interface AllocateOptions {
  /** Base branch to create from (default 'origin/main'). */
  baseBranch?: string;
}

export interface WorktreeHandle {
  branch: string;
  slug: string;
  path: string;
  /** True when allocate() created the worktree fresh; false when it adopted an existing one. */
  created: boolean;
}

export class WorktreePoolError extends Error {
  constructor(
    message: string,
    public readonly branch: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorktreePoolError';
  }
}

export interface WorktreePoolManagerDeps {
  /** Override `git` calls in tests. */
  git?: (args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  /** Override clock for stale-threshold tests. */
  now?: () => Date;
}

/**
 * Manages a pool of git worktrees rooted at `rootDir`. Each worktree is named after
 * `slugifyBranch(branch)`. The pool enforces cross-clone ownership (RFC §7.2) and supports
 * allocate / adopt / reclaim plus a stale-threshold sweep (RFC §7.3).
 */
export class WorktreePoolManager {
  readonly rootDir: string;
  private readonly clonePath: string;
  private readonly staleThresholdDays: number;
  private readonly ownershipGuard: 'strict' | 'advisory';
  private readonly git: NonNullable<WorktreePoolManagerDeps['git']>;
  private readonly now: () => Date;

  constructor(clonePath: string, spec: WorktreePoolSpec = {}, deps: WorktreePoolManagerDeps = {}) {
    this.clonePath = resolve(clonePath);
    this.rootDir = expandHome(spec.rootDir ?? DEFAULT_POOL_ROOT);
    this.staleThresholdDays = spec.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
    this.ownershipGuard = spec.ownershipGuard ?? 'strict';
    this.git =
      deps.git ??
      ((args, opts) => execFileAsync('git', args, opts as Record<string, unknown> | undefined));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Allocate a worktree for `branch`. If one already exists at the expected path:
   *   - ownership-verified → adopted (returned with `created: false`)
   *   - ownership mismatch → throws WorktreeOwnershipError (or warns when guard is advisory)
   * Otherwise a fresh worktree is created via `git worktree add`.
   */
  async allocate(branch: string, options: AllocateOptions = {}): Promise<WorktreeHandle> {
    const slug = slugifyBranch(branch);
    const path = join(this.rootDir, slug);

    if (await isExistingWorktree(path)) {
      return this.adopt(branch);
    }

    await mkdir(this.rootDir, { recursive: true });

    const baseBranch = options.baseBranch ?? 'origin/main';
    try {
      await this.git(['worktree', 'add', path, '-b', branch, baseBranch], {
        cwd: this.clonePath,
      });
    } catch (err) {
      throw new WorktreePoolError(
        `git worktree add failed for branch ${branch}: ${(err as Error).message}`,
        branch,
        err,
      );
    }

    return { branch, slug, path, created: true };
  }

  /**
   * Adopt an existing worktree at the slug-derived path. Throws if no worktree exists or
   * if ownership verification fails (when guard is strict).
   */
  async adopt(branch: string): Promise<WorktreeHandle> {
    const slug = slugifyBranch(branch);
    const path = join(this.rootDir, slug);

    if (!(await isExistingWorktree(path))) {
      throw new WorktreePoolError(`No existing worktree at ${path} for branch ${branch}`, branch);
    }

    if (this.ownershipGuard === 'strict') {
      try {
        await assertOwnership(path, this.clonePath);
      } catch (err) {
        if (err instanceof WorktreeOwnershipError) throw err;
        throw err;
      }
    } else {
      const result = await verifyOwnership(path, this.clonePath);
      if (!result.owned) {
        // Advisory: log via console.warn so operators see drift without failing.
        // In production this would route to the structured event stream.
        console.warn(
          `[WorktreePool] advisory ownership mismatch on ${path}: expected ${result.expectedClone}, got ${result.actualClone}`,
        );
      }
    }

    return { branch, slug, path, created: false };
  }

  /**
   * Destroy the worktree for `branch`. By default refuses to remove a worktree with
   * uncommitted changes; callers that need to force MUST pass `{ force: true }`.
   */
  async reclaim(branch: string, options: { force?: boolean } = {}): Promise<void> {
    const slug = slugifyBranch(branch);
    const path = join(this.rootDir, slug);

    if (!(await isExistingWorktree(path))) {
      // Nothing to reclaim is not an error — idempotent.
      return;
    }

    if (!options.force) {
      // Refuse if there are uncommitted changes.
      try {
        const { stdout } = await this.git(['status', '--porcelain'], { cwd: path });
        if (stdout.trim().length > 0) {
          throw new WorktreePoolError(
            `Refusing to reclaim ${path}: uncommitted changes present. Use force: true to override.`,
            branch,
          );
        }
      } catch (err) {
        if (err instanceof WorktreePoolError) throw err;
        // git status failure on a worktree we know exists is a real error.
        throw new WorktreePoolError(
          `git status failed inside ${path}: ${(err as Error).message}`,
          branch,
          err,
        );
      }
    }

    const args = ['worktree', 'remove', path];
    if (options.force) args.push('--force');
    try {
      await this.git(args, { cwd: this.clonePath });
    } catch (err) {
      throw new WorktreePoolError(
        `git worktree remove failed for ${path}: ${(err as Error).message}`,
        branch,
        err,
      );
    }
  }

  /**
   * Convenience hook called by the merge-gate when a PR for `branch` lands. Equivalent
   * to `reclaim(branch)` with the default safety check.
   */
  cleanupOnMerge(branch: string): Promise<void> {
    return this.reclaim(branch);
  }

  /**
   * Enumerate worktree slugs currently present in the pool root. Does not verify ownership.
   */
  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      const result: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (await isExistingWorktree(join(this.rootDir, entry.name))) {
          result.push(entry.name);
        }
      }
      return result;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Reclaim worktrees whose mtime is older than `staleThresholdDays`. Dry-run by default;
   * pass `{ apply: true }` to actually remove them. Returns the slugs considered stale.
   */
  async reclaimStale(options: { apply?: boolean } = {}): Promise<string[]> {
    const slugs = await this.list();
    const cutoff = this.now().getTime() - this.staleThresholdDays * 24 * 60 * 60 * 1000;
    const stale: string[] = [];
    for (const slug of slugs) {
      const path = join(this.rootDir, slug);
      try {
        const s = await stat(path);
        if (s.mtimeMs < cutoff) {
          stale.push(slug);
          if (options.apply) {
            // Use git worktree prune-style remove; force because branch may have moved.
            await this.git(['worktree', 'remove', '--force', path], { cwd: this.clonePath });
          }
        }
      } catch {
        // Ignore missing or stat-failed paths.
      }
    }
    return stale;
  }

  /** Forcibly remove a slug from the pool root without git involvement. Test/cleanup helper. */
  async _forceRemoveSlug(slug: string): Promise<void> {
    await rm(join(this.rootDir, slug), { recursive: true, force: true });
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}
