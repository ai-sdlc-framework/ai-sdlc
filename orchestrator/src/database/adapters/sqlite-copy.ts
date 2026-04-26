/**
 * SqliteCopyAdapter per RFC §15.2. Copies the upstream `.sqlite` file to a per-branch
 * file in the worktree. Hardlinks for read-only branches; full copy for write/migrate.
 *
 * Connection-string format (the orchestrator's existing convention): plain absolute
 * file path, optionally prefixed with `file://`.
 */

import { copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DatabaseBranchAdapterError,
  type DatabaseBranchAdapter,
  type DatabaseBranchCapabilities,
  type DatabaseBranchHandle,
  type DatabaseAdapterName,
  type ResolvedDatabaseBranchPool,
  type ValidationResult,
} from '../types.js';

export interface SqliteCopyAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the per-branch storage root for tests. Defaults to `<cwd>/.ai-sdlc/db`. */
  storageRoot?: string;
}

export class SqliteCopyAdapter implements DatabaseBranchAdapter {
  readonly name: DatabaseAdapterName = 'sqlite-copy';

  readonly capabilities: DatabaseBranchCapabilities = {
    branchCreationLatencyP50Ms: 50,
    maxBranches: 10_000,
    supportsMigrations: true,
    supportsReadOnlyBranches: true,
    supportsBranchFromBranch: true,
    multiDatabase: false,
    costModel: 'free',
  };

  constructor(private readonly deps: SqliteCopyAdapterDeps = {}) {}

  private storageRootFor(_pool: ResolvedDatabaseBranchPool): string {
    return this.deps.storageRoot ?? join(process.cwd(), '.ai-sdlc', 'db');
  }

  async validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult> {
    const env = this.deps.env ?? process.env;
    const upstreamPath = env[pool.upstream.connectionStringEnv];
    if (!upstreamPath) {
      return {
        ok: false,
        error: `${pool.upstream.connectionStringEnv} is not set in env; cannot locate upstream SQLite file`,
      };
    }
    try {
      const s = await stat(stripFileScheme(upstreamPath));
      if (!s.isFile()) {
        return { ok: false, error: `upstream SQLite path is not a file: ${upstreamPath}` };
      }
    } catch {
      return { ok: false, error: `upstream SQLite file not found: ${upstreamPath}` };
    }
    return { ok: true };
  }

  async allocate(
    pool: ResolvedDatabaseBranchPool,
    branchKey: string,
  ): Promise<DatabaseBranchHandle> {
    const env = this.deps.env ?? process.env;
    const upstreamRaw = env[pool.upstream.connectionStringEnv];
    if (!upstreamRaw) {
      throw new DatabaseBranchAdapterError(
        `${pool.upstream.connectionStringEnv} not set`,
        this.name,
        branchKey,
      );
    }
    const upstreamPath = stripFileScheme(upstreamRaw);
    const branchPath = join(this.storageRootFor(pool), `${branchKey}.sqlite`);
    await mkdir(dirname(branchPath), { recursive: true });

    try {
      await copyFile(upstreamPath, branchPath);
    } catch (err) {
      throw new DatabaseBranchAdapterError(
        `failed to copy SQLite database for branch '${branchKey}': ${(err as Error).message}`,
        this.name,
        branchKey,
        err,
      );
    }

    return {
      branchKey,
      connectionString: `file://${branchPath}`,
      createdAt: new Date(),
      upstream: upstreamPath,
      metadata: { branchPath, mode: 'copy' },
    };
  }

  /**
   * Read-only branch via hardlink (saves disk space when many readers share the same
   * upstream snapshot). Caller is responsible for never opening the resulting file
   * for write — SQLite will happily corrupt the hardlinked upstream if treated as RW.
   */
  async allocateReadOnly(
    pool: ResolvedDatabaseBranchPool,
    branchKey: string,
  ): Promise<DatabaseBranchHandle> {
    const env = this.deps.env ?? process.env;
    const upstreamRaw = env[pool.upstream.connectionStringEnv];
    if (!upstreamRaw) {
      throw new DatabaseBranchAdapterError(
        `${pool.upstream.connectionStringEnv} not set`,
        this.name,
        branchKey,
      );
    }
    const upstreamPath = stripFileScheme(upstreamRaw);
    const branchPath = join(this.storageRootFor(pool), `${branchKey}.ro.sqlite`);
    await mkdir(dirname(branchPath), { recursive: true });
    try {
      await link(upstreamPath, branchPath);
    } catch {
      // Fall back to a copy if hardlink fails (e.g., across filesystems).
      await copyFile(upstreamPath, branchPath);
    }
    return {
      branchKey,
      connectionString: `file://${branchPath}?mode=ro`,
      createdAt: new Date(),
      upstream: upstreamPath,
      metadata: { branchPath, mode: 'hardlink-ro' },
    };
  }

  async reclaim(handle: DatabaseBranchHandle): Promise<void> {
    const path = handle.metadata.branchPath;
    if (!path) return;
    await rm(path, { force: true });
  }

  async list(pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]> {
    const root = this.storageRootFor(pool);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const handles: DatabaseBranchHandle[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.sqlite')) continue;
      const branchPath = join(root, entry);
      const s = await stat(branchPath);
      const branchKey = entry.replace(/\.(?:ro\.)?sqlite$/, '');
      handles.push({
        branchKey,
        connectionString: `file://${branchPath}`,
        createdAt: new Date(s.birthtimeMs || s.mtimeMs),
        upstream: 'unknown',
        metadata: { branchPath, mode: entry.includes('.ro.') ? 'hardlink-ro' : 'copy' },
      });
    }
    return handles;
  }

  async isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean> {
    const validation = await this.validate(pool);
    return validation.ok;
  }
}

function stripFileScheme(path: string): string {
  if (path.startsWith('file://')) return path.slice('file://'.length);
  return path;
}
