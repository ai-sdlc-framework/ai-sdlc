/**
 * NeonAdapter per RFC §15.2. Wraps Neon REST API for branch lifecycle. Phase 6 ships
 * the adapter shell + capability matrix + validation; the actual REST calls (allocate,
 * reclaim, list) are stubbed until end-to-end integration testing against a real Neon
 * sandbox project lands as a follow-up.
 *
 * Operators wire this up via:
 *   credentials:
 *     apiTokenEnv: NEON_API_TOKEN
 *     projectId: prj_abc123
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

export interface NeonAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Override for tests; replaces the actual fetch calls. */
  api?: {
    createBranch: (
      projectId: string,
      branchName: string,
      parentBranch: string,
    ) => Promise<{ branchId: string; connectionString: string }>;
    deleteBranch: (projectId: string, branchId: string) => Promise<void>;
    listBranches: (
      projectId: string,
    ) => Promise<
      Array<{ branchId: string; branchName: string; parent: string; createdAt: string }>
    >;
  };
}

export class NeonAdapter implements DatabaseBranchAdapter {
  readonly name: DatabaseAdapterName = 'neon';

  readonly capabilities: DatabaseBranchCapabilities = {
    branchCreationLatencyP50Ms: 1500,
    maxBranches: 5000,
    supportsMigrations: true,
    supportsReadOnlyBranches: true,
    supportsBranchFromBranch: true,
    multiDatabase: false,
    costModel: 'per-branch-storage',
  };

  constructor(private readonly deps: NeonAdapterDeps = {}) {}

  async validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult> {
    const env = this.deps.env ?? process.env;
    const creds = pool.credentials ?? {};
    const apiTokenEnv = creds.apiTokenEnv as string | undefined;
    const projectId = creds.projectId as string | undefined;

    if (!apiTokenEnv) {
      return { ok: false, error: 'credentials.apiTokenEnv is required for neon adapter' };
    }
    if (!env[apiTokenEnv]) {
      return {
        ok: false,
        error: `${apiTokenEnv} is not set in env; cannot authenticate against Neon API`,
      };
    }
    if (!projectId) {
      return { ok: false, error: 'credentials.projectId is required for neon adapter' };
    }
    if (!pool.upstream.branchFrom) {
      return {
        ok: false,
        error: 'upstream.branchFrom is required for neon (named branch to fork from)',
      };
    }
    return { ok: true };
  }

  async allocate(
    pool: ResolvedDatabaseBranchPool,
    branchKey: string,
  ): Promise<DatabaseBranchHandle> {
    if (!this.deps.api) {
      throw new DatabaseBranchAdapterError(
        'NeonAdapter.allocate is not wired against the live Neon REST API yet (Phase 6 follow-up). ' +
          'Tests should inject deps.api; production deployments require the integration test pass before use.',
        this.name,
        branchKey,
      );
    }
    const projectId = pool.credentials?.projectId as string;
    const parent = pool.upstream.branchFrom!;
    const result = await this.deps.api.createBranch(projectId, branchKey, parent);
    return {
      branchKey,
      connectionString: result.connectionString,
      createdAt: new Date(),
      upstream: parent,
      metadata: { branchId: result.branchId, projectId },
    };
  }

  async reclaim(handle: DatabaseBranchHandle): Promise<void> {
    if (!this.deps.api) {
      throw new DatabaseBranchAdapterError(
        'NeonAdapter.reclaim not wired (Phase 6 follow-up)',
        this.name,
        handle.branchKey,
      );
    }
    const projectId = handle.metadata.projectId;
    const branchId = handle.metadata.branchId;
    if (!projectId || !branchId) {
      throw new DatabaseBranchAdapterError(
        `handle missing projectId/branchId in metadata: ${JSON.stringify(handle.metadata)}`,
        this.name,
        handle.branchKey,
      );
    }
    await this.deps.api.deleteBranch(projectId, branchId);
  }

  async list(pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]> {
    if (!this.deps.api) return [];
    const projectId = pool.credentials?.projectId as string;
    const branches = await this.deps.api.listBranches(projectId);
    return branches.map((b) => ({
      branchKey: b.branchName,
      connectionString: '<masked — re-fetch via API>',
      createdAt: new Date(b.createdAt),
      upstream: b.parent,
      metadata: { projectId, branchId: b.branchId },
    }));
  }

  async isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean> {
    const v = await this.validate(pool);
    return v.ok;
  }
}
