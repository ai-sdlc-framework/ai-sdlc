/**
 * Land every eligible own-author pull request (the `land-eligible-prs` operational
 * action, AISDLC-894), run on every dispatch tick.
 *
 * Every open, non-draft PR whose author is on the policy's `mergeAuthors` list goes
 * through `runMergeIfEligible`, the one governed merge path: it re-checks the policy on
 * main, the author, the head commit and the required checks. With GitHub auto-merge
 * available the PR is armed; without it the PR is squashed at once, once green and CLEAN.
 * This module never runs a merge command itself.
 *
 * Each landing stamps `landed` on the task's `done/` verdict. A refusal is written once
 * per head sha to `<board>/notes/`, so a standing refusal does not repeat every tick;
 * the attempt itself is repeated, because a pending check turns green later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now as clock } from '../clock.js';
import { patchDoneVerdict } from '../dispatch/board.js';
import { resolveTargetRepo, runMergeIfEligible } from '../governance/merge-if-eligible.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { prFingerprint, recordRefusal, refusalStillValid } from './pr-snapshot.js';
import { taskIdFrom } from './reconcile.js';
import type { CommandRunner } from './types.js';

/** What landing one PR came to. */
export interface LandOutcome {
  /** Squashed now. */
  merged: boolean;
  /** Auto-merge armed; GitHub merges once its checks pass. */
  armed: boolean;
  /** Why the PR was refused, or the eligibility reason. */
  reason: string;
}

/** What one pass did. */
export interface LandReport {
  /** PRs merged or armed this pass. */
  landed: { pr: number; taskId?: string; mode: 'merge' | 'arm' }[];
  /** PRs refused, with the reason. */
  refused: { pr: number; reason: string }[];
  /** Set when GitHub could not be read; nothing was attempted. */
  error?: string;
}

export interface LandDeps {
  boardDir: string;
  repoRoot: string;
  run: CommandRunner;
  /** Logins on the policy's `mergeAuthors` list. */
  mergeAuthors: readonly string[];
  /** Lands one PR in the given mode through `runMergeIfEligible`. */
  land: (pr: number, mode: 'merge' | 'arm') => Promise<LandOutcome>;
  now?: () => Date;
}

interface ListedPr {
  number: number;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  author?: { login?: string };
  statusCheckRollup?: unknown;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

function notesPath(boardDir: string, pr: number, sha: string, kind: string): string {
  return path.join(boardDir, 'notes', `land-${pr}-${sha.toLowerCase()}.${kind}.txt`);
}

/** Write `text` once; false when the file already exists. */
function writeOnce(file: string, text: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf-8');
  renameSync(tmp, file);
  return true;
}

function autoMergeAvailable(run: CommandRunner, repoRoot: string): boolean {
  const r = run('gh', ['repo', 'view', '--json', 'autoMergeAllowed', '--jq', '.autoMergeAllowed'], {
    cwd: repoRoot,
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** Run one landing pass. */
export async function landEligiblePrs(deps: LandDeps): Promise<LandReport> {
  const report: LandReport = { landed: [], refused: [] };
  if (deps.mergeAuthors.length === 0) return report;
  const listed = deps.run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,headRefName,headRefOid,isDraft,author,statusCheckRollup',
    ],
    { cwd: deps.repoRoot },
  );
  if (listed.status !== 0) {
    report.error = `gh pr list failed: ${listed.stderr.trim().split('\n')[0] ?? ''}`.trim();
    return report;
  }
  let prs: ListedPr[];
  try {
    const parsed: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(parsed)) throw new Error('not a list');
    prs = parsed as ListedPr[];
  } catch {
    report.error = 'gh pr list returned unreadable output';
    return report;
  }
  const authors = new Set(deps.mergeAuthors.map((a) => a.toLowerCase()));
  const mine = prs.filter(
    (p) =>
      Number.isInteger(p.number) &&
      !p.isDraft &&
      authors.has((p.author?.login ?? '').toLowerCase()),
  );
  if (mine.length === 0) return report;
  const mode = autoMergeAvailable(deps.run, deps.repoRoot) ? 'arm' : 'merge';
  const now = deps.now ?? clock;
  for (const pr of mine) {
    const sha = SHA_RE.test(pr.headRefOid ?? '') ? pr.headRefOid! : undefined;
    // An armed head is not armed again.
    if (mode === 'arm' && sha && existsSync(notesPath(deps.boardDir, pr.number, sha, 'armed'))) {
      continue;
    }
    // A PR refused on this same fingerprint (head, events, checks) is not re-read for 15 minutes.
    const fingerprint = prFingerprint(deps.boardDir, pr);
    if (refusalStillValid(deps.boardDir, pr.number, fingerprint, now())) continue;
    let outcome: LandOutcome;
    try {
      outcome = await deps.land(pr.number, mode);
    } catch (err) {
      outcome = {
        merged: false,
        armed: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (outcome.merged || outcome.armed) {
      recordRefusal(deps.boardDir, pr.number, undefined, now());
      const taskId = taskIdFrom(pr.headRefName) || undefined;
      if (taskId) patchDoneVerdict(deps.boardDir, taskId, { landed: now().toISOString() });
      if (outcome.armed && sha) {
        writeOnce(notesPath(deps.boardDir, pr.number, sha, 'armed'), `${outcome.reason}\n`);
      }
      report.landed.push({ pr: pr.number, ...(taskId ? { taskId } : {}), mode });
      continue;
    }
    report.refused.push({ pr: pr.number, reason: outcome.reason });
    recordRefusal(deps.boardDir, pr.number, fingerprint, now());
    if (sha) {
      writeOnce(
        notesPath(deps.boardDir, pr.number, sha, 'refused'),
        `PR #${pr.number} head ${sha} was not landed: ${outcome.reason}\n`,
      );
    }
  }
  return report;
}

/** Logins on the `mergeAuthors` list of the committed policy file; empty when unreadable. */
export function readMergeAuthors(repoRoot: string, parse: (yaml: string) => string[]): string[] {
  try {
    return parse(readFileSync(path.join(repoRoot, '.ai-sdlc', 'agent-role.yaml'), 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * The production `land` callback: `runMergeIfEligible` against the target repo's
 * `origin/main` policy, read through the GitHub API (AISDLC-897).
 */
export function createLander(opts: { repoRoot: string; runner?: Runner }): LandDeps['land'] {
  const runner = opts.runner ?? defaultRunner;
  return async (pr, mode) => {
    const target = await resolveTargetRepo({ runner, cwd: opts.repoRoot });
    const repoSlug = target.slug;
    const trusted = { root: repoSlug === null ? null : opts.repoRoot, reason: target.reason };
    const r = await runMergeIfEligible({
      prNumber: pr,
      sourceKind: 'backlog',
      repoSlug: repoSlug ?? '',
      repoRoot: trusted.root,
      rootRefusal: trusted.reason,
      runner,
      cwd: opts.repoRoot,
      mergeMethod: 'squash',
      mode,
    });
    return { merged: r.merged, armed: Boolean(r.armed), reason: r.eligibility.reason };
  };
}
