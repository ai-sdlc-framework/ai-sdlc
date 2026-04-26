/**
 * DatabaseBranchAdapter framework per RFC-0010 §15. Each adapter abstracts a database
 * branching mechanism; the orchestrator allocates a branch per worktree, injects the
 * branch's connection string into the agent's environment, and reclaims on PR merge.
 */

export type DatabaseAdapterName =
  | 'sqlite-copy'
  | 'neon'
  | 'pg-snapshot-restore'
  | 'supabase'
  | 'external';

export interface DatabaseBranchCapabilities {
  branchCreationLatencyP50Ms: number;
  maxBranches: number;
  supportsMigrations: boolean;
  supportsReadOnlyBranches: boolean;
  supportsBranchFromBranch: boolean;
  multiDatabase: boolean;
  costModel: 'per-branch-storage' | 'per-snapshot' | 'free';
}

export interface DatabaseBranchHandle {
  /** Stable key derived from the worktree branch name. */
  branchKey: string;
  /**
   * Connection URL the agent will use. NEVER logged in cleartext per RFC §15.1
   * (security review property — adapters MUST mask credentials in any error returned).
   */
  connectionString: string;
  createdAt: Date;
  /** Upstream branch the handle was derived from. */
  upstream: string;
  upstreamCommitId?: string;
  /** Adapter-specific metadata (Neon: branch_id; pg-snapshot-restore: snapshot id). */
  metadata: Record<string, string>;
}

export interface ResolvedDatabaseBranchPool {
  name: string;
  adapter: DatabaseAdapterName;
  upstream: {
    connectionStringEnv: string;
    branchFrom?: string;
  };
  injection: {
    targetEnv: string;
    additionalEnvs?: string[];
  };
  lifecycle?: {
    createOn?: 'worktree-allocation' | 'first-write-stage';
    reclaimOn?: 'pr-merge' | 'worktree-reclaim' | 'manual';
    maxConcurrent?: number;
    branchTtl?: string;
    abandonAfter?: string;
    warmPoolSize?: number;
  };
  allowBranchFromBranch?: boolean;
  migrations?: {
    runOnBranchCreate?: boolean;
    migrationCommand?: string;
    migrationCwd?: string;
  };
  credentials?: Record<string, unknown>;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export interface DatabaseBranchAdapter {
  readonly name: DatabaseAdapterName;
  readonly capabilities: DatabaseBranchCapabilities;

  /** Pipeline-load validation; checks credentials + adapter-specific config. */
  validate(pool: ResolvedDatabaseBranchPool): Promise<ValidationResult>;

  /** Provision a new branch from the pool's upstream. */
  allocate(pool: ResolvedDatabaseBranchPool, branchKey: string): Promise<DatabaseBranchHandle>;

  /** Destroy a branch and free its quota slot. */
  reclaim(handle: DatabaseBranchHandle): Promise<void>;

  /** Enumerate currently active branches (for stale-branch sweep on startup). */
  list(pool: ResolvedDatabaseBranchPool): Promise<DatabaseBranchHandle[]>;

  /** Cheap liveness probe. */
  isAvailable(pool: ResolvedDatabaseBranchPool): Promise<boolean>;
}

export class DatabaseBranchAdapterError extends Error {
  constructor(
    message: string,
    public readonly adapter: DatabaseAdapterName,
    public readonly branchKey?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseBranchAdapterError';
  }
}

export class BranchTopologyForbiddenError extends Error {
  constructor(
    message: string,
    public readonly poolName: string,
  ) {
    super(message);
    this.name = 'BranchTopologyForbiddenError';
  }
}

export type DatabaseAccess = 'none' | 'read' | 'write' | 'migrate';
