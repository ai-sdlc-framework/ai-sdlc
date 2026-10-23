/**
 * Peer-binding guards for the session skills (executor, planner, dispatch).
 *
 * Two hierarchies of different projects can run on one machine, and peer messages
 * resolve names across the whole machine. This check keeps a session from acting on
 * a working directory that belongs to another project:
 *
 * - {@link checkRepoMatch}: before repository work, the session's working directory
 *   must be in the repository that owns this roster's board.
 *
 * This is a mistake guard in the DEC-0038 sense, not authentication: a session running
 * as the same user can still forge a pid or write a roster.
 */

import path from 'node:path';

import { mainCheckoutRoot, realpathLoose, runGit, type GitRunner } from './trusted-root.js';
import type { RosterEntry } from './types.js';

/** Result of {@link checkRepoMatch}. */
export type RepoCheck = { ok: true; project: string } | { ok: false; reason: string };

/**
 * Check that `cwd` is inside the repository that owns the board (and so the roster)
 * this session belongs to. The board lives at `<repo>/.ai-sdlc/dispatch`; the working
 * directory's repository is its main checkout (a task worktree resolves to the
 * checkout it was created from).
 */
export function checkRepoMatch(input: {
  cwd: string;
  boardDir: string;
  project: string;
  git?: GitRunner;
}): RepoCheck {
  const boardRoot = path.resolve(input.boardDir, '..', '..');
  const cwdRoot = mainCheckoutRoot(input.cwd, input.git ?? runGit);
  if (!cwdRoot) {
    return {
      ok: false,
      reason: `the working directory '${input.cwd}' is not inside a git repository, so it cannot be the repository of project '${input.project}' (${boardRoot}); change to that repository and run this command again`,
    };
  }
  if (realpathLoose(cwdRoot) !== realpathLoose(boardRoot)) {
    return {
      ok: false,
      reason: `this session belongs to project '${input.project}' (repository ${boardRoot}) but the working directory is in another repository (${cwdRoot}); no repository work was started. Change to ${boardRoot} and run this command again, or ask the dispatch session of this project to re-send the task`,
    };
  }
  return { ok: true, project: input.project };
}

/**
 * The single project every entry of a roster belongs to, or an error message when the
 * roster is empty or mixes projects.
 */
export function rosterProject(
  sessions: readonly Pick<RosterEntry, 'project'>[],
): { ok: true; project: string } | { ok: false; reason: string } {
  const projects = new Set(sessions.map((s) => s.project).filter((p): p is string => !!p));
  if (projects.size === 0) {
    return {
      ok: false,
      reason: 'the roster records no project; run cli-hierarchy up to rewrite it',
    };
  }
  if (projects.size > 1) {
    return {
      ok: false,
      reason: `the roster mixes projects (${[...projects].join(', ')}); run cli-hierarchy down, then cli-hierarchy up`,
    };
  }
  return { ok: true, project: [...projects][0] as string };
}
