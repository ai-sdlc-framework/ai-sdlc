/**
 * `cli-ci` — GitHub Actions queue discipline (AISDLC-799).
 *
 *   cli-ci sweep [--dry-run]   cancel queued runs that can no longer matter
 *   cli-ci queue               queued / in-progress counts, per-workflow, oldest age
 *
 * Origin: on 2026-10-10 the org-wide concurrent-job cap saturated (100-144 queued
 * runs) and the dispatch session cancelled 76 runs by hand with ad-hoc rules,
 * cancelling a `pull_request_target` verify run that was not a duplicate and the
 * auto-enable run that would have armed a new PR. This module is the one tested,
 * deterministic version of that sweep.
 *
 * Cancel rules (a queued run is cancelled when ONE holds):
 *   stale-head  the run is on a SHA that is no longer the head of its open PR
 *   duplicate   an older queued run of the same workflow AND event AND branch
 *
 * Never-cancel rules (checked first; they win over both cancel rules):
 *   current-head          the run is on its open PR's current head SHA
 *   unarmed-auto-enable   an auto-enable run whose PR does not have auto-merge armed
 *   verify-not-duplicate  a `pull_request_target` verify run is exempt from
 *                         stale-head; it is cancelled only as a duplicate
 *
 * Every `gh` call goes through the injected {@link Runner}, so tests are hermetic.
 *
 * @module cli/ci
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { now as clockNow } from '../clock.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface WorkflowRun {
  databaseId: number;
  workflowName: string;
  event: string;
  headBranch: string;
  headSha: string;
  createdAt: string;
  status: string;
}

export interface OpenPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  /** True when GitHub auto-merge is armed on the PR. */
  armed: boolean;
}

export type CancelReason = 'stale-head' | 'duplicate';
export type KeepReason =
  | 'current-head'
  | 'unarmed-auto-enable'
  | 'verify-not-duplicate'
  | 'no-rule-matched';

export interface SweepDecision {
  run: WorkflowRun;
  action: 'cancel' | 'keep';
  reason: CancelReason | KeepReason;
}

export interface QueueSummary {
  queued: number;
  inProgress: number;
  /** Age in whole minutes of the oldest queued run, or null when nothing is queued. */
  oldestQueuedMinutes: number | null;
  byWorkflow: Array<{ workflow: string; queued: number; inProgress: number }>;
}

const RUN_FIELDS = 'databaseId,workflowName,event,headBranch,headSha,createdAt,status';
const RUN_LIMIT = '500';

const isAutoEnable = (run: WorkflowRun): boolean => /auto-enable/i.test(run.workflowName);
const isPrTargetVerify = (run: WorkflowRun): boolean =>
  run.event === 'pull_request_target' && /verify/i.test(run.workflowName);

// ── Pure planning ─────────────────────────────────────────────────────

/**
 * Decide, for each queued run, whether to cancel it. Pure: no I/O, no clock.
 */
export function planSweep(queued: WorkflowRun[], openPrs: OpenPr[]): SweepDecision[] {
  const prByBranch = new Map(openPrs.map((pr) => [pr.headRefName, pr]));

  // Newest queued run per (workflow, event, branch); everything older is a duplicate.
  const newest = new Map<string, WorkflowRun>();
  const groupKey = (r: WorkflowRun) => `${r.workflowName}\u0000${r.event}\u0000${r.headBranch}`;
  for (const run of queued) {
    const cur = newest.get(groupKey(run));
    if (!cur || Date.parse(run.createdAt) > Date.parse(cur.createdAt)) {
      newest.set(groupKey(run), run);
    }
  }

  return queued.map((run): SweepDecision => {
    const pr = prByBranch.get(run.headBranch);

    if (pr && pr.headRefOid === run.headSha) {
      return { run, action: 'keep', reason: 'current-head' };
    }
    if (isAutoEnable(run) && pr && !pr.armed) {
      return { run, action: 'keep', reason: 'unarmed-auto-enable' };
    }

    const verifyExempt = isPrTargetVerify(run);
    if (pr && !verifyExempt) {
      return { run, action: 'cancel', reason: 'stale-head' };
    }
    if (newest.get(groupKey(run)) !== run) {
      return { run, action: 'cancel', reason: 'duplicate' };
    }
    return {
      run,
      action: 'keep',
      reason: verifyExempt ? 'verify-not-duplicate' : 'no-rule-matched',
    };
  });
}

/** Summarise queue pressure. `now` is injected so tests do not read the clock. */
export function summarizeQueue(
  queued: WorkflowRun[],
  inProgress: WorkflowRun[],
  now: Date,
): QueueSummary {
  const byWorkflow = new Map<string, { queued: number; inProgress: number }>();
  const bucket = (name: string) => {
    let b = byWorkflow.get(name);
    if (!b) byWorkflow.set(name, (b = { queued: 0, inProgress: 0 }));
    return b;
  };
  for (const r of queued) bucket(r.workflowName).queued++;
  for (const r of inProgress) bucket(r.workflowName).inProgress++;

  const oldest = queued.reduce<number | null>((min, r) => {
    const t = Date.parse(r.createdAt);
    return min === null || t < min ? t : min;
  }, null);

  return {
    queued: queued.length,
    inProgress: inProgress.length,
    oldestQueuedMinutes:
      oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / 60_000)),
    byWorkflow: [...byWorkflow.entries()]
      .map(([workflow, v]) => ({ workflow, ...v }))
      .sort(
        (a, b) =>
          b.queued + b.inProgress - (a.queued + a.inProgress) ||
          a.workflow.localeCompare(b.workflow),
      ),
  };
}

// ── gh access ─────────────────────────────────────────────────────────

async function ghJson<T>(runner: Runner, args: string[], cwd?: string): Promise<T> {
  const res = await runner('gh', args, { cwd, allowFailure: true });
  if (res.code !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  }
  return JSON.parse(res.stdout || '[]') as T;
}

export async function listRuns(
  runner: Runner,
  status: 'queued' | 'in_progress',
  cwd?: string,
): Promise<WorkflowRun[]> {
  return ghJson<WorkflowRun[]>(
    runner,
    ['run', 'list', '--status', status, '--json', RUN_FIELDS, '--limit', RUN_LIMIT],
    cwd,
  );
}

export async function listOpenPrHeads(runner: Runner, cwd?: string): Promise<OpenPr[]> {
  const raw = await ghJson<
    Array<{ number: number; headRefName: string; headRefOid: string; autoMergeRequest: unknown }>
  >(
    runner,
    [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,headRefName,headRefOid,autoMergeRequest',
      '--limit',
      '200',
    ],
    cwd,
  );
  return raw.map((p) => ({
    number: p.number,
    headRefName: p.headRefName,
    headRefOid: p.headRefOid,
    armed: p.autoMergeRequest !== null && p.autoMergeRequest !== undefined,
  }));
}

// ── Commands ──────────────────────────────────────────────────────────

export interface SweepOptions {
  runner: Runner;
  dryRun: boolean;
  cwd?: string;
  write: (line: string) => void;
}

/** Plan and (unless dry-run) execute a sweep. Returns the decisions. */
export async function runSweep(opts: SweepOptions): Promise<SweepDecision[]> {
  const [queued, openPrs] = await Promise.all([
    listRuns(opts.runner, 'queued', opts.cwd),
    listOpenPrHeads(opts.runner, opts.cwd),
  ]);
  const decisions = planSweep(queued, openPrs);
  let cancelled = 0;
  for (const d of decisions) {
    if (d.action !== 'cancel') continue;
    const label = `${d.run.workflowName} #${d.run.databaseId} (${d.run.event}, ${d.run.headBranch}@${d.run.headSha.slice(0, 7)})`;
    if (opts.dryRun) {
      opts.write(`would cancel ${label}: ${d.reason}`);
      cancelled++;
      continue;
    }
    const res = await opts.runner('gh', ['run', 'cancel', String(d.run.databaseId)], {
      cwd: opts.cwd,
      allowFailure: true,
    });
    if (res.code === 0) {
      opts.write(`cancelled ${label}: ${d.reason}`);
      cancelled++;
    } else {
      opts.write(`failed to cancel ${label}: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }
  opts.write(
    `${opts.dryRun ? 'dry-run: ' : ''}${cancelled} of ${queued.length} queued run(s) ${opts.dryRun ? 'would be ' : ''}cancelled`,
  );
  return decisions;
}

export function renderQueue(s: QueueSummary): string {
  const lines = [
    `queued: ${s.queued}`,
    `in progress: ${s.inProgress}`,
    `oldest queued: ${s.oldestQueuedMinutes === null ? 'n/a' : `${s.oldestQueuedMinutes} min`}`,
  ];
  for (const w of s.byWorkflow) {
    lines.push(`  ${w.workflow}: ${w.queued} queued, ${w.inProgress} in progress`);
  }
  return lines.join('\n') + '\n';
}

export async function runQueue(runner: Runner, now: Date, cwd?: string): Promise<QueueSummary> {
  const [queued, inProgress] = await Promise.all([
    listRuns(runner, 'queued', cwd),
    listRuns(runner, 'in_progress', cwd),
  ]);
  return summarizeQueue(queued, inProgress, now);
}

// ── yargs router ──────────────────────────────────────────────────────

export interface CiCliDeps {
  runner?: Runner;
  now?: () => Date;
  stdout?: (s: string) => void;
}

export function buildCiCli(argv: string[] = hideBin(process.argv), deps: CiCliDeps = {}): Argv {
  const runner = deps.runner ?? defaultRunner;
  const now = deps.now ?? clockNow;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  return yargs(argv)
    .scriptName('cli-ci')
    .command(
      'sweep',
      'Cancel queued runs on a stale head or older duplicates',
      (y) =>
        y.option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Print what would be cancelled; cancel nothing.',
        }),
      async (args) => {
        await runSweep({
          runner,
          dryRun: Boolean(args['dry-run']),
          write: (l) => out(l + '\n'),
        });
      },
    )
    .command(
      'queue',
      'Print queued / in-progress counts, per-workflow breakdown and oldest queued age',
      (y) =>
        y.option('format', {
          type: 'string',
          choices: ['text', 'json'] as const,
          default: 'text' as const,
        }),
      async (args) => {
        const summary = await runQueue(runner, now());
        out(
          args.format === 'json' ? JSON.stringify(summary, null, 2) + '\n' : renderQueue(summary),
        );
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .version(false);
}

/** Bin shim entry point. */
export async function runCiCli(): Promise<void> {
  await buildCiCli().parseAsync();
}
