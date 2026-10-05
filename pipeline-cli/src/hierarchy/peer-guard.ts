/**
 * Peer-binding guards for the session skills (executor, planner, dispatch).
 *
 * Two hierarchies of different projects can run on one machine, and peer messages
 * resolve names across the whole machine. These checks keep a session from acting on
 * a message or a working directory that belongs to another project:
 *
 * - {@link checkDispatchSender}: an instruction is accepted only when its sender is
 *   the dispatch session of THIS roster, compared by pid or by the harness session
 *   ref against `hierarchy.json`. The name written inside the message is never used.
 * - {@link checkRepoMatch}: before repository work, the session's working directory
 *   must be in the repository that owns this roster's board.
 *
 * This is a mistake guard in the DEC-0038 sense, not authentication: a session running
 * as the same user can still forge a pid or write a roster.
 */

import path from 'node:path';

import { mainCheckoutRoot, realpathLoose, runGit, type GitRunner } from './trusted-root.js';
import type { RosterEntry } from './types.js';

/** The one-line refusal for a sender that is not this roster's dispatch session. */
export const NOT_MY_DISPATCH = 'not my dispatch session';

/** What the harness reports about the sender of a message. Never taken from the message text. */
export interface SenderIdentity {
  pid?: number;
  /** Harness session ref (the name the harness registered, project-qualified). */
  ref?: string;
}

/** Result of {@link checkDispatchSender}. */
export type SenderCheck =
  | { ok: true; name: string; warning?: undefined }
  | { ok: true; name?: undefined; warning: string }
  | { ok: false; reason: string };

/**
 * Logged when the harness envelope carries no sender id. The check fails open here: it is
 * a mistake guard (DEC-0038), not a security boundary, and refusing every message from a
 * harness that reports no id would stop the hierarchy altogether.
 */
export const SENDER_UNVERIFIED_WARNING =
  'warning: the message envelope carries no sender pid and no sender session ref, so the sender could not be checked against the roster; accepting it (this check is a mistake guard, not authentication)';

/**
 * Accept the sender only when it is the running dispatch session of this roster.
 * A pid is compared with the entry's pid; a ref with the entry's recorded name or
 * tmux session. A sender that reports neither cannot be compared: the check fails open
 * with a warning that names what was missing. A sender that reports one and does not
 * match is refused.
 */
export function checkDispatchSender(
  sessions: readonly Pick<RosterEntry, 'role' | 'name' | 'pid' | 'status' | 'tmuxSession'>[],
  sender: SenderIdentity,
): SenderCheck {
  const refused: SenderCheck = { ok: false, reason: NOT_MY_DISPATCH };
  const hasPid = Number.isInteger(sender.pid) && (sender.pid as number) > 1;
  const hasRef = typeof sender.ref === 'string' && sender.ref !== '';
  if (!hasPid && !hasRef) return { ok: true, warning: SENDER_UNVERIFIED_WARNING };
  const dispatch = sessions.filter((s) => s.role === 'operator-dispatch' && s.status === 'running');
  for (const d of dispatch) {
    if (hasPid && d.pid === sender.pid) return { ok: true, name: d.name };
    if (hasRef && (d.name === sender.ref || d.tmuxSession === sender.ref)) {
      return { ok: true, name: d.name };
    }
  }
  return refused;
}

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
