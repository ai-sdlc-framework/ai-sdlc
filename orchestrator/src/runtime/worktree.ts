import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const SLUG_INVALID = /[^a-zA-Z0-9._-]+/g;
const SLUG_DEDUPE = /-+/g;

export class WorktreeOwnershipError extends Error {
  constructor(
    message: string,
    public readonly worktreePath: string,
    public readonly expectedClone: string,
    public readonly actualClone: string | null,
  ) {
    super(message);
    this.name = 'WorktreeOwnershipError';
  }
}

export function slugifyBranch(branch: string): string {
  if (!branch) {
    throw new Error('Branch name cannot be empty');
  }
  const slug = branch
    .replace(SLUG_INVALID, '-')
    .replace(SLUG_DEDUPE, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error(`Branch name has no slug-safe characters: ${branch}`);
  }
  return slug;
}

export function worktreePath(rootDir: string, branch: string): string {
  return join(rootDir, slugifyBranch(branch));
}

export interface OwnershipResult {
  owned: boolean;
  expectedClone: string;
  actualClone: string | null;
  reason?: 'pointer-missing' | 'pointer-malformed' | 'cross-clone' | 'ok';
}

/**
 * Verify a worktree at `worktreePath` was created from the clone at `expectedClonePath`.
 *
 * A git worktree contains a `.git` *file* (not directory) that points at the parent clone's
 * `.git/worktrees/<name>/` directory. We parse the pointer and confirm it resolves under
 * `expectedClonePath/.git/worktrees/`. Any mismatch returns owned=false with a structured reason.
 */
export async function verifyOwnership(
  worktreePathArg: string,
  expectedClonePath: string,
): Promise<OwnershipResult> {
  const expectedWorktreesDir = resolve(expectedClonePath, '.git', 'worktrees');
  const dotGitPath = join(worktreePathArg, '.git');

  let pointer: string;
  try {
    const buf = await readFile(dotGitPath);
    pointer = buf.toString('utf8').trim();
  } catch {
    return {
      owned: false,
      expectedClone: expectedWorktreesDir,
      actualClone: null,
      reason: 'pointer-missing',
    };
  }

  // Pointer file format per git docs: `gitdir: <absolute-path>` or `gitdir: <relative-path>`.
  const match = pointer.match(/^gitdir:\s*(.+)$/);
  if (!match) {
    return {
      owned: false,
      expectedClone: expectedWorktreesDir,
      actualClone: pointer || null,
      reason: 'pointer-malformed',
    };
  }
  const declared = match[1].trim();
  const declaredAbs = isAbsolute(declared) ? declared : resolve(dirname(dotGitPath), declared);
  const resolvedDeclared = resolve(declaredAbs);

  // The pointer should land inside `<expectedClone>/.git/worktrees/<name>/`.
  const owned =
    resolvedDeclared === expectedWorktreesDir ||
    resolvedDeclared.startsWith(expectedWorktreesDir + sep);

  return {
    owned,
    expectedClone: expectedWorktreesDir,
    actualClone: resolvedDeclared,
    reason: owned ? 'ok' : 'cross-clone',
  };
}

export async function assertOwnership(
  worktreePathArg: string,
  expectedClonePath: string,
): Promise<void> {
  const result = await verifyOwnership(worktreePathArg, expectedClonePath);
  if (!result.owned) {
    throw new WorktreeOwnershipError(
      `Worktree ownership verification failed for ${worktreePathArg}: ${result.reason}`,
      worktreePathArg,
      result.expectedClone,
      result.actualClone,
    );
  }
}

export async function isExistingWorktree(worktreePathArg: string): Promise<boolean> {
  try {
    const dotGit = await stat(join(worktreePathArg, '.git'));
    return dotGit.isFile();
  } catch {
    return false;
  }
}
