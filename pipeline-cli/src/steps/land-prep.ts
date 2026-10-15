/**
 * land-prep (AISDLC-881, RFC-0054 OQ-7) — the one deterministic runner for the
 * mechanical landing path: fetch + rebase onto the integration branch, drop a
 * stale attestation envelope, lease push so the pre-push hook re-signs, and a
 * guarded draft-to-ready flip. Called by Step 11 (rebase only, before its first
 * push) and by `cli-pr land-prep` (the state machine's skew actions and the
 * executor's last act).
 *
 * Never bypasses a hook: it refuses to run with any `AI_SDLC_SKIP_*` or
 * `AI_SDLC_BYPASS_ALL_GATES` variable in the environment.
 *
 * @module steps/land-prep
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { lateRebase } from './11-late-rebase.js';

export interface LandPrepOptions {
  /** Absolute path to the PR's worktree. */
  worktreePath: string;
  /** The PR's head branch (own task branch only). */
  branch: string;
  /** Integration branch to rebase onto; defaults to `main`. */
  targetBranch?: string;
  /** Lease push after the rebase. Step 11 passes false: it pushes itself. */
  push?: boolean;
  runner?: Runner;
  /** Environment to inspect for hook skips; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LandPrepResult {
  ok: boolean;
  /** True when a lease push was made. */
  pushed: boolean;
  /** True when the rebase changed HEAD. */
  rebased: boolean;
  conflictingFiles: string[];
  /** Envelope files removed because their subject no longer descends into HEAD. */
  droppedEnvelopes: string[];
  /** Mechanically resolved files (non-empty means the envelope content hash shifted). */
  resolvedFiles: string[];
  reason?: string;
}

const SKIP_VAR = /^AI_SDLC_(SKIP_.*|BYPASS_ALL_GATES)$/;

/** Names of hook-skip variables set in `env`. */
export function hookSkipVars(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => SKIP_VAR.test(k) && env[k] !== undefined && env[k] !== '');
}

const fail = (reason: string, extra: Partial<LandPrepResult> = {}): LandPrepResult => ({
  ok: false,
  pushed: false,
  rebased: false,
  conflictingFiles: [],
  droppedEnvelopes: [],
  resolvedFiles: [],
  reason,
  ...extra,
});

/** Subject commit sha of a DSSE envelope, or null when unreadable. */
function envelopeSubjectSha(file: string): string | null {
  try {
    const env = JSON.parse(readFileSync(file, 'utf8')) as { payload?: string };
    if (!env.payload) return null;
    const stmt = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as {
      subject?: Array<{ digest?: { sha1?: string } }>;
    };
    return stmt.subject?.[0]?.digest?.sha1 ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove (and commit the removal of) envelopes whose subject commit is no longer
 * an ancestor of HEAD, so the pre-push hook signs a fresh one. Returns removed paths.
 */
async function dropStaleEnvelopes(runner: Runner, cwd: string): Promise<string[]> {
  const dir = join(cwd, '.ai-sdlc', 'attestations');
  if (!existsSync(dir)) return [];
  const dropped: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.dsse.json'))) {
    const sha = envelopeSubjectSha(join(dir, name));
    if (!sha) continue;
    const anc = await runner('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd,
      allowFailure: true,
    });
    if (anc.code === 0) continue;
    const rel = `.ai-sdlc/attestations/${name}`;
    const rm = await runner('git', ['rm', '-q', '--', rel], { cwd, allowFailure: true });
    if (rm.code === 0) dropped.push(rel);
  }
  if (dropped.length > 0) {
    await runner(
      'git',
      [
        'commit',
        '-q',
        '-m',
        'chore(attestation): drop stale envelope after rebase (AISDLC-881)\n\nThe pre-push hook signs a fresh envelope.\n',
      ],
      { cwd, allowFailure: true },
    );
  }
  return dropped;
}

/** Rebase, drop stale envelope, and (optionally) lease push so the hook re-signs. */
export async function landPrep(opts: LandPrepOptions): Promise<LandPrepResult> {
  const runner = opts.runner ?? defaultRunner;
  const cwd = opts.worktreePath;
  const skips = opts.push === false ? [] : hookSkipVars(opts.env ?? process.env);
  if (skips.length > 0) {
    return fail(`refusing to run with hook-skip variables set (${skips.join(', ')}); unset them`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.branch) || opts.branch.includes('..')) {
    return fail(`malformed branch name '${opts.branch}'`);
  }

  const before = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const remote = await runner(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${opts.branch}`],
    { cwd, allowFailure: true },
  );
  const rebase = await lateRebase({
    worktreePath: cwd,
    runner,
    ...(opts.targetBranch ? { targetBranch: opts.targetBranch } : {}),
  });
  if (!rebase.ok) {
    return fail(rebase.reason ?? 'rebase failed', { conflictingFiles: rebase.conflictingFiles });
  }
  const afterRebase = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const rebased = afterRebase !== before;
  const droppedEnvelopes = rebased ? await dropStaleEnvelopes(runner, cwd) : [];
  const base = { rebased, droppedEnvelopes, resolvedFiles: rebase.resolvedFiles };
  if (opts.push === false) return { ok: true, pushed: false, conflictingFiles: [], ...base };

  const leaseSha = remote.code === 0 ? remote.stdout.trim() : '';
  if (!leaseSha) {
    return fail(
      `origin/${opts.branch} is unknown locally, so the lease has no expected value`,
      base,
    );
  }
  const push = () =>
    runner(
      'git',
      [
        'push',
        '-u',
        `--force-with-lease=refs/heads/${opts.branch}:${leaseSha}`,
        'origin',
        `HEAD:refs/heads/${opts.branch}`,
      ],
      { cwd, allowFailure: true },
    );
  let result = await push();
  if (result.code !== 0) {
    // The pre-push hook signs, commits the envelope and exits 1 asking for a re-run.
    const head = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    const settled = head !== (rebased ? afterRebase : before) || droppedEnvelopes.length > 0;
    if (settled) result = await push();
  }
  if (result.code !== 0) {
    return fail(`git push failed: ${result.stderr.trim() || result.stdout.trim()}`, base);
  }
  return { ok: true, pushed: true, conflictingFiles: [], ...base };
}

// ── Guarded ready flip ───────────────────────────────────────────────────────

export interface FlipOptions {
  prNumber: number;
  worktreePath: string;
  taskId: string;
  runner?: Runner;
}

export interface FlipResult {
  ok: boolean;
  /** The unmet condition, named, when `ok` is false. */
  reason?: string;
}

function readJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Flip a draft PR to ready, failing closed: CodeQL green on the head, an approved
 * aggregate verdict file, and no outstanding CHANGES_REQUESTED review.
 */
export async function flipReady(opts: FlipOptions): Promise<FlipResult> {
  const runner = opts.runner ?? defaultRunner;
  const cwd = opts.worktreePath;
  const api = (args: string[]) => runner('gh', ['api', ...args], { cwd, allowFailure: true });
  const pull = `repos/:owner/:repo/pulls/${opts.prNumber}`;

  const pr = await api([pull]);
  const prInfo =
    pr.code === 0 ? readJson<{ draft?: boolean; head?: { sha?: string } }>(pr.stdout) : null;
  const sha = prInfo?.head?.sha;
  if (!prInfo || !sha) return { ok: false, reason: `cannot read PR #${opts.prNumber} from GitHub` };

  const verdictFile = join(cwd, '.ai-sdlc', 'verdicts', `${opts.taskId.toLowerCase()}.json`);
  const verdict = existsSync(verdictFile)
    ? readJson<{ approved?: boolean; decision?: string }>(readFileSync(verdictFile, 'utf8'))
    : null;
  if (
    !verdict ||
    verdict.approved !== true ||
    (verdict.decision !== undefined && verdict.decision !== 'APPROVED')
  ) {
    return { ok: false, reason: `verdict not approved (${verdictFile})` };
  }

  const runs = await api([`repos/:owner/:repo/commits/${sha}/check-runs`, '--paginate']);
  const parsed =
    runs.code === 0
      ? readJson<{ check_runs?: Array<{ name: string; conclusion: string | null }> }>(runs.stdout)
      : null;
  const codeql = parsed?.check_runs?.filter((c) => /^codeql/i.test(c.name)) ?? [];
  if (codeql.length === 0 || !codeql.every((c) => c.conclusion === 'success')) {
    return { ok: false, reason: `CodeQL is not green on ${sha.slice(0, 7)}` };
  }

  const rv = await api([`${pull}/reviews`, '--paginate']);
  const reviews =
    rv.code === 0 ? readJson<Array<{ user?: { login?: string }; state: string }>>(rv.stdout) : null;
  if (!reviews) return { ok: false, reason: 'cannot read reviews' };
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(r.user?.login ?? '', r.state);
  }
  if ([...latest.values()].includes('CHANGES_REQUESTED')) {
    return { ok: false, reason: 'a CHANGES_REQUESTED review is outstanding' };
  }

  if (prInfo.draft === false) return { ok: true };
  const patch = await api(['-X', 'PATCH', pull, '-F', 'draft=false']);
  const after = patch.code === 0 ? readJson<{ draft?: boolean }>(patch.stdout) : null;
  if (after?.draft === false) return { ok: true };
  // REST does not always honour `draft`; fall back to the sanctioned ready command.
  const ready = await runner('gh', ['pr', 'ready', String(opts.prNumber)], {
    cwd,
    allowFailure: true,
  });
  return ready.code === 0
    ? { ok: true }
    : { ok: false, reason: `flip failed: ${ready.stderr.trim() || patch.stderr.trim()}` };
}
