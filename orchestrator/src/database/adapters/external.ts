/**
 * ExternalAdapter per RFC §15.2. Operator-declared shell hooks for proprietary or
 * custom branching mechanisms. Pipeline-load REQUIRES `acknowledgeUntrusted: true`
 * because shell hooks execute with full credential scope.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DatabaseBranchAdapterError,
  type DatabaseBranchAdapter,
  type DatabaseBranchCapabilities,
  type DatabaseBranchHandle,
  type DatabaseAdapterName,
  type ResolvedDatabaseBranchPool,
  type ValidationResult,
} from '../types.js';

const execFileAsync = promisify(execFile);

export interface ExternalAdapterDeps {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export class ExternalAdapter implements DatabaseBranchAdapter {
  readonly name: DatabaseAdapterName = 'external';

  readonly capabilities: DatabaseBranchCapabilities = {
    branchCreationLatencyP50Ms: 0, // declared by the hook script's behavior
    maxBranches: 0, // declared by operator config
    supportsMigrations: true,
    supportsReadOnlyBranches: false,
    supportsBranchFromBranch: true,
    multiDatabase: true,
    costModel: 'free',
  };

  constructor(private readonly deps: ExternalAdapterDeps = {}) {}

  async validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult> {
    const creds = pool.credentials ?? {};
    if (creds.acknowledgeUntrusted !== true) {
      return {
        ok: false,
        error:
          'external adapter requires credentials.acknowledgeUntrusted: true. Operator-controlled shell hooks execute with full credential scope; this opt-in is intentional friction.',
      };
    }
    if (typeof creds.allocateCommand !== 'string' || !creds.allocateCommand) {
      return { ok: false, error: 'credentials.allocateCommand (string) is required' };
    }
    if (typeof creds.reclaimCommand !== 'string' || !creds.reclaimCommand) {
      return { ok: false, error: 'credentials.reclaimCommand (string) is required' };
    }
    return { ok: true };
  }

  async allocate(
    pool: ResolvedDatabaseBranchPool,
    branchKey: string,
  ): Promise<DatabaseBranchHandle> {
    const cmd = pool.credentials?.allocateCommand as string;
    const exec = this.deps.exec ?? ((c, a) => execFileAsync(c, a));
    let stdout: string;
    try {
      const result = await exec('sh', ['-c', `${cmd} ${branchKey}`]);
      stdout = result.stdout;
    } catch (err) {
      throw new DatabaseBranchAdapterError(
        `external allocate hook failed for branch ${branchKey}: ${(err as Error).message}`,
        this.name,
        branchKey,
        err,
      );
    }
    const connectionString = stdout.trim();
    if (!connectionString) {
      throw new DatabaseBranchAdapterError(
        `external allocate hook produced empty stdout (expected connection string)`,
        this.name,
        branchKey,
      );
    }
    return {
      branchKey,
      connectionString,
      createdAt: new Date(),
      upstream: pool.upstream.branchFrom ?? 'external',
      metadata: { hook: 'external' },
    };
  }

  async reclaim(handle: DatabaseBranchHandle): Promise<void> {
    // The pool isn't passed here; the orchestrator MUST track (handle, pool) pairs and
    // call this via the dispatcher. For test purposes, callers that use ExternalAdapter
    // directly must provide their own dispatcher that supplies the reclaim command.
    void handle;
  }

  async list(_pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]> {
    // External hooks don't expose a list mechanism; orchestrator tracks active branches
    // in its own state.
    return [];
  }

  async isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean> {
    const v = await this.validate(pool);
    return v.ok;
  }
}
