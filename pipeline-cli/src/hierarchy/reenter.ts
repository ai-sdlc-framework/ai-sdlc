/**
 * `cli-dispatch reenter <pr|task>` (RFC-0054 OQ-4, AISDLC-882).
 *
 * Re-entry is keyed on PR state, not on a claim. The command resolves the PR,
 * classifies it with `pr-state.ts` and then does one of two things:
 *  - the state needs a machine (BEHIND, a cancelled or infra check): run the action and
 *    write no manifest;
 *  - the state needs an executor (a real failure on the current head, a semantic
 *    conflict, an attestation content mismatch): write ONE queue manifest naming the
 *    branch, head SHA and failing line, and move the task's finished-state files
 *    (`done/` and `failed/`) into `landing/<pr>/history/`. The claim is made later by the
 *    normal executor claim; Step 3 reuses the branch the manifest names.
 *
 * Loop guard (AISDLC-883): the same `(action, headSha)` is never taken twice; a new head
 * resets it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now as clockNow } from '../clock.js';
import { collectVerdicts, TASK_ID_RE } from '../dispatch/board.js';
import { resumeDone } from '../dispatch/resume.js';
import type { ResumeFeedback } from '../dispatch/types.js';
import { resolveGateRunId } from './gate-run.js';
import { classifyPr, type PrFacts, type PrState } from './pr-state.js';
import { landingDir, normaliseCheck, readLanding, taskIdFrom } from './reconcile.js';
import { findOpenPrNumber } from './stall.js';
import type { CommandRunner } from './types.js';

/** What a re-entry did. */
export type ReenterResult =
  | {
      kind: 'manifest';
      pr: number;
      taskId: string;
      headSha: string;
      branch: string;
      state: PrState;
      queuePath: string;
      resume: ResumeFeedback;
    }
  | { kind: 'machine'; pr: number; state: PrState; action: string; note?: string };

export interface ReenterInput {
  /** A PR number or a task id. */
  target: string;
  /** Prose for the executor; with a note, a PR in any open state gets a round. */
  note?: string;
}

export interface ReenterDeps {
  boardDir: string;
  run: CommandRunner;
  cwd: string;
  /** Session that orders the round (audit only). */
  reenteredBy: string;
  now?: () => Date;
  resolveTaskFile?: (taskId: string) => string | undefined;
  resolveBaseSha?: () => string | undefined;
  /**
   * Local HEAD of the task worktree when it holds commits ahead of the PR head
   * (AISDLC-946); defaults to a `git rev-parse` inside `<cwd>/.worktrees/<id>`.
   */
  resolveLocalAheadHead?: (taskId: string, prHead: string) => string | undefined;
  /** Where the origin-lookup fallback notice goes; defaults to stderr. */
  warn?: (line: string) => void;
}

interface GuardEntry {
  action: string;
  headSha: string;
  at: string;
}

interface PrView {
  number: number;
  title?: string;
  state?: string;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  autoMergeRequest?: unknown;
  statusCheckRollup?: Parameters<typeof normaliseCheck>[0][];
}

/** Default probe: the task worktree's HEAD when it strictly descends from the PR head. */
function localAheadHead(deps: ReenterDeps): (taskId: string, prHead: string) => string | undefined {
  return (taskId, prHead) => {
    const wt = path.join(deps.cwd, '.worktrees', taskId.toLowerCase());
    if (!existsSync(path.join(wt, '.git'))) return undefined;
    const head = deps.run('git', ['rev-parse', 'HEAD'], { cwd: wt });
    const sha = head.status === 0 ? head.stdout.trim() : '';
    if (!sha || sha === prHead) return undefined;
    const anc = deps.run('git', ['merge-base', '--is-ancestor', prHead, sha], { cwd: wt });
    return anc.status === 0 ? sha : undefined;
  };
}

const short = (sha: string): string => sha.slice(0, 7);

function guardFile(boardDir: string, pr: number): string {
  return path.join(landingDir(boardDir), String(pr), 'reentered.json');
}

function readGuard(boardDir: string, pr: number): GuardEntry[] {
  try {
    const v = JSON.parse(readFileSync(guardFile(boardDir, pr), 'utf-8')) as unknown;
    return Array.isArray(v) ? (v as GuardEntry[]) : [];
  } catch {
    return [];
  }
}

function recordGuard(boardDir: string, pr: number, entry: GuardEntry): void {
  const file = guardFile(boardDir, pr);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...readGuard(boardDir, pr), entry], null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

function prFromVerdicts(boardDir: string, taskId: string): number | undefined {
  const id = taskId.toLowerCase();
  for (const v of collectVerdicts(boardDir)) {
    if (v.taskId.toLowerCase() !== id) continue;
    if (v.prNumber !== undefined && Number.isSafeInteger(v.prNumber) && v.prNumber > 0) {
      return v.prNumber;
    }
    const m = /\/pull\/(\d+)/.exec(v.prUrl ?? '');
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Collapse to one prose line; resume notes never start like a command. */
function proseLine(text: string): string {
  return `Fix: ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
}

/**
 * Re-enter one PR. Throws, writing nothing, when the PR cannot be resolved, is merged or
 * closed, needs nothing, or the loop guard refuses.
 */
export function reenter(input: ReenterInput, deps: ReenterDeps): ReenterResult {
  const now = deps.now ?? clockNow;
  const target = input.target.trim();
  let pr: number | undefined;
  let taskIdArg: string | undefined;
  if (/^#?\d+$/.test(target)) {
    pr = Number(target.replace('#', ''));
  } else if (TASK_ID_RE.test(target)) {
    taskIdArg = target;
    pr = prFromVerdicts(deps.boardDir, target) ?? findOpenPrNumber(deps.run, deps.cwd, target);
  } else {
    throw new Error(`'${target}' is neither a pull request number nor a task id`);
  }
  if (pr === undefined || !Number.isSafeInteger(pr) || pr < 1) {
    throw new Error(
      `${target} has no pull request; reenter works on PRs, use \`cli-dispatch requeue\` for a PR-less failure`,
    );
  }

  const r = deps.run(
    'gh',
    [
      'pr',
      'view',
      String(pr),
      '--json',
      'number,title,state,headRefName,headRefOid,isDraft,mergeStateStatus,autoMergeRequest,statusCheckRollup',
    ],
    { cwd: deps.cwd },
  );
  let view: PrView | undefined;
  try {
    view = r.status === 0 ? (JSON.parse(r.stdout) as PrView) : undefined;
  } catch {
    view = undefined;
  }
  if (!view) throw new Error(`pull request #${pr} could not be read from GitHub`);
  if (view.state === 'MERGED') throw new Error(`pull request #${pr} is already merged`);
  if (view.state === 'CLOSED') throw new Error(`pull request #${pr} is closed`);
  const headRef = view.headRefName ?? '';
  // GitHub's record can lag the branch on origin (AISDLC-937): key the guard on origin.
  const recordedSha = view.headRefOid ?? '';
  let headSha = recordedSha;
  if (headRef) {
    const ls = deps.run('git', ['ls-remote', 'origin', `refs/heads/${headRef}`], { cwd: deps.cwd });
    const originSha = ls.status === 0 ? /^([0-9a-f]{7,40})\s/i.exec(ls.stdout)?.[1] : undefined;
    if (originSha) {
      headSha = originSha;
    } else {
      (deps.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(
        `reenter: git ls-remote origin ${headRef} failed; guarding on the recorded head ${short(recordedSha)} from GitHub`,
      );
    }
  }
  if (!headSha || !headRef) throw new Error(`pull request #${pr} has no head to re-enter`);

  const taskId =
    taskIdArg ?? (taskIdFrom(headRef, view.title) || readLanding(deps.boardDir, pr)?.taskId || '');
  if (!taskId || !TASK_ID_RE.test(taskId)) {
    throw new Error(`pull request #${pr} names no task id; pass the task id`);
  }

  // AISDLC-946: finished-but-unpushed local work (HEAD ahead of the PR head) is
  // pending a push, not a repeat of the last re-entry: guard on the local HEAD.
  const localHead = (deps.resolveLocalAheadHead ?? localAheadHead(deps))(taskId, headSha);
  if (localHead) headSha = localHead;

  const checks = (view.statusCheckRollup ?? []).map(normaliseCheck);
  const facts: PrFacts = {
    prNumber: pr,
    taskId,
    draft: view.isDraft === true,
    autoMergeArmed: view.autoMergeRequest != null,
    headBranch: headRef,
    checks,
    ...(view.mergeStateStatus === undefined ? {} : { mergeStateStatus: view.mergeStateStatus }),
  };
  const c = classifyPr(facts);
  const pushNote = localHead
    ? `push pending: the worktree has local commits ahead of the PR head (${short(localHead)}); review, sign and lease-push them from the executor session.`
    : undefined;
  const note = input.note?.trim() || pushNote;

  type Route = 'rebase' | 'rerun' | 'executor';
  let route: Route;
  let rerunId: string | undefined;
  if (localHead) {
    route = 'executor';
  } else if (c.state === 'behind-or-dirty') {
    route = view.mergeStateStatus === 'BEHIND' ? 'rebase' : 'executor';
  } else if (c.state === 'cancelled-or-infra') {
    // `gh run rerun` takes a run id, not a commit: resolve the gate run for this head.
    rerunId = resolveGateRunId(deps.run, deps.cwd, headSha);
    route = rerunId ? 'rerun' : 'executor';
  } else if (c.state === 'real-failure' || c.state === 'attestation-content-hash-mismatch') {
    route = 'executor';
  } else if (note) {
    route = 'executor';
  } else {
    throw new Error(
      `pull request #${pr} is ${c.state}: nothing to re-enter; pass --note to order a round anyway`,
    );
  }

  const prior = readGuard(deps.boardDir, pr).filter(
    (e) => e.action === route && e.headSha === headSha,
  );
  if (prior.length > 0) {
    throw new Error(
      `loop guard: ${route}@${short(headSha)} x${prior.length + 1} on pull request #${pr}; ` +
        'the head has not changed since the last re-entry. Push a new head, or route it to the planner with `cli-decisions escalate` (AISDLC-883)',
    );
  }
  const entry: GuardEntry = { action: route, headSha, at: now().toISOString() };

  if (route !== 'executor') {
    const cmd =
      route === 'rebase'
        ? { file: 'gh', args: ['pr', 'update-branch', String(pr), '--rebase'] }
        : { file: 'gh', args: ['run', 'rerun', rerunId ?? '', '--failed'] };
    const out = deps.run(cmd.file, cmd.args, { cwd: deps.cwd });
    if (out.status !== 0) {
      throw new Error(
        `${route} of pull request #${pr} failed: ${out.stderr.trim().split('\n')[0] ?? ''}`.trim(),
      );
    }
    recordGuard(deps.boardDir, pr, entry);
    return { kind: 'machine', pr, state: c.state, action: route };
  }

  const failedChecks = checks.filter((k) => k.conclusion === 'failure');
  const failingLine = c.failingLine ?? failedChecks[0]?.summary;
  const reason =
    c.state === 'behind-or-dirty'
      ? 'resolve the merge conflict with origin/main'
      : c.state === 'attestation-content-hash-mismatch'
        ? 're-sign the attestation and push only'
        : (failingLine ?? 'a required check failed');
  const text = note ?? proseLine(`${reason} (head ${short(headSha)})`);
  const resumed = resumeDone(
    deps.boardDir,
    taskId,
    {
      note: text,
      prNumber: pr,
      prHeadRef: headRef,
      headSha,
      ...(failingLine ? { failingLine: proseLine(failingLine).slice(5) } : {}),
      failingChecks: failedChecks.map((k) => `${k.name}${k.summary ? `: ${k.summary}` : ''}`),
      pushOnly: c.state === 'attestation-content-hash-mismatch',
    },
    {
      resumedBy: deps.reenteredBy,
      now,
      archiveDir: path.join(landingDir(deps.boardDir), String(pr), 'history'),
      allowDiagnosticOnly: true,
      ...(deps.resolveTaskFile ? { resolveTaskFile: deps.resolveTaskFile } : {}),
      ...(deps.resolveBaseSha ? { resolveBaseSha: deps.resolveBaseSha } : {}),
    },
  );
  recordGuard(deps.boardDir, pr, entry);
  return {
    kind: 'manifest',
    pr,
    taskId,
    headSha,
    branch: headRef,
    state: c.state,
    queuePath: resumed.queuePath,
    resume: resumed.resume,
  };
}
