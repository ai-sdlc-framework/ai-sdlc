/**
 * Hermetic tests for `cli-ci` (AISDLC-799). The `gh` runner is injected; nothing
 * touches the network.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AUTO_ENABLE_WORKFLOW,
  VERIFY_WORKFLOWS,
  buildCiCli,
  planSweep,
  renderQueue,
  runQueue,
  runSweep,
  summarizeQueue,
  type OpenPr,
  type WorkflowRun,
} from './ci.js';
import type { ExecResult, Runner } from '../runtime/exec.js';

const AUTO_ENABLE = AUTO_ENABLE_WORKFLOW;

let nextId = 1;
function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: nextId++,
    workflowName: 'AI-SDLC Gate',
    event: 'pull_request',
    headBranch: 'feat/a',
    headSha: 'aaaaaaa1111111',
    createdAt: '2026-10-10T20:00:00Z',
    status: 'queued',
    ...over,
  };
}
const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  number: 1,
  headRefName: 'feat/a',
  headRefOid: 'aaaaaaa1111111',
  armed: true,
  crossRepo: false,
  ...over,
});
const decide = (runs: WorkflowRun[], prs: OpenPr[]) =>
  new Map(planSweep(runs, prs).map((d) => [d.run.databaseId, d]));

describe('planSweep cancel rules', () => {
  it('cancels a run on a SHA that is no longer its PR head (stale-head)', () => {
    const r = run({ headSha: 'old0000' });
    expect(decide([r], [pr()]).get(r.databaseId)).toMatchObject({
      action: 'cancel',
      reason: 'stale-head',
    });
  });

  it('cancels an older duplicate of the same workflow, event and branch', () => {
    const older = run({ createdAt: '2026-10-10T19:00:00Z' });
    const newer = run({ createdAt: '2026-10-10T20:00:00Z' });
    // no open PR for the branch, so only the duplicate rule can apply
    const d = decide([older, newer], []);
    expect(d.get(older.databaseId)).toMatchObject({ action: 'cancel', reason: 'duplicate' });
    expect(d.get(newer.databaseId)).toMatchObject({ action: 'keep', reason: 'no-rule-matched' });
  });

  it('does not treat a different workflow, event or branch as a duplicate', () => {
    const a = run({ createdAt: '2026-10-10T19:00:00Z' });
    const b = run({ workflowName: 'Other', createdAt: '2026-10-10T20:00:00Z' });
    const c = run({ event: 'push', createdAt: '2026-10-10T20:00:00Z' });
    const e = run({ headBranch: 'feat/z', createdAt: '2026-10-10T20:00:00Z' });
    const d = decide([a, b, c, e], []);
    for (const x of [a, b, c, e]) expect(d.get(x.databaseId)?.action).toBe('keep');
  });
});

describe('planSweep never-cancel rules', () => {
  it('never cancels a run on a current head, even as an older duplicate', () => {
    const older = run({ createdAt: '2026-10-10T19:00:00Z' });
    const newer = run({ createdAt: '2026-10-10T20:00:00Z' });
    const d = decide([older, newer], [pr()]);
    expect(d.get(older.databaseId)).toMatchObject({ action: 'keep', reason: 'current-head' });
    expect(d.get(newer.databaseId)).toMatchObject({ action: 'keep', reason: 'current-head' });
  });

  it('never cancels an auto-enable run for an unarmed PR, even on a stale head', () => {
    const r = run({ workflowName: AUTO_ENABLE, event: 'pull_request_target', headSha: 'old0000' });
    expect(decide([r], [pr({ armed: false })]).get(r.databaseId)).toMatchObject({
      action: 'keep',
      reason: 'unarmed-auto-enable',
    });
  });

  it('cancels a stale auto-enable run when the PR is already armed', () => {
    const r = run({ workflowName: AUTO_ENABLE, event: 'pull_request_target', headSha: 'old0000' });
    expect(decide([r], [pr({ armed: true })]).get(r.databaseId)).toMatchObject({
      action: 'cancel',
      reason: 'stale-head',
    });
  });

  it('never cancels a pull_request_target verify run that is not a duplicate', () => {
    const r = run({
      workflowName: VERIFY_WORKFLOWS[0],
      event: 'pull_request_target',
      headSha: 'old0000',
    });
    expect(decide([r], [pr()]).get(r.databaseId)).toMatchObject({
      action: 'keep',
      reason: 'verify-not-duplicate',
    });
  });

  it('still cancels a pull_request_target verify run when it is an older duplicate', () => {
    const base = {
      workflowName: VERIFY_WORKFLOWS[0],
      event: 'pull_request_target',
      headSha: 'old0000',
    };
    const older = run({ ...base, createdAt: '2026-10-10T19:00:00Z' });
    const newer = run({ ...base, createdAt: '2026-10-10T20:00:00Z' });
    const d = decide([older, newer], [pr()]);
    expect(d.get(older.databaseId)).toMatchObject({ action: 'cancel', reason: 'duplicate' });
    expect(d.get(newer.databaseId)).toMatchObject({
      action: 'keep',
      reason: 'verify-not-duplicate',
    });
  });

  it('keeps runs on branches with no open PR (e.g. main)', () => {
    const r = run({ headBranch: 'main', event: 'push' });
    expect(decide([r], [pr()]).get(r.databaseId)?.action).toBe('keep');
  });
});

describe('planSweep scoping (fork PRs, non-PR events)', () => {
  it('does not cancel a queued push run on main because a fork PR head is named main', () => {
    const push = run({ event: 'push', headBranch: 'main', headSha: 'mmm' });
    const older = run({ event: 'push', headBranch: 'main', createdAt: '2026-10-10T19:00:00Z' });
    const forkPr = pr({ headRefName: 'main', headRefOid: 'fff', crossRepo: true });
    const d = decide([push, older], [forkPr]);
    expect(d.get(push.databaseId)?.action).toBe('keep');
    expect(d.get(older.databaseId)?.action).toBe('keep');
  });

  it('leaves an internal PR current-head run alone when a fork PR copies its branch name', () => {
    const internal = run({ headBranch: 'ai-sdlc/aisdlc-1-x', headSha: 'cur' });
    const forkRun = run({ headBranch: 'ai-sdlc/aisdlc-1-x', headSha: 'fork' });
    const d = decide(
      [internal, forkRun],
      [
        pr({ headRefName: 'ai-sdlc/aisdlc-1-x', headRefOid: 'cur' }),
        pr({ number: 9, headRefName: 'ai-sdlc/aisdlc-1-x', headRefOid: 'fork', crossRepo: true }),
      ],
    );
    expect(d.get(internal.databaseId)?.action).toBe('keep');
    expect(d.get(forkRun.databaseId)?.action).toBe('keep');
  });

  it('still cancels a stale same-repo pull_request run', () => {
    const r = run({ headSha: 'old0000' });
    const prs = [pr(), pr({ number: 2, headRefName: 'other', crossRepo: true })];
    expect(decide([r], prs).get(r.databaseId)).toMatchObject({
      action: 'cancel',
      reason: 'stale-head',
    });
  });

  it('keeps older queued push, schedule and release runs on main', () => {
    const runs = ['main-health-monitor', 'release', 'ci'].flatMap((w) =>
      ['push', 'schedule'].flatMap((event) => [
        run({ workflowName: w, event, headBranch: 'main', createdAt: '2026-10-10T18:00:00Z' }),
        run({ workflowName: w, event, headBranch: 'main', createdAt: '2026-10-10T19:00:00Z' }),
      ]),
    );
    for (const d of planSweep(runs, [])) expect(d.action).toBe('keep');
  });
});

describe('workflow name matchers bound to the real workflow files', () => {
  const nameOf = (file: string): string => {
    const url = new URL(`../../../.github/workflows/${file}`, import.meta.url);
    const text = readFileSync(url, 'utf8');
    return /^name:\s*(.+?)\s*$/m.exec(text)![1].replace(/^['"]|['"]$/g, '');
  };
  it('auto-enable name matches its workflow file', () => {
    expect(nameOf('auto-enable-auto-merge.yml')).toBe(AUTO_ENABLE_WORKFLOW);
  });
  it('verify names match the verify workflow files', () => {
    expect([...VERIFY_WORKFLOWS]).toEqual([nameOf('consumer-verify-attestation.yml')]);
  });
});

// ── runner fake ───────────────────────────────────────────────────────

function fakeRunner(opts: {
  queued?: WorkflowRun[];
  inProgress?: WorkflowRun[];
  prs?: unknown[];
  failCancel?: boolean;
  failList?: boolean;
}): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
  const runner: Runner = async (_cmd, args) => {
    calls.push(args);
    if (opts.failList && args[0] !== 'run') return { stdout: '', stderr: 'boom', code: 1 };
    if (args[0] === 'run' && args[1] === 'list') {
      const status = args[args.indexOf('--status') + 1];
      return ok(
        JSON.stringify(status === 'queued' ? (opts.queued ?? []) : (opts.inProgress ?? [])),
      );
    }
    if (args[0] === 'pr') return ok(JSON.stringify(opts.prs ?? []));
    if (args[0] === 'run' && args[1] === 'cancel') {
      return opts.failCancel ? { stdout: '', stderr: 'nope', code: 1 } : ok('');
    }
    return { stdout: '', stderr: 'unexpected', code: 2 };
  };
  return { runner, calls };
}

const prJson = [
  { number: 1, headRefName: 'feat/a', headRefOid: 'aaaaaaa1111111', autoMergeRequest: { x: 1 } },
  { number: 2, headRefName: 'feat/b', headRefOid: 'bbbbbbb', autoMergeRequest: null },
];

describe('runSweep', () => {
  it('lists runs before open PR heads', async () => {
    const { runner, calls } = fakeRunner({ queued: [], prs: prJson });
    await runSweep({ runner, dryRun: true, write: () => {} });
    expect(calls.findIndex((c) => c[0] === 'run')).toBeLessThan(
      calls.findIndex((c) => c[0] === 'pr'),
    );
  });

  it('cancels via gh and prints what it cancelled and why', async () => {
    const stale = run({ headSha: 'old0000' });
    const keep = run();
    const { runner, calls } = fakeRunner({ queued: [stale, keep], prs: prJson });
    const lines: string[] = [];
    await runSweep({ runner, dryRun: false, write: (l) => lines.push(l) });
    expect(calls).toContainEqual(['run', 'cancel', String(stale.databaseId)]);
    expect(calls).not.toContainEqual(['run', 'cancel', String(keep.databaseId)]);
    expect(lines[0]).toContain('cancelled');
    expect(lines[0]).toContain('stale-head');
    expect(lines.at(-1)).toBe('1 of 2 queued run(s) cancelled');
  });

  it('dry-run cancels nothing', async () => {
    const stale = run({ headSha: 'old0000' });
    const { runner, calls } = fakeRunner({ queued: [stale], prs: prJson });
    const lines: string[] = [];
    await runSweep({ runner, dryRun: true, write: (l) => lines.push(l) });
    expect(calls.some((c) => c[1] === 'cancel')).toBe(false);
    expect(lines[0]).toContain('would cancel');
    expect(lines.at(-1)).toBe('dry-run: 1 of 1 queued run(s) would be cancelled');
  });

  it('reports a failed cancel without throwing', async () => {
    const stale = run({ headSha: 'old0000' });
    const { runner } = fakeRunner({ queued: [stale], prs: prJson, failCancel: true });
    const lines: string[] = [];
    await runSweep({ runner, dryRun: false, write: (l) => lines.push(l) });
    expect(lines[0]).toContain('failed to cancel');
    expect(lines.at(-1)).toBe('0 of 1 queued run(s) cancelled');
  });

  it('surfaces a gh listing failure', async () => {
    const { runner } = fakeRunner({ failList: true });
    await expect(runSweep({ runner, dryRun: false, write: () => {} })).rejects.toThrow(
      /gh pr list failed: boom/,
    );
  });
});

describe('queue summary', () => {
  const now = new Date('2026-10-10T21:00:00Z');

  it('counts, breaks down per workflow and reports the oldest queued age', () => {
    const q = [
      run({ createdAt: '2026-10-10T20:30:00Z' }),
      run({ workflowName: 'Other', createdAt: '2026-10-10T20:45:00Z' }),
      run({ createdAt: '2026-10-10T20:50:00Z' }),
    ];
    const p = [run({ status: 'in_progress' })];
    const s = summarizeQueue(q, p, now);
    expect(s).toMatchObject({ queued: 3, inProgress: 1, oldestQueuedMinutes: 30 });
    expect(s.byWorkflow[0]).toEqual({ workflow: 'AI-SDLC Gate', queued: 2, inProgress: 1 });
    expect(renderQueue(s)).toContain('oldest queued: 30 min');
    expect(renderQueue(s)).toContain('  Other: 1 queued, 0 in progress');
  });

  it('reports n/a when nothing is queued and orders ties by name', () => {
    const s = summarizeQueue([], [run({ workflowName: 'B' }), run({ workflowName: 'A' })], now);
    expect(s.oldestQueuedMinutes).toBeNull();
    expect(s.byWorkflow.map((w) => w.workflow)).toEqual(['A', 'B']);
    expect(renderQueue(s)).toContain('oldest queued: n/a');
  });

  it('runQueue reads both statuses through the runner', async () => {
    const { runner } = fakeRunner({
      queued: [run({ createdAt: '2026-10-10T20:59:00Z' })],
      inProgress: [run()],
    });
    expect(await runQueue(runner, now)).toMatchObject({
      queued: 1,
      inProgress: 1,
      oldestQueuedMinutes: 1,
    });
  });
});

describe('buildCiCli', () => {
  it('sweep --dry-run writes through the injected stdout', async () => {
    const { runner } = fakeRunner({ queued: [run({ headSha: 'old0000' })], prs: prJson });
    let out = '';
    await buildCiCli(['sweep', '--dry-run'], { runner, stdout: (s) => (out += s) }).parseAsync();
    expect(out).toContain('would cancel');
  });

  it('queue prints text and json', async () => {
    const { runner } = fakeRunner({ queued: [run()], inProgress: [] });
    const now = () => new Date('2026-10-10T20:10:00Z');
    let text = '';
    await buildCiCli(['queue'], { runner, now, stdout: (s) => (text += s) }).parseAsync();
    expect(text).toContain('queued: 1');
    let json = '';
    await buildCiCli(['queue', '--format', 'json'], {
      runner,
      now,
      stdout: (s) => (json += s),
    }).parseAsync();
    expect(JSON.parse(json)).toMatchObject({ queued: 1, oldestQueuedMinutes: 10 });
  });

  it('treats an empty gh stdout as an empty list', async () => {
    const runner: Runner = async () => ({ stdout: '', stderr: '', code: 0 });
    expect(await runQueue(runner, new Date())).toMatchObject({ queued: 0, inProgress: 0 });
  });
});
