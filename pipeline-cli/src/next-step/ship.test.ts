import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import { fail, ok } from '../__test-helpers/fake-runner.js';
import type { Runner } from '../runtime/exec.js';
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
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const policyOverride = vi.hoisted(() => ({
  mode: null as null | 'lease' | 'never',
  ready: false,
}));
vi.mock('../hierarchy/operational.js', async (orig) => {
  const real = await orig<typeof import('../hierarchy/operational.js')>();
  return {
    ...real,
    loadOperationalPolicy: (...a: Parameters<typeof real.loadOperationalPolicy>) => {
      const base = real.loadOperationalPolicy(...a);
      const withMode = policyOverride.mode ? { ...base, forcePushMode: policyOverride.mode } : base;
      return policyOverride.ready ? { ...withMode, openTaskPrsReady: true } : withMode;
    },
  };
});

let h: Harness;
let state: NextStepState;

beforeEach(() => {
  policyOverride.mode = 'lease';
  policyOverride.ready = false;
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
  r.on(/^git diff --cached --quiet/, fail('', 1)); // something is staged
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
    expect(msg).toContain('RFC-0061');
    expect(msg).not.toMatch(/\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i);
  });
});

describe('preSignRebase (AISDLC-102)', () => {
  // The content hash is taken from the (path, new blob id) pairs of `git diff --raw`.
  const hashes = (...values: string[]): void => {
    let i = 0;
    h.runner.on(/git merge-base origin\/main HEAD/, ok('abc123\n'));
    h.runner.on(/git diff --raw/, () =>
      ok(`:100644 100644 0000000 ${values[Math.min(i++, values.length - 1)]} M\tfile.ts\n`),
    );
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

  it('does not touch the index when no envelope is deleted (AISDLC-1098)', async () => {
    hashes('A', 'A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    await preSignRebase(h.ctx, state);
    expect(indexOfCall(/git rm --cached/)).toBe(-1);
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
    expect(r).toEqual({ kind: 'unchanged', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('asks for a re-review when the contentHash changed', async () => {
    hashes('A', 'B');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({
      kind: 'changed',
      before: expect.stringMatching(/^[0-9a-f]{64}$/),
      after: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('names the conflicting files, aborts, and does not retry', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git rebase origin\/main/, fail('CONFLICT', 1));
    h.runner.on(/diff --name-only --diff-filter=U/, ok('a.ts\nb/c.ts\n'));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('(rebase-conflict)'),
      conflictingFiles: ['a.ts', 'b/c.ts'],
      cause: 'rebase-conflict',
    });
    expect((r as { reason: string }).reason).toContain('a.ts, b/c.ts');
    expect((r as { reason: string }).reason).toContain(`/ai-sdlc execute ${state.taskId}`);
    expect(cmds().filter((c) => c === 'git rebase origin/main')).toHaveLength(1);
    expect(cmds().filter((c) => c.startsWith('git fetch'))).toHaveLength(1);
    expect(indexOfCall(/git rebase --abort/)).toBeGreaterThan(indexOfCall(/git rebase origin/));
    expect(cmds().filter((c) => /git (checkout|restore|reset)/.test(c))).toEqual([]);
  });

  it('names a rebase refusal without conflict markers by cause and stderr', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(
      /git rebase origin\/main/,
      fail('error: cannot rebase: You have unstaged changes.', 1),
    );
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('cannot rebase: You have unstaged changes.'),
      conflictingFiles: [],
      cause: 'dirty-worktree',
    });
    expect((r as { reason: string }).reason).not.toContain('unknown');
  });

  it('lists the dirty paths in a dirty-worktree refusal (AISDLC-1026)', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git rebase origin\/main/, fail('error: You have unstaged changes.', 1));
    h.runner.on(/git status --porcelain$/, ok(' M backlog/completed/aisdlc-1 - x.md\n'));
    const r = await preSignRebase(h.ctx, state);
    expect((r as { reason: string }).reason).toContain(
      'Dirty paths: M backlog/completed/aisdlc-1 - x.md',
    );
  });

  it('labels other refusals rebase-failed', async () => {
    hashes('A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/git rebase origin\/main/, fail('boom', 1));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toMatchObject({ kind: 'failed', cause: 'rebase-failed' });
    expect((r as { reason: string }).reason).toContain('boom');
  });

  it('commits once per dirty state: dirty, clean after commit, dirty again (AISDLC-951)', async () => {
    hashes('A', 'A', 'A', 'A', 'A', 'A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    const states = [' M x\n', '', ' M x\n'];
    let i = 0;
    h.runner.on(/status --porcelain/, () => ok(states[i++]));
    await preSignRebase(h.ctx, state);
    await preSignRebase(h.ctx, state);
    await preSignRebase(h.ctx, state);
    expect(cmds().filter((c) => c.startsWith('git commit'))).toHaveLength(2);
  });

  it('converges on a later attempt when the ledger re-dirties after the rebase', async () => {
    hashes('A', 'A', 'A', 'A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(
      /status --porcelain/,
      ok(` M .ai-sdlc/reviews/${state.taskId.toLowerCase()}.jsonl\n`),
    );
    const r1 = await preSignRebase(h.ctx, state);
    const r2 = await preSignRebase(h.ctx, state);
    expect(r1.kind).not.toBe('failed');
    expect(r2.kind).not.toBe('failed');
    expect(cmds().filter((c) => c.startsWith('git commit'))).toHaveLength(2);
  });

  const writeLedger = (): void => {
    const dir = join(state.worktreePath, '.ai-sdlc', 'reviews');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${state.taskId.toLowerCase()}.jsonl`), '{}\n');
  };

  it('fails ledger-not-staged naming the ignore rule, without rebasing (AISDLC-967)', async () => {
    hashes('A', 'A');
    writeLedger();
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/ls-files --error-unmatch/, fail('error: pathspec', 1));
    h.runner.on(
      /check-ignore -v/,
      ok(`.gitignore:3:.ai-sdlc/reviews/\t.ai-sdlc/reviews/x.jsonl\n`),
    );
    const r = await preSignRebase(h.ctx, state);
    expect(r).toMatchObject({ kind: 'failed', cause: 'ledger-not-staged' });
    expect((r as { reason: string }).reason).toContain('ledger-not-staged');
    expect((r as { reason: string }).reason).toContain('.gitignore:3:.ai-sdlc/reviews/');
    expect(cmds().some((c) => c.startsWith('git rebase'))).toBe(false);
  });

  it('is unchanged when the ledger exists and is tracked (AISDLC-967)', async () => {
    hashes('A', 'A');
    writeLedger();
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(
      /status --porcelain/,
      ok(` M .ai-sdlc/reviews/${state.taskId.toLowerCase()}.jsonl\n`),
    );
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({ kind: 'unchanged', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(cmds().filter((c) => c.startsWith('git commit'))).toHaveLength(1);
    expect(indexOfCall(/ls-files --error-unmatch/)).toBeLessThan(indexOfCall(/git rebase/));
  });

  it('stages and checks the lowercase ledger path for a mixed-case task id (AISDLC-1017)', async () => {
    hashes('A', 'A');
    writeLedger();
    expect(state.taskId).not.toBe(state.taskId.toLowerCase());
    const path = '.ai-sdlc/reviews/aisdlc-900.jsonl';
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/status --porcelain/, ok(` M ${path}\n`));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({ kind: 'unchanged', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(cmds()).toContain(`git add -- ${path}`);
    expect(cmds()).toContain(`git ls-files --error-unmatch -- ${path}`);
    expect(cmds().some((c) => c.includes('AISDLC-900.jsonl'))).toBe(false);
  });

  it('prints the exact ledger path it checked in ledger-not-staged (AISDLC-1017)', async () => {
    hashes('A', 'A');
    writeLedger();
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/ls-files --error-unmatch/, fail('error: pathspec', 1));
    h.runner.on(/check-ignore -v/, ok(`.gitignore:3:.ai-sdlc/reviews/\tx\n`));
    const r = await preSignRebase(h.ctx, state);
    expect((r as { reason: string }).reason).toContain('.ai-sdlc/reviews/aisdlc-900.jsonl');
    expect(cmds()).toContain('git check-ignore -v --no-index -- .ai-sdlc/reviews/aisdlc-900.jsonl');
  });

  it('makes no commit when leaves and ledger are clean (AISDLC-951)', async () => {
    hashes('A', 'A');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/status --porcelain/, ok(''));
    await preSignRebase(h.ctx, state);
    expect(cmds().filter((c) => c.startsWith('git commit'))).toEqual([]);
  });

  it('treats a base that moved during the rebase as success', async () => {
    hashes('A', 'B');
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    let revs = 0;
    h.runner.on(/rev-parse origin\/main/, () => ok(revs++ === 0 ? 'old\n' : 'new\n'));
    const r = await preSignRebase(h.ctx, state);
    expect(r).toEqual({
      kind: 'changed',
      before: expect.stringMatching(/^[0-9a-f]{64}$/),
      after: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(cmds().filter((c) => c === 'git rebase origin/main')).toHaveLength(1);
  });
});

describe('preSignRebase against real git and the real ledger writer (AISDLC-1021)', () => {
  const TASK_ID = 'AISDLC-1021';
  let base: string;
  let clone: string;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  /** Real git; the content-hash oracle (a node script) is answered with a constant. */
  const realRunner: Runner = async (command, args, opts) => {
    if (command !== 'git') return { stdout: 'H\n', stderr: '', code: 0 };
    try {
      const stdout = execFileSync('git', args, {
        cwd: opts?.cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', code: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
    }
  };

  /** origin + a task clone on a feature branch, with origin/main one commit ahead of the branch point. */
  const setup = (ignoreRule?: string): void => {
    base = mkdtempSync(join(tmpdir(), 'ship-real-git-'));
    const origin = join(base, 'origin.git');
    clone = join(base, 'clone');
    const other = join(base, 'other');
    git(base, 'init', '--bare', '-b', 'main', origin);
    git(base, 'clone', origin, clone);
    writeFileSync(join(clone, 'README.md'), 'one\n');
    if (ignoreRule) writeFileSync(join(clone, '.gitignore'), `${ignoreRule}\n`);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', 'origin', 'HEAD:refs/heads/main');
    git(clone, 'checkout', '-b', 'feature');
    writeFileSync(join(clone, 'feature.txt'), 'f\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'feature work');
    git(base, 'clone', origin, other);
    writeFileSync(join(other, 'main-moved.txt'), 'm\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'main moves');
    git(other, 'push', 'origin', 'HEAD:refs/heads/main');
  };

  const writeRealLedger = (): void =>
    appendReviewLedgerRecord(
      {
        taskId: TASK_ID,
        prNumber: null,
        commitSha: 'a'.repeat(40),
        iteration: 1,
        role: 'code',
        harness: 'claude-code',
        timestamp: '2026-10-22T00:00:00.000Z',
        verdict: 'approved',
        findings: [],
      },
      clone,
    );

  const run = (): ReturnType<typeof preSignRebase> =>
    preSignRebase(
      { ...h.ctx, runner: realRunner },
      { ...state, taskId: TASK_ID, taskIdLower: TASK_ID.toLowerCase(), worktreePath: clone },
    );

  afterEach(() => {
    removeFixtureDir(base);
  });

  it('stages and tracks the ledger the real writer wrote for a mixed-case task id', async () => {
    setup();
    writeRealLedger();
    const r = await run();
    expect(r).not.toMatchObject({ cause: 'ledger-not-staged' });
    const tracked = git(clone, 'ls-files', '--', '.ai-sdlc/reviews/');
    expect(tracked.trim()).toBe('.ai-sdlc/reviews/aisdlc-1021.jsonl');
  });

  it('fails ledger-not-staged naming the ignore rule when the ledger is ignored', async () => {
    setup('.ai-sdlc/reviews/');
    writeRealLedger();
    const r = await run();
    expect(r).toMatchObject({ kind: 'failed', cause: 'ledger-not-staged' });
    expect((r as { reason: string }).reason).toContain('.gitignore:1:.ai-sdlc/reviews/');
  });
});

/** Give the repo a CodeQL workflow that runs on pull requests (task PRs open draft). */
function writeCodeqlOnPr(): void {
  const dir = join(h.ctx.workDir, '.github', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'codeql.yml'),
    'on: [pull_request]\njobs:\n  a:\n    steps:\n      - uses: github/codeql-action/init@v3\n',
  );
}

describe('shipTask: approved path', () => {
  beforeEach(() => {
    giveKey();
    writeCodeqlOnPr();
    writeDemoTaskFile(state.worktreePath);
    writeFileSync(join(state.worktreePath, '.active-task'), 'AISDLC-900\n');
  });

  it('marks Done, writes verdicts, commits, pushes, opens a DRAFT PR, flips ready - in order', async () => {
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
      indexOfCall(/^git push -u origin ai-sdlc\/aisdlc-900-demo-task$/),
      indexOfCall(/^gh pr create --draft/),
      indexOfCall(/format-marker/),
      indexOfCall(/^gh pr ready 77$/),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Staged files never include the attestation directory (RFC-0061: no envelope is produced).
    expect(indexOfCall(/sign-attestation/)).toBe(-1);
    expect(cmds().find((c) => c.startsWith('git add'))).not.toContain('attestations');
  });

  it('never force-pushes or merges, and exports iteration count + harness note to the push', async () => {
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

  it('skips the chore commit when nothing is staged (task file already pre-moved)', async () => {
    giveKey();
    h.runner.on(/^git diff --cached --quiet/, ok(''));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res).toMatchObject({ action: 'done' });
    expect(indexOfCall(/^git commit/)).toBe(-1);
    expect(indexOfCall(/^git push/)).toBeGreaterThan(-1);
  });

  it('opens the PR ready when no pull-request CodeQL exists (AISDLC-1149)', async () => {
    rmSync(join(h.ctx.workDir, '.github'), { recursive: true, force: true });
    scriptShip();
    await shipTask(h.ctx, state);
    const create = h.runner.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
    expect(create.args).not.toContain('--draft');
  });

  it('opens the PR ready when governance.openTaskPrsReady is set (AISDLC-1149)', async () => {
    policyOverride.ready = true;
    scriptShip();
    await shipTask(h.ctx, state);
    const create = h.runner.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')!;
    expect(create.args).not.toContain('--draft');
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

describe('shipTask: never stops for attestation reasons (RFC-0061 Phase 2, AISDLC-1172)', () => {
  beforeEach(() => {
    writeDemoTaskFile(state.worktreePath);
  });

  it('AC-2: ships with no signing key and no envelope on the head', async () => {
    // No giveKey(): there is no ~/.ai-sdlc/signing-key.pem, and no envelope exists anywhere.
    scriptShip();
    h.runner.on(/cat-file -e HEAD:\.ai-sdlc\/attestations\//, fail('missing', 128));
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(cmds().some((c) => /sign-attestation|HEAD:\.ai-sdlc\/attestations/.test(c))).toBe(false);
    expect(indexOfCall(/^git push/)).toBeGreaterThan(-1);
    expect(indexOfCall(/gh pr create/)).toBeGreaterThan(-1);
  });

  it('a push failure stops for git reasons only', async () => {
    h.runner.on(/^git push/, fail('network down', 128));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('push to');
    expect(res.action === 'stop' && res.reason).not.toMatch(/attestation|envelope|Sign step/i);
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

  it('stops when the chore commit fails', async () => {
    giveKey();
    h.runner.on(/^git commit/, fail('hook rejected', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('chore commit failed');
    expect(indexOfCall(/^git push/)).toBe(-1);
  });

  it('gives up after two push attempts and never force-pushes', async () => {
    giveKey();
    h.runner.on(/^git push/, fail('network down', 128));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toContain('network down');
    expect(res.action === 'stop' && res.cause).toBe('push-failed');
    expect(cmds().filter((c) => c.startsWith('git push'))).toHaveLength(2);
    expect(cmds().some((c) => /--force|\s-f(\s|$)/.test(c))).toBe(false);
    expect(indexOfCall(/gh pr create/)).toBe(-1);
  });

  it('stops on a non-fast-forward without deleting or forcing anything', async () => {
    giveKey();
    h.runner.on(/merge-base --is-ancestor/, fail('', 1)); // remote tip is not an ancestor
    h.runner.on(/^git push/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.reason).toMatch(/non-fast-forward[\s\S]*destructive/);
    expect(res.action === 'stop' && res.cause).toBe('push-non-fast-forward');
    expect(cmds().some((c) => /push -f|push --force(?!-with-lease)|branch -[dD]/.test(c))).toBe(
      false,
    );
  });

  it('lands a rebased head with one pinned lease push after a non-fast-forward (AISDLC-1098)', async () => {
    giveKey();
    const sha = 'a'.repeat(40);
    h.runner.on(/rev-parse refs\/remotes\/origin\//, ok(`${sha}\n`));
    h.runner.on(/^git push -u --force-with-lease=/, ok(''));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1)); // remote tip is not an ancestor
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).not.toBe('push-non-fast-forward');
    const leases = cmds().filter((c) => c.includes('--force-with-lease='));
    expect(leases).toHaveLength(1);
    expect(leases[0]).toContain(`:${sha}`);
  });

  it('keeps the abort when the trusted policy forbids a lease push (AISDLC-1098)', async () => {
    giveKey();
    policyOverride.mode = 'never';
    h.runner.on(/rev-parse refs\/remotes\/origin\//, ok(`${'a'.repeat(40)}\n`));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1)); // remote tip is not an ancestor
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).toBe('push-non-fast-forward');
    expect(cmds().some((c) => c.includes('--force-with-lease'))).toBe(false);
  });

  it('keeps the abort when the remote moved since it was last seen (AISDLC-1098)', async () => {
    giveKey();
    let gen = 0;
    h.runner.on(/^git fetch origin ai-sdlc\//, () => {
      gen += 1;
      return ok('');
    });
    h.runner.on(/rev-parse refs\/remotes\/origin\//, () => ok(`${String(gen).repeat(40)}\n`));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1)); // remote tip is not an ancestor
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).toBe('push-non-fast-forward');
    expect(cmds().some((c) => c.includes('--force-with-lease'))).toBe(false);
  });

  it('aborts without a lease push when the remote ref was never seen (AISDLC-1164)', async () => {
    giveKey();
    let fetched = false;
    h.runner.on(/^git fetch origin ai-sdlc\//, () => {
      fetched = true;
      return ok('');
    });
    h.runner.on(/rev-parse refs\/remotes\/origin\//, () =>
      fetched ? ok(`${'b'.repeat(40)}\n`) : fail('unknown revision', 128),
    );
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).toBe('push-non-fast-forward');
    expect(cmds().some((c) => c.includes('--force-with-lease'))).toBe(false);
  });

  it('reports push-failed when the fetch after a rejection fails (AISDLC-1164)', async () => {
    giveKey();
    h.runner.on(/^git fetch origin ai-sdlc\//, fail('network down', 128));
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).toBe('push-failed');
    expect(cmds().some((c) => c.includes('--force-with-lease'))).toBe(false);
  });

  it('reports a hook refusal as push-failed with its stderr, not as a divergence (AISDLC-1164)', async () => {
    giveKey();
    h.runner.on(
      /^git push/,
      fail(
        '[attestation-sign] ERROR: envelope rejected\nerror: failed to push some refs (rejected)',
        1,
      ),
    );
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action === 'stop' && res.cause).toBe('push-failed');
    expect(res.action === 'stop' && res.reason).toContain('envelope rejected');
    expect(res.action === 'stop' && res.reason).not.toContain('destructive');
  });

  it('pushes plainly again when a non-fast-forward line comes with the remote an ancestor (AISDLC-1164)', async () => {
    giveKey();
    let pushes = 0;
    h.runner.on(/^git push/, () => {
      pushes += 1;
      return pushes === 1 ? fail('hook: non-fast-forward text', 1) : ok('');
    });
    h.runner.on(/merge-base --is-ancestor/, ok(''));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(cmds().some((c) => c.includes('--force-with-lease'))).toBe(false);
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

describe('shipTask: verdict ref on every approved push (AISDLC-1193)', () => {
  beforeEach(() => {
    giveKey();
    writeCodeqlOnPr();
    writeDemoTaskFile(state.worktreePath);
    writeFileSync(join(state.worktreePath, '.active-task'), 'AISDLC-900\n');
  });

  const HEAD40 = 'e'.repeat(40);

  function scriptVerdictGit(remoteUrl: string): void {
    const r = h.runner;
    r.on(/^git diff --name-only/, ok('docs/readme.md\n'));
    r.on(/^git config --get remote\.origin\.url/, ok(`${remoteUrl}\n`));
    r.on(/^git merge-base HEAD/, ok('b'.repeat(40) + '\n'));
    r.on(/^git rev-parse HEAD$/, ok(HEAD40 + '\n'));
    r.on(/^git rev-parse HEAD\^\{tree\}/, ok('f'.repeat(40) + '\n'));
    r.on(/^git ls-remote/, ok(''));
    r.on(/^git hash-object/, ok('a'.repeat(40) + '\n'));
    r.on(/^git write-tree/, ok('c'.repeat(40) + '\n'));
    r.on(/^git commit-tree/, ok('d'.repeat(40) + '\n'));
  }

  const pushLine = (): string => cmds().find((c) => c.startsWith('git push')) ?? '';

  it('push-only resume (no reviewers ran, no draft): the push is atomic with a verdict ref', async () => {
    scriptVerdictGit('https://github.com/o/r.git');
    scriptShip();
    expect(state.verdict?.verdictRecordDraft).toBeUndefined();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(pushLine()).toBe(
      `git push -u --atomic origin ai-sdlc/aisdlc-900-demo-task ${'d'.repeat(40)}:refs/ai-sdlc/verdicts/${HEAD40}`,
    );
  });

  it('review-full resume (reviewers approved, draft never attached): the push carries a verdict ref', async () => {
    scriptVerdictGit('git@github.com:o/r.git');
    scriptShip();
    expect(state.verdict?.verdicts).toHaveLength(2);
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(pushLine()).toContain('--atomic');
    expect(pushLine()).toContain(`:refs/ai-sdlc/verdicts/${HEAD40}`);
  });

  it('re-entered round after main moves: the lease push carries the verdict refspec (AISDLC-1196)', async () => {
    scriptVerdictGit('https://github.com/o/r.git');
    const sha = 'a'.repeat(40);
    h.runner.on(/rev-parse refs\/remotes\/origin\//, ok(`${sha}\n`));
    h.runner.on(/^git push -u --atomic --force-with-lease=/, ok(''));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/^git push -u --atomic origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    const lease = cmds().find((c) => c.includes('--force-with-lease='));
    expect(lease).toContain('--atomic');
    expect(lease).toContain(`${'d'.repeat(40)}:refs/ai-sdlc/verdicts/${HEAD40}`);
  });

  it('lease push with no buildable refspec says the verdict ref was not pushed (AISDLC-1196)', async () => {
    scriptVerdictGit('not-a-github-url');
    const sha = 'a'.repeat(40);
    h.runner.on(/rev-parse refs\/remotes\/origin\//, ok(`${sha}\n`));
    h.runner.on(/^git push -u --force-with-lease=/, ok(''));
    h.runner.on(/merge-base --is-ancestor/, fail('', 1));
    h.runner.on(/^git push -u origin/, fail('! [rejected] non-fast-forward', 1));
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    expect(res.action === 'done' && String(res.notes)).toContain('verdict ref not pushed');
  });

  it('an approved push with no ref records the reason in the notes', async () => {
    scriptVerdictGit('/not/a/github/remote');
    scriptShip();
    const res = await shipTask(h.ctx, state);
    expect(res.action).toBe('done');
    if (res.action !== 'done') return;
    expect(pushLine()).toBe('git push -u origin ai-sdlc/aisdlc-900-demo-task');
    expect(res.notes).toContain(
      'verdict ref not pushed: head, tree, base or repository unresolved',
    );
  });
});
