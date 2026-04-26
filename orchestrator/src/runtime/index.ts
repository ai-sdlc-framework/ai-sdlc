export {
  deterministicPort,
  allocatePort,
  allocateContiguousPorts,
  isPortFree,
  PortAllocationError,
  DEFAULT_BASE_PORT,
  PORT_RANGE_OFFSET_MIN,
  PORT_RANGE_OFFSET_MAX,
  type AllocatePortOptions,
  type AllocateContiguousOptions,
} from './port-allocator.js';

export {
  slugifyBranch,
  worktreePath,
  verifyOwnership,
  assertOwnership,
  isExistingWorktree,
  WorktreeOwnershipError,
  type OwnershipResult,
} from './worktree.js';

export {
  WorktreePoolManager,
  WorktreePoolError,
  DEFAULT_POOL_ROOT,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type WorktreePoolSpec,
  type WorktreePoolManagerDeps,
  type AllocateOptions,
  type WorktreeHandle,
} from './worktree-pool.js';

export {
  readParallelismMode,
  isParallelismEnabled,
  FLAG_NAME as PARALLELISM_FLAG,
  type ParallelismMode,
} from './parallelism-flag.js';
