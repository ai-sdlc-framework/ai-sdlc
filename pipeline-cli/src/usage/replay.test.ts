import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModelCalls, recordModelCall, type ModelCallRecord } from '@ai-sdlc/reference';
import {
  appendReviewLedgerRecord,
  type ReviewLedgerRecord,
} from '../attestation/reviews-ledger.js';
import { buildUsageCli } from '../cli/usage.js';
import type { SpawnOpts, SubagentResult, SubagentSpawner } from '../types.js';
import { buildCorpus, labelRecords, readCorpus, type CorpusFile } from './replay-corpus.js';
import {
  activeWorktreeCount,
  cleanupActiveWorktreesSync,
  commitExists,
  createGit,
  isCommitId,
  isSafeRef,
  mergeBaseOf,
  withTempWorktree,
} from './replay-git.js';
import { estimateUnitsPerReview } from './replay-report.js';
import { isOffPeakNow, nextOffPeakStart, parseOffPeakWindow } from './replay-schedule.js';
import {
  interleaveByLabel,
  isValidModel,
  tokensFromOutput,
  verdictOf,
  type SpawnerFactory,
} from './replay-run.js';
import { deriveUnitWeights } from './units.js';
import { defaultUsageConfig } from './usage-config.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const T0 = new Date('2026-09-30T12:00:00Z');

let repo: string;
let artifacts: string;
let usageDir: string;
let tmpRoot: string;
const sha: Record<string, string> = {};

/** Commit a marker file on its own branch off main and return the commit id. */
function commitOnBranch(name: string, file: string, content: string): string {
  git(repo, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(join(repo, file), `${content}\n`);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `change ${name}`);
  const id = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  return id;
}

function rec(
  taskId: string,
  commitSha: string,
  iteration: number,
  verdict: 'approved' | 'rejected',
  severities: Array<'critical' | 'major' | 'minor'> = [],
  role: ReviewLedgerRecord['role'] = 'code',
): ReviewLedgerRecord {
  return {
    taskId,
    prNumber: null,
    commitSha,
    iteration,
    role,
    harness: 'claude-code',
    timestamp: '2026-09-01T00:00:00Z',
    verdict,
    findings: severities.map((severity) => ({
      severity,
      summary: 'FINDING-TEXT-CANARY',
      title: 'finding-text-canary',
    })),
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'replay-repo-'));
  artifacts = mkdtempSync(join(tmpdir(), 'replay-art-'));
  usageDir = mkdtempSync(join(tmpdir(), 'replay-usage-'));
  tmpRoot = mkdtempSync(join(tmpdir(), 'replay-tmp-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'replay-test@example.invalid');
  git(repo, 'config', 'user.name', 'Replay Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '--', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'base');

  for (const t of ['D1', 'D2', 'D3', 'C1', 'C2', 'U1', 'S1']) {
    sha[t] = commitOnBranch(`b-${t}`, `${t}.txt`, `MARKER-${t}`);
  }
  sha.D1fix = commitOnBranch('b-D1fix', 'D1fix.txt', 'MARKER-D1fix');

  // known-defect: blocked at iteration 1, approved at iteration 2.
  for (const t of ['D1', 'D2', 'D3']) {
    appendReviewLedgerRecord(rec(`T-${t}`, sha[t] as string, 1, 'rejected', ['major']), repo);
    appendReviewLedgerRecord(rec(`T-${t}`, sha.D1fix as string, 2, 'approved'), repo);
  }
  // clean: approved first pass.
  for (const t of ['C1', 'C2']) {
    appendReviewLedgerRecord(rec(`T-${t}`, sha[t] as string, 1, 'approved'), repo);
  }
  // blocked and never approved later
  appendReviewLedgerRecord(rec('T-U1', sha.U1 as string, 1, 'rejected', ['critical']), repo);
  // other role: clean security review
  appendReviewLedgerRecord(rec('T-S1', sha.S1 as string, 1, 'approved', [], 'security'), repo);
  // commit that does not exist in the repository
  appendReviewLedgerRecord(rec('T-X1', 'deadbeef'.repeat(5), 1, 'approved'), repo);

  mkdirSync(join(repo, '.ai-sdlc', 'transcript-leaves'), { recursive: true });
  mkdirSync(join(repo, '.ai-sdlc', 'verdicts'), { recursive: true });
  mkdirSync(join(repo, '.ai-sdlc', 'attestations'), { recursive: true });
  writeFileSync(join(repo, '.ai-sdlc', 'transcript-leaves', 'leaf.json'), '{"leaf":1}\n');
  writeFileSync(join(repo, '.ai-sdlc', 'verdicts', 'v.json'), '{"approved":true}\n');
  writeFileSync(join(repo, '.ai-sdlc', 'attestations', 'a.dsse.json'), '{"sig":"x"}\n');
});

afterEach(() => {
  for (const d of [repo, artifacts, usageDir, tmpRoot]) rmSync(d, { recursive: true, force: true });
});

/** Hash every file under a directory, by relative path and bytes. */
function snapshot(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
}

interface Spawned {
  model: string;
  prompt: string;
  cwd: string;
}

function envelope(tokens = { input_tokens: 1000, output_tokens: 100 }): string {
  return JSON.stringify({ type: 'result', usage: tokens });
}

/**
 * Candidate blocks D1, D2 and C1; approves D3 and C2.
 * Reference blocks every item.
 */
function makeSpawner(spawned: Spawned[], opts: { throws?: boolean; noUsage?: boolean } = {}) {
  const create: SpawnerFactory = ({ model, type }) => {
    const spawner: SubagentSpawner = {
      async spawn(o: SpawnOpts): Promise<SubagentResult> {
        spawned.push({ model, prompt: o.prompt, cwd: o.cwd });
        if (opts.throws) throw new Error('spawner exploded');
        expect(o.type).toBe(type);
        const blocks =
          model === 'ref-model'
            ? true
            : ['MARKER-D1', 'MARKER-D2', 'MARKER-C1'].some((m) => o.prompt.includes(m));
        return {
          type: o.type,
          output: opts.noUsage ? '{}' : envelope(),
          parsed: blocks
            ? { approved: false, findings: [{ severity: 'major' }] }
            : { approved: true, findings: [{ severity: 'minor' }] },
          status: 'success',
          durationMs: 1,
        };
      },
      async spawnParallel(list: SpawnOpts[]) {
        return Promise.all(list.map((l) => this.spawn(l)));
      },
    };
    return spawner;
  };
  return create;
}

async function run(
  args: string[],
  extra: Record<string, unknown> = {},
): Promise<{ out: string; err: string; exit: number }> {
  let out = '';
  let err = '';
  let exit = 0;
  await buildUsageCli(args, {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    setExitCode: (c) => void (exit = c),
    now: () => T0,
    usageDir,
    repoRoot: repo,
    workDir: repo,
    artifactsDir: artifacts,
    tmpRoot,
    handleSignals: false,
    priceRows: [],
    loadConfig: () => defaultUsageConfig(),
    ...extra,
  }).parseAsync();
  return { out, err, exit };
}

async function buildCorpusViaCli(): Promise<CorpusFile> {
  const r = await run(['replay-corpus', 'build', '--base-ref', 'main']);
  expect(r.exit).toBe(0);
  const c = readCorpus(join(artifacts, 'replay', 'corpus.json'));
  if (typeof c === 'string') throw new Error(c);
  return c;
}

async function usageRecords(): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls({}, { dir: usageDir })) out.push(r);
  return out;
}

describe('labelRecords', () => {
  it('labels blocked-then-approved as known-defect, first-pass approval as clean, counts the rest', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const { candidates, skipped } = labelRecords([
      rec('K', a, 1, 'rejected', ['major']),
      rec('K', b, 2, 'approved'),
      rec('C', a, 1, 'approved', ['minor']),
      rec('N', a, 1, 'rejected', ['critical']),
      rec('M', a, 1, 'rejected', ['minor']),
      rec('M', a, 1, 'rejected', ['minor']),
      { ...rec('Z', 'not-a-sha', 1, 'approved') },
    ]);
    expect(candidates.map((c) => `${c.taskId}:${c.label}`).sort()).toEqual([
      'C:clean',
      'K:known-defect',
    ]);
    expect(skipped).toMatchObject({
      'not-resolved': 1,
      'not-first-pass-clean': 2,
      duplicate: 1,
      'invalid-record': 1,
    });
  });

  it('does not treat a later iteration as approved when another reviewer still blocks', () => {
    const a = 'a'.repeat(40);
    const { candidates, skipped } = labelRecords([
      rec('K', a, 1, 'rejected', ['major']),
      rec('K', 'b'.repeat(40), 2, 'approved'),
      rec('K', 'b'.repeat(40), 2, 'rejected', ['major'], 'security'),
    ]);
    expect(candidates).toEqual([]);
    expect(skipped['not-resolved']).toBe(2);
  });
});

describe('replay-corpus build', () => {
  it('labels the fixture ledger, skips and counts other shapes, and stores no diff text', async () => {
    const corpus = await buildCorpusViaCli();
    const byTask = Object.fromEntries(corpus.items.map((i) => [`${i.taskId}:${i.role}`, i.label]));
    expect(byTask).toEqual({
      'T-D1:code': 'known-defect',
      'T-D2:code': 'known-defect',
      'T-D3:code': 'known-defect',
      'T-C1:code': 'clean',
      'T-C2:code': 'clean',
      'T-S1:security': 'clean',
    });
    // iteration-2 approvals (3), the unresolved block (1) and the unreachable commit (1).
    expect(corpus.skipped['not-first-pass-clean']).toBe(3);
    expect(corpus.skipped['not-resolved']).toBe(1);
    expect(corpus.skipped.unreachable).toBe(1);
    expect(corpus.items.every((i) => i.mergeBase === git(repo, 'rev-parse', 'main'))).toBe(true);

    const raw = readFileSync(join(artifacts, 'replay', 'corpus.json'), 'utf8');
    expect(raw).not.toContain('MARKER-');
    expect(raw).not.toContain('FINDING-TEXT-CANARY');
    expect(raw).not.toContain('diff --git');
    expect(Object.keys(JSON.parse(raw).items[0]).sort()).toEqual([
      'commitSha',
      'iteration',
      'label',
      'mergeBase',
      'role',
      'taskId',
    ]);
  });

  it('refuses an unsafe base ref and an output under .ai-sdlc', async () => {
    const bad = await run(['replay-corpus', 'build', '--base-ref=--upload-pack=x']);
    expect(bad.exit).toBe(1);
    const under = await run([
      'replay-corpus',
      'build',
      '--base-ref',
      'main',
      '--out',
      join(repo, '.ai-sdlc', 'corpus.json'),
    ]);
    expect(under.exit).toBe(1);
    expect(existsSync(join(repo, '.ai-sdlc', 'corpus.json'))).toBe(false);
  });

  it('counts a commit with no merge base as unreachable', async () => {
    const c = await buildCorpus({
      records: [rec('T-D1', sha.D1 as string, 1, 'approved')],
      git: createGit(),
      repoRoot: repo,
      baseRef: 'no-such-branch',
      now: T0,
    });
    expect(c.items).toEqual([]);
    expect(c.skipped.unreachable).toBe(1);
  });

  it('readCorpus reports a missing, damaged or wrongly shaped file', () => {
    expect(readCorpus(join(artifacts, 'nope.json'))).toContain('No replay corpus');
    writeFileSync(join(artifacts, 'bad.json'), '{');
    expect(readCorpus(join(artifacts, 'bad.json'))).toContain('not valid JSON');
    writeFileSync(join(artifacts, 'shape.json'), '{"schemaVersion":"v2"}');
    expect(readCorpus(join(artifacts, 'shape.json'))).toContain('unexpected shape');
  });
});

describe('replay', () => {
  it('scores recall and false-block rate against a hand calculation, with counts', async () => {
    await buildCorpusViaCli();
    const spawned: Spawned[] = [];
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner(spawned) },
    );
    expect(r.exit).toBe(0);
    // 3 known-defect items, candidate blocks 2 of them; 2 clean items, blocks 1.
    expect(r.out).toContain('recall 67% (2/3)');
    expect(r.out).toContain('false-block 50% (1/2)');
    expect(r.out).toContain('mean units/review 1,500 over 5 review(s)');
    expect(r.out).toContain('every corpus item for this role was replayed');
    expect(spawned).toHaveLength(5);
    // The prompt carries the diff from the merge base to the reviewed commit.
    const d1 = spawned.find((s) => s.prompt.includes('MARKER-D1'));
    expect(d1?.prompt).toContain('+MARKER-D1');
    expect(d1?.prompt).not.toContain('MARKER-D2');
    expect(d1?.prompt).toContain('You are the code-reviewer');
    // The results file holds counts and ids only.
    const file = readdirSync(join(artifacts, 'replay')).find((n) => n.startsWith('results-'));
    const raw = readFileSync(join(artifacts, 'replay', file as string), 'utf8');
    expect(raw).not.toContain('MARKER-');
    expect(raw).not.toContain('You are the');
    expect(JSON.parse(raw).scores[0]).toMatchObject({ recall: 2 / 3, falseBlockRate: 0.5 });
  });

  it('also replays a reference model on the same items', async () => {
    await buildCorpusViaCli();
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--reference-model',
        'ref-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner([]) },
    );
    expect(r.out).toContain('ref-model: recall 100% (3/3), false-block 100% (2/2)');
    expect(r.out).toContain('cand-model: recall 67% (2/3)');
  });

  it('stops at --max-items and says so', async () => {
    await buildCorpusViaCli();
    const spawned: Spawned[] = [];
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '2',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner(spawned) },
    );
    expect(spawned).toHaveLength(2);
    expect(r.out).toContain('Stopped: reached --max-items.');
    // Labels alternate so a short run sees both.
    expect(r.out).toContain('recall 100% (1/1), false-block 100% (1/1)');
  });

  it('stops at --max-units and says so', async () => {
    await buildCorpusViaCli();
    const spawned: Spawned[] = [];
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '3000',
      ],
      { createSpawner: makeSpawner(spawned) },
    );
    expect(spawned).toHaveLength(2);
    expect(r.out).toContain('Stopped: reached --max-units');
  });

  it('records usage under the replay task id and never under a real task', async () => {
    await buildCorpusViaCli();
    await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '2',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner([]) },
    );
    const records = await usageRecords();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r).toMatchObject({
        taskId: 'replay',
        scope: 'framework',
        agentRole: 'replay:code-reviewer',
        model: 'cand-model',
        tokens: { input: 1000, output: 100 },
      });
    }
  });

  it('keeps replay usage out of the scorecard and adds reviewer rows from a results file', async () => {
    await buildCorpusViaCli();
    await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner([]) },
    );
    const file = readdirSync(join(artifacts, 'replay')).find((n) =>
      n.startsWith('results-'),
    ) as string;
    const resultsPath = join(artifacts, 'replay', file);
    const text = await run(['scorecard', '--replay-results', resultsPath]);
    expect(text.out).toContain('Reviewer replay');
    expect(text.out).toContain('67% (2/3)');
    expect(text.out).toContain('50% (1/2)');
    expect(text.out).not.toContain(
      'Tasks with usage but no review outcome (excluded from approval rates): 1',
    );
    const json = JSON.parse(
      (await run(['scorecard', '--format', 'json', '--replay-results', resultsPath])).out,
    );
    expect(json.replay[0]).toMatchObject({ role: 'code', model: 'cand-model' });
    expect(json.noOutcome).toBe(0);

    const missing = await run(['scorecard', '--replay-results', join(artifacts, 'missing.json')]);
    expect(missing.exit).toBe(1);
    writeFileSync(join(artifacts, 'x.json'), '{"schemaVersion":"v1"}');
    expect((await run(['scorecard', '--replay-results', join(artifacts, 'x.json')])).exit).toBe(1);
    writeFileSync(join(artifacts, 'y.json'), '{');
    expect((await run(['scorecard', '--replay-results', join(artifacts, 'y.json')])).exit).toBe(1);
  });

  it('leaves the reviews ledger, leaves, verdicts and attestations byte-identical and removes worktrees', async () => {
    await buildCorpusViaCli();
    const before = snapshot(join(repo, '.ai-sdlc'));
    const statusBefore = git(repo, 'status', '--porcelain');
    const worktreesBefore = git(repo, 'worktree', 'list', '--porcelain');
    await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner([]) },
    );
    expect(snapshot(join(repo, '.ai-sdlc'))).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(activeWorktreeCount()).toBe(0);
  });

  it('sweeps its worktree when the spawner throws and the run continues', async () => {
    await buildCorpusViaCli();
    const spawned: Spawned[] = [];
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner(spawned, { throws: true }) },
    );
    expect(r.exit).toBe(0);
    expect(spawned).toHaveLength(5);
    expect(r.out).toContain('5 error(s) not scored');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('ai-sdlc-replay-');
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('reports reviews that carry no token counts instead of inventing units', async () => {
    await buildCorpusViaCli();
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '1',
        '--max-units',
        '10',
      ],
      { createSpawner: makeSpawner([], { noUsage: true }) },
    );
    expect(r.out).toContain('1 review(s) reported no token counts');
    expect(await usageRecords()).toHaveLength(0);
  });

  it('skips an unreachable commit, counts it, and keeps going', async () => {
    await buildCorpusViaCli();
    const path = join(artifacts, 'replay', 'corpus.json');
    const corpus = JSON.parse(readFileSync(path, 'utf8')) as CorpusFile;
    corpus.items.unshift({
      taskId: 'T-GONE',
      role: 'code',
      commitSha: 'c'.repeat(40),
      mergeBase: 'd'.repeat(40),
      label: 'clean',
      iteration: 1,
    });
    writeFileSync(path, JSON.stringify(corpus));
    const spawned: Spawned[] = [];
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '10',
        '--max-units',
        '1000000',
      ],
      { createSpawner: makeSpawner(spawned) },
    );
    expect(r.out).toContain('5 item(s) replayed, 1 skipped (commit no longer reachable)');
    expect(spawned).toHaveLength(5);
  });

  it('dry run calls no model and prints items and an estimate from reviewer usage on record', async () => {
    await buildCorpusViaCli();
    // Reviewer usage on record: two tasks, 1000 input tokens each => 1000 units per review.
    const repoName = repo.split('/').pop() as string;
    for (const taskId of ['AISDLC-1', 'AISDLC-2']) {
      recordModelCall(
        {
          provider: 'anthropic',
          model: 'cand-model',
          tokens: { input: 1000 },
          agentRole: 'ai-sdlc:code-reviewer',
          scope: 'framework',
          repo: repoName,
          taskId,
          ts: '2026-09-20T00:00:00Z',
        },
        { dir: usageDir },
      );
    }
    let created = 0;
    const r = await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '3',
        '--max-units',
        '5000',
        '--dry-run',
      ],
      {
        createSpawner: () => {
          created++;
          throw new Error('no model may be created in a dry run');
        },
      },
    );
    expect(created).toBe(0);
    expect(r.exit).toBe(0);
    expect(r.out).toContain('Dry run: no model is called. 3 of 5 corpus item(s)');
    expect(r.out).toContain('T-D1');
    expect(r.out).toContain('Estimate: about 3,000 units');
    expect(r.out).toContain('over 2 review(s) on record');
    expect(await usageRecords()).toHaveLength(2);
    expect(existsSync(join(artifacts, 'replay', 'results-code-20260930T120000Z.json'))).toBe(false);
  });

  it('dry run says so when no reviewer usage is on record', async () => {
    await buildCorpusViaCli();
    const r = await run([
      'replay',
      '--role',
      'code',
      '--model',
      'cand-model',
      '--max-items',
      '3',
      '--max-units',
      '5000',
      '--dry-run',
    ]);
    expect(r.out).toContain('no reviewer usage is on record');
  });

  it('defers outside the off-peak window and runs inside it', async () => {
    await buildCorpusViaCli();
    const spawned: Spawned[] = [];
    const base = [
      'replay',
      '--role',
      'code',
      '--model',
      'cand-model',
      '--max-items',
      '1',
      '--max-units',
      '100000',
      '--off-peak',
    ];
    const outside = await run([...base, '--off-peak-window', 'UTC@22-06'], {
      createSpawner: makeSpawner(spawned),
    });
    expect(outside.out).toContain('Deferred: outside the off-peak window');
    expect(outside.out).toContain('2026-09-30T22:00:00.000Z');
    expect(spawned).toHaveLength(0);
    const inside = await run([...base, '--off-peak-window', 'UTC@10-14'], {
      createSpawner: makeSpawner(spawned),
    });
    expect(inside.out).toContain('Reviewer replay');
    expect(spawned).toHaveLength(1);
    expect((await run(base)).exit).toBe(1);
    expect((await run([...base, '--off-peak-window', 'bogus'])).exit).toBe(1);
  });

  it('rejects bad input before doing any work', async () => {
    await buildCorpusViaCli();
    const ok = ['--role', 'code', '--max-items', '1', '--max-units', '10'];
    const make = (): { createSpawner: SpawnerFactory } => ({
      createSpawner: () => {
        throw new Error('must not run');
      },
    });
    expect((await run(['replay', ...ok, '--model=--evil'], make())).exit).toBe(1);
    expect((await run(['replay', ...ok, '--model', 'a b'], make())).exit).toBe(1);
    expect(
      (await run(['replay', ...ok, '--model', 'm', '--reference-model', 'bad;x'], make())).exit,
    ).toBe(1);
    expect(
      (
        await run(
          ['replay', '--role', 'code', '--model', 'm', '--max-items', '0', '--max-units', '10'],
          make(),
        )
      ).exit,
    ).toBe(1);
    expect(
      (
        await run(
          ['replay', '--role', 'code', '--model', 'm', '--max-items', '1', '--max-units', '0'],
          make(),
        )
      ).exit,
    ).toBe(1);
    expect(
      (
        await run(
          ['replay', ...ok, '--model', 'm', '--corpus', join(artifacts, 'none.json')],
          make(),
        )
      ).exit,
    ).toBe(1);
    expect(
      (
        await run(['replay', ...ok, '--model', 'm'], {
          ...make(),
          artifactsDir: join(repo, '.ai-sdlc', 'a'),
        })
      ).exit,
    ).toBe(1);
    expect(
      (
        await run(
          [
            'replay',
            '--role',
            'correctness',
            '--model',
            'm',
            '--max-items',
            '1',
            '--max-units',
            '10',
          ],
          make(),
        )
      ).exit,
    ).toBe(1);
  });

  it('adds and removes signal handlers around a run', async () => {
    await buildCorpusViaCli();
    const before = process.listenerCount('SIGINT');
    await run(
      [
        'replay',
        '--role',
        'code',
        '--model',
        'cand-model',
        '--max-items',
        '1',
        '--max-units',
        '100000',
      ],
      { createSpawner: makeSpawner([]), handleSignals: true },
    );
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('temporary worktrees', () => {
  it('validates ids and refs', () => {
    expect(isCommitId('a'.repeat(40))).toBe(true);
    expect(isCommitId('A'.repeat(40))).toBe(false);
    expect(isCommitId('a'.repeat(39))).toBe(false);
    expect(isCommitId('--upload-pack=x')).toBe(false);
    expect(isSafeRef('origin/main')).toBe(true);
    for (const bad of ['-x', 'a..b', 'a b', 'a;b', 'a/', 'x.lock', '', 'HEAD~1', 'a$(x)']) {
      expect(isSafeRef(bad)).toBe(false);
    }
    expect(isValidModel('claude-sonnet-4-6')).toBe(true);
    expect(isValidModel('-m')).toBe(false);
  });

  it('refuses a value that is not a commit id', async () => {
    await expect(withTempWorktree(createGit(), repo, '--help', async () => 1)).rejects.toThrow(
      /not a commit id/,
    );
    expect(await commitExists(createGit(), repo, 'x')).toBe(false);
    expect(await mergeBaseOf(createGit(), repo, 'x', 'main')).toBeUndefined();
  });

  it('removes the worktree when the callback throws', async () => {
    let seen = '';
    await expect(
      withTempWorktree(
        createGit(),
        repo,
        sha.D1 as string,
        async (wt) => {
          seen = wt;
          expect(existsSync(join(wt, 'D1.txt'))).toBe(true);
          expect(activeWorktreeCount()).toBe(1);
          throw new Error('boom');
        },
        { tmpRoot },
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('ai-sdlc-replay-');
  });

  it('sweeps live worktrees synchronously, as a signal handler does', async () => {
    let seen = '';
    await withTempWorktree(
      createGit(),
      repo,
      sha.D1 as string,
      async (wt) => {
        seen = wt;
        expect(cleanupActiveWorktreesSync()).toBe(1);
        expect(existsSync(wt)).toBe(false);
      },
      { tmpRoot },
    );
    expect(existsSync(seen)).toBe(false);
    expect(activeWorktreeCount()).toBe(0);
  });

  it('fails cleanly when the commit cannot be checked out', async () => {
    await expect(
      withTempWorktree(createGit(), repo, 'e'.repeat(40), async () => 1, { tmpRoot }),
    ).rejects.toThrow(/temporary worktree/);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(activeWorktreeCount()).toBe(0);
  });
});

describe('replay helpers', () => {
  it('verdictOf blocks on not approved or a severe finding and errors without a verdict', () => {
    const mk = (parsed: unknown, status: SubagentResult['status'] = 'success'): SubagentResult => ({
      type: 'code-reviewer',
      output: '',
      parsed,
      status,
      durationMs: 1,
    });
    expect(verdictOf(mk({ approved: true, findings: [] })).outcome).toBe('approve');
    expect(verdictOf(mk({ approved: true, findings: [{ severity: 'Critical' }] })).outcome).toBe(
      'block',
    );
    expect(verdictOf(mk({ approved: false })).outcome).toBe('block');
    expect(verdictOf(mk({ approved: true, findings: [{ severity: 'minor' }] })).outcome).toBe(
      'approve',
    );
    expect(verdictOf(mk(undefined)).outcome).toBe('error');
    expect(verdictOf(mk({ approved: 'yes' })).outcome).toBe('error');
    expect(verdictOf(mk({ approved: true }, 'timeout')).outcome).toBe('error');
  });

  it('tokensFromOutput reads counts and cache splits only', () => {
    expect(tokensFromOutput('not json')).toBeUndefined();
    expect(tokensFromOutput('{"usage":null}')).toBeUndefined();
    expect(
      tokensFromOutput(
        JSON.stringify({
          usage: {
            input_tokens: 5,
            output_tokens: 6,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 8,
          },
        }),
      ),
    ).toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite5m: 8, cacheWrite1h: 0 });
    expect(
      tokensFromOutput(
        JSON.stringify({
          usage: {
            input_tokens: -1,
            cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
          },
        }),
      ),
    ).toMatchObject({ input: 0, cacheWrite5m: 2, cacheWrite1h: 3 });
  });

  it('interleaves labels deterministically', () => {
    const item = (label: 'clean' | 'known-defect', n: number) => ({
      taskId: `T${n}`,
      role: 'code' as const,
      commitSha: 'a'.repeat(40),
      mergeBase: 'b'.repeat(40),
      label,
      iteration: 1,
    });
    const out = interleaveByLabel([
      item('clean', 1),
      item('clean', 2),
      item('clean', 3),
      item('known-defect', 4),
    ]);
    expect(out.map((i) => i.taskId)).toEqual(['T4', 'T1', 'T2', 'T3']);
  });

  it('estimates mean units per review per task and ignores replay calls', () => {
    const weights = deriveUnitWeights([], T0.toISOString());
    const call = (taskId: string, agentRole: string, input: number): ModelCallRecord => ({
      schemaVersion: 'v1',
      callId: `${taskId}-${agentRole}-${input}`,
      ts: '2026-09-20T00:00:00Z',
      harness: 'direct',
      provider: 'anthropic',
      model: 'm',
      tokens: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      billingPool: 'unknown',
      sessionId: 's',
      agentRole,
      scope: 'framework',
      taskId,
    });
    const est = estimateUnitsPerReview(
      [
        call('A', 'ai-sdlc:code-reviewer', 100),
        call('A', 'code-reviewer', 300),
        call('B', 'code-reviewer', 200),
        call('replay', 'replay:code-reviewer', 9999),
        call('C', 'test-reviewer', 50),
      ],
      'code',
      weights,
    );
    expect(est).toEqual({ reviewsOnRecord: 2, meanUnitsPerReview: 300 });
    expect(estimateUnitsPerReview([], 'code', weights).meanUnitsPerReview).toBeNull();
  });
});

describe('off-peak windows', () => {
  it('parses and rejects windows', () => {
    expect(parseOffPeakWindow('UTC@22-06')).toMatchObject({ tz: 'UTC', startHour: 22, endHour: 6 });
    expect(parseOffPeakWindow('UTC@0-24@Sat,Sun')).toMatchObject({ days: new Set(['Sat', 'Sun']) });
    for (const bad of [
      'UTC',
      'UTC@x',
      'UTC@5-5',
      'UTC@25-3',
      'Mars/Base@1-2',
      'UTC@1-2@Funday',
      'a@b@c@d',
    ]) {
      expect(typeof parseOffPeakWindow(bad)).toBe('string');
    }
  });

  it('wraps midnight, honours days and finds the next start', () => {
    const w = parseOffPeakWindow('UTC@22-06');
    const windows = [w as Exclude<typeof w, string>];
    expect(isOffPeakNow(windows, new Date('2026-09-30T23:00:00Z'))).toBe(true);
    expect(isOffPeakNow(windows, new Date('2026-09-30T05:59:00Z'))).toBe(true);
    expect(isOffPeakNow(windows, new Date('2026-09-30T06:00:00Z'))).toBe(false);
    expect(nextOffPeakStart(windows, new Date('2026-09-30T12:00:00Z'))?.toISOString()).toBe(
      '2026-09-30T22:00:00.000Z',
    );
    const weekend = parseOffPeakWindow('UTC@0-24@Sat,Sun') as Exclude<
      ReturnType<typeof parseOffPeakWindow>,
      string
    >;
    expect(isOffPeakNow([weekend], new Date('2026-09-30T12:00:00Z'))).toBe(false); // Wednesday
    expect(isOffPeakNow([weekend], new Date('2026-10-03T12:00:00Z'))).toBe(true); // Saturday
    expect(nextOffPeakStart([weekend], new Date('2026-09-30T12:00:00Z'))?.toISOString()).toBe(
      '2026-10-03T00:00:00.000Z',
    );
    expect(nextOffPeakStart([], new Date())).toBeUndefined();
  });
});
