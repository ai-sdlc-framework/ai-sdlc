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
 * `--board-dir` and `--work-dir` are that checkout's own; the command's own install
 * location (see below); and the calling session, found from the roster of that
 * checkout's board, is the running dispatch session.
 *
 * Install location. The real path of the running module is looked up in git. If it
 * is inside a git work tree, that work tree must be the main checkout, so a copy
 * in a task worktree, a scratch repository or any other repository is refused. If it
 * is not inside any work tree (a global install, the plugin cache), the check is
 * skipped, because there is no checkout to compare against: installed layouts get the
 * weaker guard. A path that cannot be resolved, or a git failure other than "not a
 * repository", is refused.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALLER_NEXT_STEP,
  createSystemIdentity,
  requireDispatchCaller,
  type CallerCheck,
  type IdentityDeps,
} from './caller-identity.js';
import { stripGitRedirects } from './git-env.js';
import { realpathLoose, resolveTrustedBoard } from './trusted-root.js';

/** Result of one git probe: exit status (null when it could not run), stdout and stderr. */
export interface GitProbe {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git with the given arguments in a directory; injectable for tests. */
export type InstallGit = (args: readonly string[], cwd: string) => GitProbe;

/** Production probe: argv only, no shell, short timeout, redirect variables stripped, English messages. */
export const defaultInstallGit: InstallGit = (args, cwd) => {
  const r = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 2000,
    env: { ...stripGitRedirects(process.env), LC_ALL: 'C' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

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
  /** Replaces the git probe used to find the work tree that contains the install (tests). */
  installGit?: InstallGit;
}

/** Directory of this module, or null when it cannot be determined. */
export function defaultInstallDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * True when the install location is acceptable: not inside any git work tree (the
 * check is skipped), or inside exactly the main checkout. False when it cannot be
 * resolved, git fails for any reason but "not a repository", or the work tree
 * containing it is some other repository.
 */
function installLocationOk(install: string | null, mainRoot: string, git: InstallGit): boolean {
  if (install === null) return false;
  let real: string;
  try {
    real = realpathSync(install);
  } catch {
    return false;
  }
  const probe = git(['rev-parse', '--show-toplevel'], real);
  if (probe.status === 0) {
    const top = probe.stdout.trim();
    return top !== '' && realpathLoose(top) === realpathLoose(mainRoot);
  }
  return probe.status === 128 && /not a git repository/i.test(probe.stderr);
}

/** Accept the caller only when the location checks pass and it is the running dispatch session. */
export function checkDispatchCaller(i: DispatchCallerInputs): CallerCheck {
  const skipLocation = i.identity !== undefined && i.trustedBoard === undefined;
  let identityBoard = i.boardDir;
  if (!skipLocation) {
    const trusted = i.trustedBoard !== undefined ? i.trustedBoard : resolveTrustedBoard(i.cwd);
    if (!trusted) {
      return {
        ok: false,
        reason: `${i.label}: refused; the main checkout could not be verified; ${CALLER_NEXT_STEP}`,
      };
    }
    if (realpathLoose(i.boardDir) !== realpathLoose(trusted.boardDir)) {
      return {
        ok: false,
        reason: `${i.label}: refused; --board-dir is not the main checkout's dispatch board; omit --board-dir, or ${CALLER_NEXT_STEP}`,
      };
    }
    if (realpathLoose(path.resolve(i.workDir ?? i.cwd)) !== realpathLoose(trusted.root)) {
      return {
        ok: false,
        reason: `${i.label}: refused; the working directory is not the main checkout; ${CALLER_NEXT_STEP}`,
      };
    }
    const install = i.installDir !== undefined ? i.installDir : defaultInstallDir();
    if (!installLocationOk(install, trusted.root, i.installGit ?? defaultInstallGit)) {
      return {
        ok: false,
        reason: `${i.label}: refused; the command is not running from the main checkout's install; ${CALLER_NEXT_STEP}`,
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
