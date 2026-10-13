/**
 * The file scope a probe with file tools runs in.
 *
 * A probe that is given Read, Grep or Glob may open only the files the executor
 * named in `allowedPaths`, as committed. The executor's list is a request; this
 * module is what makes it true. It builds a throwaway directory that holds fresh
 * copies of exactly those files, read from the pinned head commit's tree, and the
 * probe is run with that directory as its working directory and nothing else.
 *
 *   - Only a regular file in the head commit's tree is copied. A path that is not
 *     there (untracked, gitignored such as `.env`, deleted), or that is a symlink or
 *     gitlink in the tree, makes the whole probe refuse: nothing is run.
 *   - Copies are new files in a new directory, so a symlink or hard link in the
 *     repository can never reach back into it.
 *   - The working tree is never read, so uncommitted edits and untracked files are
 *     invisible to the probe.
 *
 * The caller also runs the probe so that its file tools are confined to this
 * directory (see `probe-spawner.ts`); this module does not trust the tool ceiling
 * in an agent's frontmatter for any of it.
 *
 * @module review-staged/probe-sandbox
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  listRegularFilesAtCommit,
  readBlobAtCommit,
  resolvePinnedHead,
  runGit,
  type GitRunner,
} from '../review-plan/executor-git.js';
import { isSafeRelativePath } from '../review-plan/validate.js';

/** Most files one sandbox will hold. The executor's own cap is lower. */
export const MAX_SANDBOX_FILES = 5000;
/** Most bytes one file contributes to a sandbox. A longer file is cut at a line. */
export const MAX_SANDBOX_FILE_BYTES = 1_048_576;
/** Most bytes one sandbox holds in total. */
export const MAX_SANDBOX_TOTAL_BYTES = 33_554_432;

/** Thrown when a probe's file scope cannot be honoured. The probe must not run. */
export class ProbeScopeError extends Error {}

export interface ProbeSandbox {
  /** Absolute path of the directory the probe runs in. */
  root: string;
  /** The paths copied into it, repo-relative with `/` separators. */
  files: string[];
  /** Removes the directory. Never throws. */
  cleanup(): Promise<void>;
}

export interface SandboxOpts {
  /** The repository the committed content is read from. */
  repoRoot: string;
  /** Test injection. Defaults to `git` with a scrubbed environment. */
  git?: GitRunner;
  /** Parent directory for the sandbox. Defaults to the OS temp directory. */
  parentDir?: string;
}

async function makeRoot(parentDir: string | undefined): Promise<string> {
  return mkdtemp(join(parentDir ?? tmpdir(), 'ai-sdlc-probe-'));
}

function cleanupFor(root: string): () => Promise<void> {
  return async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      /* the directory is scratch; a failed delete is not a review failure */
    }
  };
}

/** A directory with nothing in it, for a probe that holds no file tools. */
export async function createEmptySandbox(
  opts: Pick<SandboxOpts, 'parentDir'> = {},
): Promise<ProbeSandbox> {
  const root = await makeRoot(opts.parentDir);
  return { root, files: [], cleanup: cleanupFor(root) };
}

/**
 * Copy `allowedPaths`, as committed at the pinned head, into a new directory.
 * Throws {@link ProbeScopeError} (after removing the directory) when any path cannot
 * be served from the committed tree as a regular file.
 */
export async function createScopedSandbox(
  allowedPaths: readonly string[],
  opts: SandboxOpts,
): Promise<ProbeSandbox> {
  const git = opts.git ?? runGit;
  const paths = [...new Set(allowedPaths)];
  if (paths.length > MAX_SANDBOX_FILES) {
    throw new ProbeScopeError(
      `the file scope holds ${paths.length} paths, over ${MAX_SANDBOX_FILES}`,
    );
  }
  for (const p of paths) {
    if (!isSafeRelativePath(p)) throw new ProbeScopeError('the file scope names an unsafe path');
  }
  const head = await resolvePinnedHead(git, opts.repoRoot);
  if (head === undefined) throw new ProbeScopeError('HEAD could not be resolved to a commit');

  // One listing decides which paths are regular files in the commit, so a path git would
  // serve as a symlink, gitlink or tree is refused before anything is written.
  let regular: Set<string>;
  try {
    regular = new Set(await listRegularFilesAtCommit(git, opts.repoRoot, head));
  } catch {
    throw new ProbeScopeError('the committed tree could not be listed');
  }
  const notCommitted = paths.filter((p) => !regular.has(p));
  if (notCommitted.length > 0) {
    throw new ProbeScopeError(
      `${notCommitted.length} path(s) in the file scope are not regular files in the head commit`,
    );
  }

  const root = await makeRoot(opts.parentDir);
  const cleanup = cleanupFor(root);
  try {
    let total = 0;
    for (const p of [...paths].sort()) {
      const dest = resolve(root, p);
      const rel = relative(root, dest);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new ProbeScopeError('a path in the file scope escapes the sandbox');
      }
      const blob = await readBlobAtCommit(git, opts.repoRoot, head, p, MAX_SANDBOX_FILE_BYTES);
      if (blob.kind !== 'ok') {
        throw new ProbeScopeError('a path in the file scope could not be read from the commit');
      }
      total += blob.bytesRead;
      if (total > MAX_SANDBOX_TOTAL_BYTES) {
        throw new ProbeScopeError('the file scope is larger than the sandbox allows');
      }
      await mkdir(dirname(dest), { recursive: true });
      // `wx`: never overwrite, never follow. Read-only so the probe cannot rewrite it.
      await writeFile(dest, blob.text, { flag: 'wx', mode: 0o444 });
    }
  } catch (err) {
    await cleanup();
    throw err instanceof ProbeScopeError
      ? err
      : new ProbeScopeError('the file scope could not be materialised');
  }
  return { root, files: [...paths].sort(), cleanup };
}
