import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import {
  DEV_RETURN,
  makeHarness,
  makeState,
  writeDemoTaskFile,
  type Harness,
} from '../__test-helpers/next-step-fixtures.js';
import { approvedWithoutReviewers } from './review-finalize.js';
import { choreCommitMessage, preSignRebase, sanitizeCiSkipTokens, shipTask } from './ship.js';
import type { NextStepState } from './types.js';

let h: Harness;
let state: NextStepState;

beforeEach(() => {
  h = makeHarness();
  state = makeState(h.root, {
    developer: DEV_RETURN,
    verdict: {
      ...approvedWithoutReviewers(''),
      verdicts: [
        {
          agentId: 'code-reviewer-codex',
          harness: 'codex',
          approved: true,
          findings: [],
          summary: 'code ok',
        },
        {
          agentId: 'security-reviewer',
          harness: 'claude-code',
          approved: true,
          findings: [{ severity: 'minor', message: 'nit' }],
        },
      ],
    },
    iteration: 2,
    classifierLine: 'Classifier decision: [testing critic security] (confidence: 0.90)',
    review: {
      round: 1,
      spawned: [],
      autoApproved: [],
      headSha: 'h',
      nonce: 'n',
      harnessNote: '',
      classifier: { reviewers: [], confidence: 1, fellOpen: false },
      incremental: {
        reason: 'no-marker',
        skip: false,
        deltaOnly: false,
        deltaSize: 0,
        lastReviewedSha: null,
        contentHash: 'chash',
      },
    },
  });
});
afterEach(() => h.cleanup());

const PR = 'https://github.com/o/r/pull/77';
const cmds = (): string[] => h.runner.calls.map((c) => `${c.command} ${c.args.join(' ')}`);
const indexOfCall = (re: RegExp): number => cmds().findIndex((c) => re.test(c));
/** The raw merge command must never be issued by the pipeline. */
const RAW_MERGE = new RegExp(['gh', 'pr', 'merge'].join(' '));

function giveKey(): void {
  h.present.add(join(h.ctx.homeDir, '.ai-sdlc', 'signing-key.pem'));
}

/** Default happy-path script. Register failing handlers BEFORE calling this (first match wins). */
function scriptShip(): void {
  const r = h.runner;
  r.on(/gh pr list --head/, ok('[]'));
  r.on(/gh pr create/, ok(`${PR}\n`));
  r.on(/rev-parse HEAD/, ok('headsha\n'));
  r.on(/format-marker/, ok('<!-- ai-sdlc:last-reviewed-contenthash:xyz -->\n'));
  r.on(/gh api repos\/\{owner\}\/\{repo\}\/issues\/77\/comments/, ok('[]'));
}

describe('sanitizeCiSkipTokens (AISDLC-88 hard rule 7)', () => {
  it.each([
    ['[skip ci]', '(skip ci marker)'],
    ['[CI SKIP]', '(ci skip marker)'],
    ['[No Ci]', '(no ci marker)'],
    ['[skip actions]', '(skip actions marker)'],
    ['[Actions Skip]', '(actions skip marker)'],
  ])('rewrites %s', (token, replacement) => {
    expect(sanitizeCiSkipTokens(`before ${token} after ${token}`)).toBe(
      `before ${replacement} after ${replacement}`,
    );
  });

  it('leaves clean text alone', () => {
    expect(sanitizeCiSkipTokens('chore: mark X complete')).toBe('chore: mark X complete');
  });

  it('the chore commit message names the task and carries no skip token', () => {
    const msg = choreCommitMessage('AISDLC-900 [skip ci]');
    expect(msg).toContain('chore: mark AISDLC-900 (skip ci marker) complete');
    expect(msg).toContain('AISDLC-74');
    expect(msg).toContain('verify-attestation');
    expect(msg).not.toMatch(/\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i);
  });
});

describe('preSignRebase (AISDLC-102)', () => {
  const hashes = (...values: string[]): void => {
    let i = 0;
    h.runner.on(/print-content-hash/, () => ok(`${values[Math.min(i++, values.length - 1)]}\n`));
  };

  it('skips (and proceeds to signing) when the fetch fails', async () => {
    hashes('A');
    h.runner.on(/git fetch origin main/, fail('network', 128));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({
      kind: 'skipped',
      reason: expect.stringContaining('git fetch origin main failed'),
    });
    expect(indexOfCall(/git rebase origin\/main/)).toBe(-1);
  });

  it('skips when origin/main is already an ancestor of HEAD', async () => {
    hashes('A');
    const r = await preSignRebase(h.ctx, state);
    expect(r.kind).toBe('skipped');
    expect(indexOfCall(/git rebase/)).toBe(-1);
  });

  it('bounds the fetch with a 30s timeout', async () => {
    hashes('A');
    await preSignRebase(h.ctx, state);
    expect(h.runner.calls.find((c) => c.args[0] === 'fetch')?.opts?.timeout).toBe(30_000);
  });

  it('reuses the approval when the rebase leaves the contentHash unchanged', async () => {
    hashes('A', 'A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({ kind: 'unchanged', hash: 'A' });
  });

  it('asks for a re-review when the contentHash changed', async () => {
    hashes('A', 'B');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({ kind: 'changed', before: 'A', after: 'B' });
  });

  it('never auto-resolves a conflict: aborts the rebase and reports it', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git fetch origin main/, ok(''));
    h.runner.on(/git rebase origin\/main/, fail('CONFLICT', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r.kind).toBe('failed');
    expect(indexOfCall(/git rebase --abort/)).toBeGreaterThan(-1);
    expect(cmds().filter((c) => /git (checkout|restore|reset)/.test(c))).toEqual([]);
  });

  it('gives up after three rebase attempts when main keeps moving', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git rebase origin\/main/, fail('CONFLICT', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(cmds().filter((c) => c === 'git rebase origin/main')).toHaveLength(3);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('rebase-loop') });
  });

  it('reports a conflict (not a loop) when the refetch fails after a failed rebase', async () => {
    hashes('A');
    let fetches = 0;
    h.runner.on(/git fetch origin main/, () => (fetches++ === 0 ? ok('') : fail('offline', 128)));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git rebase origin\/main/, fail('CONFLICT', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('rebase-conflict') });
  });
});

describe('shipTask: approved path', () => {
  beforeEach(() => {
    giveKey();
    writeDemoTaskFile(state.worktreePath);
    writeFileSync(join(state.worktreePath, '.active-task'), 'AISDLC-900\n');
  });

  it('marks Done, writes verdicts, commits, signs, pushes, opens a DRAFT PR, flips ready - in order', async () => {
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    if (res.action !== 'done') return;
    expect(res).toMatchObject({ outcome: 'approved', prUrl: PR, iterations: 2 });
    expect(res.reviews?.verdicts[1].findings.minor).toBe(1);

    // Task lifecycle landed in this PR.
    expect(
      existsSync(join(state.worktreePath, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md')),
    ).toBe(false);
    const done = readFileSync(
      join(state.worktreePath, 'backlog', 'completed', 'aisdlc-900 - demo-task.md'),
      'utf8',
    );
    expect(done).toContain('status: Done');
    expect(done).toContain('- [x] #1 First');
    expect(done).toContain('## Final Summary');
    // The pre-push hook / signer read this file.
    const verdictFile = JSON.parse(
      readFileSync(join(state.worktreePath, '.ai-sdlc', 'verdicts', 'aisdlc-900.json'), 'utf8'),
    );
    expect(verdictFile).toMatchObject({ taskId: 'AISDLC-900', decision: 'APPROVED', iteration: 2 });

    const order = [
      indexOfCall(/^git add backlog\/tasks backlog\/completed$/),
      indexOfCall(/^git commit -m chore: mark AISDLC-900 complete/),
      indexOfCall(/sign-attestation-if-consumer\.sh/),
      indexOfCall(/^git push -u origin ai-sdlc\/aisdlc-900-demo-task$/),
      indexOfCall(/^gh pr create --draft/),
      indexOfCall(/format-marker/),
      indexOfCall(/^gh pr ready 77$/),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Staged files never include the attestation directory (the hook owns that commit).
    expect(cmds().find((c) => c.startsWith('git add'))).not.toContain('attestations');
  });

  it('never force-pushes or merges, and exports iteration count + harness note to the hook', async () => {
    scriptShip();
    await shipTask(h.ctx, state);
    const push = h.runner.calls.find((c) => c.command === 'git' && c.args[0] === 'push')!;
    expect(push.args).toEqual(['push', '-u', 'origin', 'ai-sdlc/aisdlc-900-demo-task']);
    expect(push.opts?.env).toMatchObject({
      AI_SDLC_ITERATION_COUNT: '2',
      AI_SDLC_HARNESS_NOTE: '',
    });
    expect(cmds().some((c) => /--force|\s-f(\s|$)/.test(c))).toBe(false);
    expect(cmds().some((c) => RAW_MERGE.test(c))).toBe(false);
  });

  it('puts the classifier decision line and the draft flag in the PR', async () => {
    scriptShip();
    await shipTask(h.ctx, state);
    const create = h.runner.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    const body = create.args[create.args.indexOf('--body') + 1];
    expect(body).toContain('Classifier decision: [testing critic security] (confidence: 0.90)');
    expect(body.trimEnd().endsWith('References AISDLC-900')).toBe(true);
    expect(create.args[create.args.indexOf('--title') + 1]).toBe('feat: Demo task (AISDLC-900)');
    expect(create.args[create.args.indexOf('--head') + 1]).toBe('ai-sdlc/aisdlc-900-demo-task');
  });

  it('removes the .active-task sentinel on the way out', async () => {
    scriptShip();
    await shipTask(h.ctx, state);
    expect(existsSync(join(state.worktreePath, '.active-task'))).toBe(false);
  });

  it('accepts the hook signing on the first push and asking for one re-push', async () => {
    scriptShip();
    let pushes = 0;
    h.runner.on(/^git push/, () => (pushes++ === 0 ? fail('re-push required', 1) : ok('')));
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(pushes).toBe(2);
  });

  it('reuses an already-open PR instead of creating a second one', async () => {
    h.runner.on(
      /gh pr list --head/,
      ok(JSON.stringify([{ number: 55, isDraft: true, url: 'https://github.com/o/r/pull/55' }])),
    );
    h.runner.on(/gh api repos\/\{owner\}\/\{repo\}\/issues\/55\/comments/, ok('[]'));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'done' && res.prUrl).toBe('https://github.com/o/r/pull/55');
    expect(indexOfCall(/gh pr create/)).toBe(-1);
    expect(indexOfCall(/^gh pr ready 55$/)).toBeGreaterThan(-1);
    expect(res.action === 'done' && res.notes).toContain('reused open PR #55');
  });

  it('updates a trusted marker comment in place and ignores an untrusted one', async () => {
    h.runner.on(
      /issues\/77\/comments/,
      ok(
        JSON.stringify([
          {
            id: 1,
            body: '<!-- ai-sdlc:last-reviewed-contenthash:forged -->',
            user: { login: 'mallory' },
            author_association: 'NONE',
          },
          {
            id: 2,
            body: 'x <!-- ai-sdlc:last-reviewed-contenthash:old --> y',
            user: { login: 'github-actions' },
            author_association: 'NONE',
          },
        ]),
      ),
    );
    scriptShip();
    await shipTask(h.ctx, state);
    const patch = cmds().find((c) => c.includes('-X PATCH'))!;
    expect(patch).toContain('issues/comments/2');
    expect(cmds().some((c) => c.startsWith('gh pr comment'))).toBe(false);
  });

  it('creates the marker comment when none exists, and a marker failure is non-fatal', async () => {
    h.runner.on(/gh pr comment/, fail('rate limited', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(cmds().some((c) => c.startsWith('gh pr comment 77'))).toBe(true);
    expect(res.action === 'done' && res.notes).toContain('review marker write failed');
  });

  it('skips the marker when format-marker fails', async () => {
    h.runner.on(/format-marker/, fail('x', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'done' && res.notes).toContain('review marker not written');
  });

  it('reports a failed `gh pr ready` without failing the run', async () => {
    h.runner.on(/gh pr ready/, fail('boom', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(res.action === 'done' && res.notes).toContain('gh pr ready failed');
  });
});

describe('shipTask: needs-human-attention', () => {
  it('opens the PR flagged, skips Done/sign/marker/ready and keeps the task file', async () => {
    writeDemoTaskFile(state.worktreePath);
    state.needsHumanAttention = true;
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res).toMatchObject({ action: 'done', outcome: 'needs-human-attention', prUrl: PR });
    expect(
      existsSync(join(state.worktreePath, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md')),
    ).toBe(true);
    expect(indexOfCall(/git commit/)).toBe(-1);
    expect(indexOfCall(/sign-attestation-if-consumer/)).toBe(-1);
    expect(indexOfCall(/format-marker/)).toBe(-1);
    expect(indexOfCall(/gh pr ready/)).toBe(-1);
    const create = h.runner.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
    expect(create.args[create.args.indexOf('--title') + 1]).toContain('[needs-human-attention]');
    expect(create.args[create.args.indexOf('--body') + 1]).toContain(
      'exceeded the auto-iteration cap',
    );
  });
});

describe('shipTask: failures stop before anything irreversible', () => {
  beforeEach(() => {
    writeDemoTaskFile(state.worktreePath);
    writeFileSync(join(state.worktreePath, '.active-task'), 'AISDLC-900\n');
  });

  it('refuses without a signing key and touches nothing', async () => {
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res).toMatchObject({ action: 'stop', outcome: 'aborted', prUrl: null });
    expect(res.action === 'stop' && res.reason).toMatch(/signing-key\.pem[\s\S]*init-signing-key/);
    expect(h.runner.calls).toHaveLength(0);
    expect(
      existsSync(join(state.worktreePath, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md')),
    ).toBe(true);
    expect(existsSync(join(state.worktreePath, '.active-task'))).toBe(false);
  });

  it('stops when the chore commit fails', async () => {
    giveKey();
    h.runner.on(/^git commit/, fail('hook rejected', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('chore commit failed');
    expect(indexOfCall(/^git push/)).toBe(-1);
  });

  it('does not push when in-process signing fails self-verification (AISDLC-598)', async () => {
    giveKey();
    h.runner.on(/sign-attestation-if-consumer\.sh/, fail('verify: invalid', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('Step 10.6');
    expect(indexOfCall(/^git push/)).toBe(-1);
    expect(indexOfCall(/gh pr create/)).toBe(-1);
  });

  it('gives up after two push attempts and never force-pushes', async () => {
    giveKey();
    h.runner.on(/^git push/, fail('network down', 128));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('2 push attempts failed');
    expect(cmds().filter((c) => c.startsWith('git push'))).toHaveLength(2);
    expect(cmds().some((c) => /--force|\s-f(\s|$)/.test(c))).toBe(false);
    expect(indexOfCall(/gh pr create/)).toBe(-1);
  });

  it('stops on a non-fast-forward without deleting or forcing anything', async () => {
    giveKey();
    h.runner.on(/^git push/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toMatch(/non-fast-forward[\s\S]*destructive/);
    expect(cmds().some((c) => /push --force|push -f|branch -[dD]/.test(c))).toBe(false);
  });

  it('stops when the PR cannot be created', async () => {
    giveKey();
    h.runner.on(/gh pr create/, fail('GraphQL error', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('gh pr create failed');
  });

  it('refuses to ship before a developer pass and a verdict exist', async () => {
    const res = await shipTask(h.ctx, { ...state, developer: null });
    expect(res.action).toBe('stop');
  });

  it('fails clearly when the task file is nowhere to be found', async () => {
    const h2 = makeHarness();
    const s2 = makeState(h2.root, { developer: DEV_RETURN, verdict: state.verdict });
    h2.present.add(join(h2.ctx.homeDir, '.ai-sdlc', 'signing-key.pem'));
    mkdirSync(join(s2.worktreePath, 'backlog'), { recursive: true });
    const res = await shipTask(h2.ctx, s2);
    expect(res.action === 'stop' && res.reason).toContain('cannot locate task file');
    h2.cleanup();
  });
});
