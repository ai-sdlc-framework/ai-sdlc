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
