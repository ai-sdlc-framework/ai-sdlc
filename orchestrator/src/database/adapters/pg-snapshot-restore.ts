/**
 * PgSnapshotRestoreAdapter per RFC §15.2. For vanilla Postgres or AWS RDS — uses
 * `pg_dump` + `pg_restore` for vanilla, or RDS snapshot/restore APIs for AWS.
 *
 * Phase 6 ships the adapter shell with capability matrix + validation. End-to-end
 * integration test against local Postgres in CI is a follow-up.
 */

import {
  DatabaseBranchAdapterError,
  type DatabaseBranchAdapter,
  type DatabaseBranchCapabilities,
  type DatabaseBranchHandle,
  type DatabaseAdapterName,
  type ResolvedDatabaseBranchPool,
  type ValidationResult,
} from '../types.js';

export interface PgSnapshotRestoreAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Override for tests; mocks the dump+restore execution. */
  exec?: (
    cmd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export class PgSnapshotRestoreAdapter implements DatabaseBranchAdapter {
  readonly name: DatabaseAdapterName = 'pg-snapshot-restore';

  readonly capabilities: DatabaseBranchCapabilities = {
    branchCreationLatencyP50Ms: 30_000,
    maxBranches: 100,
    supportsMigrations: true,
    supportsReadOnlyBranches: false,
    supportsBranchFromBranch: false,
    multiDatabase: false,
    costModel: 'per-snapshot',
  };

  constructor(private readonly deps: PgSnapshotRestoreAdapterDeps = {}) {}

  async validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult> {
    const env = this.deps.env ?? process.env;
    const creds = pool.credentials ?? {};
    const adminEnv = creds.adminConnectionStringEnv as string | undefined;
    const storageVolume = creds.storageVolume as string | undefined;

    if (!adminEnv) {
      return {
        ok: false,
        error: 'credentials.adminConnectionStringEnv is required (privileged user with CREATEDB)',
      };
    }
    if (!env[adminEnv]) {
      return { ok: false, error: `${adminEnv} not set in env` };
    }
    if (!storageVolume) {
      return {
        ok: false,
        error: 'credentials.storageVolume is required (where snapshots are restored)',
      };
    }
    return { ok: true };
  }

  async allocate(
    pool: ResolvedDatabaseBranchPool,
    branchKey: string,
  ): Promise<DatabaseBranchHandle> {
    if (!this.deps.exec) {
      throw new DatabaseBranchAdapterError(
        'PgSnapshotRestoreAdapter.allocate not wired (Phase 6 follow-up against fixture Postgres in CI)',
        this.name,
        branchKey,
      );
    }
    // Placeholder — actual implementation: pg_dump from upstream, createdb branch_<key>, pg_restore into branch.
    throw new DatabaseBranchAdapterError(
      'PgSnapshotRestoreAdapter integration pending',
      this.name,
      branchKey,
    );
  }

  async reclaim(handle: DatabaseBranchHandle): Promise<void> {
    if (!this.deps.exec) return;
    // Placeholder — actual: dropdb branch_<key>
    void handle;
  }

  async list(_pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]> {
    // Placeholder — actual: query pg_database for branch_-prefixed databases.
    return [];
  }

  async isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean> {
    const v = await this.validate(pool);
    return v.ok;
  }
}
