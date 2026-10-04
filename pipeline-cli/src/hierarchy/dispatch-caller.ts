/**
 * The mistake guard every dispatch-authority command runs first, shared by
 * `cli-hierarchy` and `cli-dispatch requeue`.
 *
 * It stops a session from using the dispatch commands by mistake: an executor that
 * runs `tick`, or a stray `--board-dir` that points at the wrong board. It is not
 * authentication. A session running as the same user can still defeat it, for
 * example with a scratch repository holding a forged roster and policy, a copy of
 * the command, or git redirection. Closing that needs the hook-level deny for
 * executor roles.
 *
 * What it checks, in order: the working directory is a verifiable main checkout;
 * `--board-dir` and `--work-dir` are that checkout's own; the command is running
 * from a module installed inside that same checkout; and the calling session, found
 * from the roster of that checkout's board, is the running dispatch session.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSystemIdentity,
  requireDispatchCaller,
  type CallerCheck,
  type IdentityDeps,
} from './caller-identity.js';
import { realpathLoose, resolveTrustedBoard } from './trusted-root.js';

/** Inputs of {@link checkDispatchCaller}. */
export interface DispatchCallerInputs {
  /** Command name used in refusal messages, for example `cli-hierarchy tick`. */
  label: string;
  /** Working directory of the process. */
  cwd: string;
  /** The `--board-dir` value in effect. */
  boardDir: string;
  /** The `--work-dir` flag, when given. */
  workDir?: string;
  /** The `--worker` flag, when given. */
  worker?: string;
  /** Replaces the roster and process lookups (tests). */
  identity?: IdentityDeps;
  /**
   * Replaces only the process lookups (parent pid, command name, start pid) while the
   * roster is still read from the trusted board (tests; not reachable from a bin).
   */
  processLookup?: Partial<Pick<IdentityDeps, 'parentPid' | 'comm' | 'startPid'>>;
  /**
   * Replaces the git lookup of the main checkout and its board (tests). When
   * `identity` is injected without this, the location checks are skipped.
   */
  trustedBoard?: { root: string; boardDir: string } | null;
  /**
   * Directory of the running module, for the install-location check. Absent means
   * the real one, derived from `import.meta.url`; `null` means it cannot be
   * determined (tests). Never derived from argv, cwd or the environment.
   */
  installDir?: string | null;
}

/** Directory of this module, or null when it cannot be determined. */
export function defaultInstallDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/** True when `child` is `root` or inside it. */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Accept the caller only when the location checks pass and it is the running dispatch session. */
export function checkDispatchCaller(i: DispatchCallerInputs): CallerCheck {
  const skipLocation = i.identity !== undefined && i.trustedBoard === undefined;
  let identityBoard = i.boardDir;
  if (!skipLocation) {
    const trusted = i.trustedBoard !== undefined ? i.trustedBoard : resolveTrustedBoard(i.cwd);
    if (!trusted) {
      return { ok: false, reason: `${i.label}: refused; the main checkout could not be verified` };
    }
    if (realpathLoose(i.boardDir) !== realpathLoose(trusted.boardDir)) {
      return {
        ok: false,
        reason: `${i.label}: refused; --board-dir is not the main checkout's dispatch board`,
      };
    }
    if (realpathLoose(path.resolve(i.workDir ?? i.cwd)) !== realpathLoose(trusted.root)) {
      return {
        ok: false,
        reason: `${i.label}: refused; the working directory is not the main checkout`,
      };
    }
    const install = i.installDir !== undefined ? i.installDir : defaultInstallDir();
    if (install === null || !isInside(realpathLoose(install), realpathLoose(trusted.root))) {
      return {
        ok: false,
        reason: `${i.label}: refused; the command is not running from the main checkout's install`,
      };
    }
    identityBoard = trusted.boardDir;
  }
  return requireDispatchCaller(
    i.identity ?? createSystemIdentity(identityBoard, i.processLookup),
    i.worker,
    i.label,
  );
}
