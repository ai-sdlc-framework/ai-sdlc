/**
 * AISDLC-725 AC2: ONE shared incremental decision is used by every review path.
 * These tests fail when a path stops going through it (a later-round prompt built
 * without `planReviewRound` / `cli-incremental-decide plan`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIncrementalDecideCli } from '../cli/incremental-decide.js';
import { buildReviewsCli } from '../cli/reviews.js';
import { appendReviewLedgerRecord, type ReviewLedgerRole } from '../attestation/reviews-ledger.js';
import {
  loadReviewState,
  recordRoundFromVerdicts,
  planReviewRound,
  defaultGitRunner,
} from './review-rounds.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const REPO = resolve(SRC, '..', '..');
const read = (p: string): string => readFileSync(p, 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('every review path goes through the shared decision (AC2)', () => {
  it('the next-step review path and the executor command go through the shared decision', () => {
    const executor = read(join(REPO, 'ai-sdlc-plugin', 'commands', 'executor.md'));
    // The executor runs reviews only through /ai-sdlc execute and says so.
    expect(executor).toContain('/ai-sdlc execute <task-id>');
    expect(executor).toContain('cli-incremental-decide plan');
    // The execute command's review step (next-step) builds prompts through the shared planner
    // and records every round and the developer response; the legacy marker-only gate is gone.
    const prep = read(join(SRC, 'next-step', 'review-prepare.ts'));
    expect(prep).toContain('built.roundPlan');
    expect(prep).not.toMatch(/cli-incremental-decide\.mjs/);
    expect(prep).not.toMatch(/applies to the WHOLE PR/);
    const next = read(join(SRC, 'next-step', 'next-step.ts'));
    expect(next).toContain('recordRoundFromVerdicts(');
    expect(next).toContain('recordDeveloperResponse(');
  });

  it('the step 7 builder calls the planner for every prompt build and feeds the section in', () => {
    const s7 = read(join(SRC, 'steps', '07-build-review-prompts.ts'));
    expect(s7).toMatch(/planReviewRound\(/);
    expect(s7).toMatch(/buildLaterRoundSection\(roundPlan, reviewer\)/);
    // The section is wired into the prompt inputs, not just computed.
    expect(s7).toMatch(/roundSection: buildLaterRoundSection\(roundPlan, reviewer\)/);
  });

  it('step 9 and the pipeline build prompts only through buildReviewPrompts and record every round', () => {
    const s9 = read(join(SRC, 'steps', '09-iterate.ts'));
    expect(s9).toContain('buildReviewPrompts(');
    expect(s9).toContain('recordRoundFromVerdicts(');
    expect(s9).toContain('recordDeveloperResponse(');
    const pipeline = read(join(SRC, 'execute-pipeline.ts'));
    expect(pipeline).toContain('recordRoundFromVerdicts(');
  });

  it('the headless reviewer runner and reconcile use the shared module', () => {
    const runner = read(join(SRC, 'pipeline', 'reviewer-runner.ts'));
    expect(runner).toContain('buildLaterRoundSection(');
    const reconcile = read(join(SRC, 'orchestrator', 'reconcile.ts'));
    expect(reconcile).toContain('recordRoundFromVerdicts(');
    expect(reconcile).toContain('--review-mode');
  });

  it('no other production module builds a reviewer user message or review prompt itself', () => {
    const builders = walk(SRC).filter((f) => {
      const t = read(f);
      return /function buildReviewerUserMessage\(/.test(t);
    });
    expect(builders.map((f) => f.slice(SRC.length + 1))).toEqual(['pipeline/reviewer-runner.ts']);
  });
});

describe('cli-incremental-decide plan / record-round / record-response + cli-reviews rounds', () => {
  let repo: string;
  let scratch: string;
  let out: string[];
  let savedOut: typeof process.stdout.write;
  let savedErr: typeof process.stderr.write;
  const git = (...a: string[]): string =>
    execFileSync('git', a, {
      cwd: repo,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  /** The reviews-ledger record emit-leaf writes for a reviewer that ran at `sha`. */
  const ledger = (
    sha: string,
    role: ReviewLedgerRole,
    approved: boolean,
    taskId = 'AISDLC-9',
  ): void => {
    appendReviewLedgerRecord(
      {
        taskId,
        prNumber: null,
        commitSha: sha,
        iteration: 1,
        role,
        harness: 'claude-code',
        timestamp: '2026-01-01T00:00:00.000Z',
        verdict: approved ? 'approved' : 'rejected',
        findings: [],
      },
      repo,
    );
    // The planner reads the COMMITTED ledger, never the worktree file.
    git('add', '-f', `.ai-sdlc/reviews/${taskId.toLowerCase()}.jsonl`);
    git('commit', '-q', '-m', 'ledger');
  };
  const commit = (path: string, body: string): void => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), body);
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'review-paths-'));
    scratch = mkdtempSync(join(tmpdir(), 'review-paths-scratch-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.ai-sdlc/review-state/\n.ai-sdlc/reviews/\n');
    commit('src/a.ts', 'a1\n');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-q', '-b', 'feature');
    out = [];
    savedOut = process.stdout.write.bind(process.stdout);
    savedErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    removeFixtureDir(repo);
    removeFixtureDir(scratch);
  });

  const run = async (...argv: string[]): Promise<string> => {
    out = [];
    await buildIncrementalDecideCli({ argv }).parseAsync();
    return out.join('');
  };

  it('plans, records a rejected round, then plans a delta round with the delta diff file', async () => {
    commit('src/a.ts', 'a2\n');
    const planFile = join(scratch, 'plan.json');
    writeFileSync(planFile, await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo));
    const first = JSON.parse(read(planFile));
    expect(first).toMatchObject({ round: 1, mode: 'full', reason: 'first-round' });
    expect(first.deltaDiff).toBeUndefined();

    const verdicts = join(scratch, 'verdicts.json');
    writeFileSync(
      verdicts,
      JSON.stringify([
        {
          reviewer: 'code-reviewer',
          approved: false,
          findings: [{ severity: 'major', message: 'FIX_ME' }],
        },
        { reviewer: 'security-reviewer', approved: true, findings: [] },
      ]),
    );
    const rec = JSON.parse(
      await run(
        'record-round',
        '--task-id',
        'AISDLC-9',
        '--repo-root',
        repo,
        '--plan-file',
        planFile,
        '--verdicts-file',
        verdicts,
        '--tokens',
        '500',
      ),
    );
    expect(rec).toMatchObject({ round: 1, approved: false, tokens: 500 });
    ledger(first.headSha, 'code', false);
    ledger(first.headSha, 'security', true);

    const resp = join(scratch, 'resp.txt');
    writeFileSync(resp, 'done');
    expect(
      JSON.parse(
        await run(
          'record-response',
          '--task-id',
          'AISDLC-9',
          '--repo-root',
          repo,
          '--round',
          '1',
          '--text-file',
          resp,
        ),
      ),
    ).toEqual({ ok: true });

    commit('src/a.ts', 'a3\n');
    const diffFile = join(scratch, 'delta.diff');
    const second = JSON.parse(
      await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo, '--diff-out', diffFile),
    );
    expect(second).toMatchObject({ round: 2, mode: 'delta', reason: 'delta-only' });
    expect(second.prior.developerResponse).toBe('done');
    expect(read(diffFile)).toContain('+a3');
    expect(loadReviewState('AISDLC-9', repo).rounds).toHaveLength(1);
  });

  it('--no-skip never chooses skip and a PR-comment mirror seeds a worktree with no state', async () => {
    commit('src/a.ts', 'a2\n');
    const p = planReviewRound({ taskId: 'AISDLC-9', repoRoot: repo, runGit: defaultGitRunner() });
    recordRoundFromVerdicts(repo, 'AISDLC-9', p, [
      { agentId: 'code-reviewer', approved: true, findings: [] },
    ]);
    ledger(p.headSha, 'code', true);
    const noSkip = JSON.parse(
      await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo, '--no-skip'),
    );
    expect(noSkip).toMatchObject({ mode: 'full', reason: 'unchanged' });
    const skip = JSON.parse(await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo));
    expect(skip.mode).toBe('skip');

    // Mirror: a fresh task id with no local state, marker from a trusted comment.
    const comments = join(scratch, 'comments.json');
    const { formatMarker } = await import('./incremental.js');
    writeFileSync(
      comments,
      JSON.stringify([
        {
          authorLogin: 'github-actions',
          authorAssociation: 'NONE',
          body: formatMarker(
            { contentHash: p.contentHash, reviewedSha: p.headSha, reviewedAt: 'x' },
            { version: 1 },
          ),
        },
      ]),
    );
    ledger(p.headSha, 'code', true, 'AISDLC-10');
    commit('src/a.ts', 'a9\n');
    const mirrored = JSON.parse(
      await run(
        'plan',
        '--task-id',
        'AISDLC-10',
        '--repo-root',
        repo,
        '--comments-json-file',
        comments,
      ),
    );
    expect(mirrored).toMatchObject({ mode: 'delta', baseSha: p.headSha });
  });

  it('cli-reviews rounds reports the delta share and tokens per round from the local state', async () => {
    commit('src/a.ts', 'a2\n');
    const p1 = planReviewRound({ taskId: 'AISDLC-9', repoRoot: repo, runGit: defaultGitRunner() });
    recordRoundFromVerdicts(
      repo,
      'AISDLC-9',
      p1,
      [
        { agentId: 'code-reviewer', approved: false, findings: [] },
        { agentId: 'security-reviewer', approved: true, findings: [] },
      ],
      1000,
    );
    ledger(p1.headSha, 'code', false);
    ledger(p1.headSha, 'security', true);
    commit('src/a.ts', 'a3\n');
    const p2 = planReviewRound({ taskId: 'AISDLC-9', repoRoot: repo, runGit: defaultGitRunner() });
    recordRoundFromVerdicts(
      repo,
      'AISDLC-9',
      p2,
      [{ agentId: 'code-reviewer', approved: true, findings: [] }],
      400,
    );
    out = [];
    await buildReviewsCli(['rounds', '--repo-root', repo, '--json']).parseAsync();
    const json = JSON.parse(out.join(''));
    expect(json).toMatchObject({ rounds: 2, laterRounds: 1, laterDeltaRounds: 1, deltaShare: 1 });
    expect(json.avgTokensByRound).toEqual({
      1: { rounds: 1, avgTokens: 1000 },
      2: { rounds: 1, avgTokens: 400 },
    });
    out = [];
    await buildReviewsCli(['rounds', '--repo-root', repo]).parseAsync();
    expect(out.join('')).toContain('run as delta: 1 (100%)');
  });
  it('record-round rejects an empty or malformed verdicts file and records nothing', async () => {
    commit('src/a.ts', 'a2\n');
    const planFile = join(scratch, 'plan.json');
    writeFileSync(planFile, await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo));
    const verdicts = join(scratch, 'verdicts.json');
    const exits: Array<number | undefined> = [];
    const savedExit = process.exit;
    process.exit = ((code?: number) => {
      exits.push(code);
      throw new Error('exit');
    }) as typeof process.exit;
    try {
      for (const body of ['[]', '{"approved":true}', '[{"reviewer":"code-reviewer"}]']) {
        writeFileSync(verdicts, body);
        await expect(
          run(
            'record-round',
            '--task-id',
            'AISDLC-9',
            '--repo-root',
            repo,
            '--plan-file',
            planFile,
            '--verdicts-file',
            verdicts,
          ),
        ).rejects.toThrow('exit');
      }
    } finally {
      process.exit = savedExit;
    }
    expect(exits).toEqual([1, 1, 1]);
    expect(loadReviewState('AISDLC-9', repo).rounds).toHaveLength(0);
  });

  it('record-round stores an approval carrying a major finding as a rejected round', async () => {
    commit('src/a.ts', 'a2\n');
    const planFile = join(scratch, 'plan.json');
    writeFileSync(planFile, await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo));
    const verdicts = join(scratch, 'verdicts.json');
    writeFileSync(
      verdicts,
      JSON.stringify([
        {
          reviewer: 'code-reviewer',
          approved: true,
          findings: [{ severity: 'major', message: 'still broken' }],
        },
      ]),
    );
    const rec = JSON.parse(
      await run(
        'record-round',
        '--task-id',
        'AISDLC-9',
        '--repo-root',
        repo,
        '--plan-file',
        planFile,
        '--verdicts-file',
        verdicts,
      ),
    );
    expect(rec.approved).toBe(false);
    // Unchanged content after that round is never an auto-approve.
    expect(
      JSON.parse(await run('plan', '--task-id', 'AISDLC-9', '--repo-root', repo)),
    ).toMatchObject({
      mode: 'full',
      reason: 'unchanged-after-rejection',
    });
  });
});
