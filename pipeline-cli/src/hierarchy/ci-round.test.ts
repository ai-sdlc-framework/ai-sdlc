import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import {
  buildCiRoundNote,
  CI_LOG_TAIL_BYTES,
  CI_LOG_TAIL_LINES,
  tailLog,
  writeCiRoundNote,
} from './ci-round.js';
import {
  ciRoundsOf,
  commandExecutor,
  decide,
  type LandingRecord,
  type ReconcilePr,
} from './reconcile.js';
import { formatPrTable } from './pr-rows.js';
import { loadPrLifecycleConfig } from './pr-lifecycle-config.js';
import type { CommandRunner } from './types.js';

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
const bad = { status: 1, stdout: '', stderr: 'nope' };

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(os.tmpdir(), 'ci-round-'));
});
afterEach(() => removeFixtureDir(board));

const JOBS = JSON.stringify({
  jobs: [
    { name: 'build', conclusion: 'success', steps: [] },
    {
      name: 'test',
      conclusion: 'failure',
      steps: [
        { name: 'Install', conclusion: 'success' },
        { name: 'Run unit tests', conclusion: 'failure' },
      ],
    },
  ],
});

function runner(logs: { jobs?: string; log?: string; runId?: string }): CommandRunner {
  return (_f, args) => {
    if (args[0] === 'run' && args[1] === 'list') return logs.runId ? ok(logs.runId) : ok('null');
    if (args.includes('--json')) return logs.jobs ? ok(logs.jobs) : bad;
    if (args.includes('--log-failed')) return logs.log === undefined ? bad : ok(logs.log);
    return bad;
  };
}

describe('tailLog', () => {
  it('strips ANSI and caps lines and bytes', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `\u001b[31mline ${i}\u001b[0m`).join('\n');
    const t = tailLog(raw);
    expect(t).not.toContain('\u001b');
    expect(t.split('\n').length).toBeLessThanOrEqual(CI_LOG_TAIL_LINES);
    expect(t).toContain('line 499');
    expect(t).not.toContain('line 0\n');
    const wide = tailLog('x'.repeat(10_000));
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(CI_LOG_TAIL_BYTES);
  });
});

describe('buildCiRoundNote (AISDLC-1231)', () => {
  it('names the failed step, the head and the log tail', () => {
    const note = buildCiRoundNote(
      runner({ runId: '55', jobs: JOBS, log: 'boom\nassert failed' }),
      board,
      {
        pr: 9,
        headSha: 'abc1234def',
      },
    );
    expect(note).toContain('test / Run unit tests');
    expect(note).toContain('abc1234def');
    expect(note).toContain('assert failed');
  });

  it('says so when the log cannot be fetched and still produces a note', () => {
    const note = buildCiRoundNote(runner({ runId: '55', jobs: JOBS }), board, {
      pr: 9,
      headSha: 'abc',
    });
    expect(note).toContain('could not be fetched');
    const none = buildCiRoundNote(runner({}), board, {
      pr: 9,
      headSha: 'abc',
      failingLine: 'x red',
    });
    expect(none).toContain('x red');
    expect(none).toContain('could not be fetched');
  });

  it('stays within the note limit for a huge log', () => {
    const note = buildCiRoundNote(
      runner({ runId: '1', jobs: JOBS, log: 'y'.repeat(100_000) }),
      board,
      {
        pr: 9,
        headSha: 'abc',
      },
    );
    expect(note.length).toBeLessThanOrEqual(4000);
  });
});

describe('commandExecutor CI round', () => {
  it('reenters a delivered task PR with a developer round and a note file', () => {
    const calls: string[][] = [];
    const run: CommandRunner = (f, args, o) => {
      calls.push([f, ...args]);
      return runner({ runId: '55', jobs: JOBS, log: 'assert failed' })(f, args, o);
    };
    const exec = commandExecutor(run, board, '/bin');
    const r = exec({
      pr: 9,
      taskId: 'AISDLC-1',
      kind: 'task',
      action: 'reenter',
      state: 'real-failure',
      headSha: 'abc1234def',
      failingLine: 'x',
      boardDir: board,
    });
    expect(r.ran).toBe(true);
    const re = calls.find((c) => c.some((a) => a.endsWith('cli-dispatch.mjs')))!;
    expect(re).toContain('--developer-round');
    const file = re[re.indexOf('--note-file') + 1]!;
    const text = readFileSync(file, 'utf-8');
    expect(text).toContain('test / Run unit tests');
    expect(text).toContain('assert failed');
    expect(text).toContain('abc1234def');
    expect(file).toBe(writeCiRoundNote(board, 9, 'abc1234def', text));
  });

  it('a docs PR keeps the plain action', () => {
    const calls: string[][] = [];
    const run: CommandRunner = (f, args) => {
      calls.push([f, ...args]);
      return ok('');
    };
    commandExecutor(
      run,
      board,
      '/bin',
    )({
      pr: 9,
      taskId: '',
      kind: 'docs',
      action: 'reenter',
      state: 'real-failure',
      headSha: 'abc',
      boardDir: board,
    });
    expect(calls.flat()).not.toContain('--note-file');
  });
});

const hist = (n: number, head = (i: number) => `H${i}`): LandingRecord['history'] =>
  Array.from({ length: n }, (_, i) => ({
    ts: 't',
    state: 'real-failure' as const,
    action: 'reenter',
    headSha: head(i),
  }));

const record = (history: LandingRecord['history'], action = 'none'): LandingRecord => ({
  pr: 9,
  kind: 'task',
  taskId: 'AISDLC-1',
  owner: 'machine',
  state: 'pending',
  action,
  headSha: 'Hx',
  history,
});

const red: ReconcilePr = {
  prNumber: 9,
  taskId: 'AISDLC-1',
  draft: false,
  autoMergeArmed: false,
  headBranch: 'ai-sdlc/aisdlc-1',
  headSha: 'HNEW',
  checks: [{ name: 'ai-sdlc/pr-ready', conclusion: 'failure', summary: 'x' }],
};

describe('CI round bound (AISDLC-1231)', () => {
  it('rounds one to three reenter; the fourth routes to the planner', () => {
    expect(decide(red, record(hist(2))).action).toBe('reenter');
    const d = decide(red, record(hist(3)));
    expect(d.action).toBe('route-to-planner');
    expect(d.note).toBe('ci-rounds@4');
  });

  it('a round on the previous round head routes to the planner', () => {
    const d = decide({ ...red, headSha: 'H0' }, record(hist(1)));
    expect(d).toMatchObject({ action: 'route-to-planner', note: 'ci-rounds@2' });
  });

  it('maxCiRounds is honoured', () => {
    expect(decide(red, record(hist(1)), undefined, 1, 1).note).toBe('ci-rounds@2');
  });

  it('the pass after an ordered round on the same head is a no-op, not a route', () => {
    const rec = {
      ...record(
        hist(1, () => 'HNEW'),
        'reenter',
      ),
      headSha: 'HNEW',
    };
    expect(decide(red, rec).action).toBe('reenter');
  });

  it('a green head resets the count', () => {
    const h = [
      ...hist(3),
      { ts: 't', state: 'armed-clean' as const, action: 'none', headSha: 'G' },
    ];
    expect(ciRoundsOf(record(h))).toBe(0);
    expect(ciRoundsOf(undefined)).toBe(0);
  });

  it('docs PRs and non-check failures keep their actions', () => {
    const docs = { ...red, headBranch: 'docs/x', taskId: '' };
    expect(decide(docs, record(hist(5))).action).toBe('route-to-planner');
    expect(decide(docs, record(hist(5))).note).toBeUndefined();
    const dirty = { ...red, checks: [], mergeStateStatus: 'DIRTY' };
    expect(decide(dirty, record(hist(5))).action).toBe('land-prep');
    const review = {
      ...red,
      checks: [
        {
          name: 'ai-sdlc/attestation',
          conclusion: 'failure' as const,
          summary: 'content hash mismatch',
        },
      ],
    };
    expect(decide(review, record(hist(5))).action).toBe('review-resume');
  });

  it('reads maxCiRounds from the lifecycle yaml default', () => {
    expect(loadPrLifecycleConfig(board).maxCiRounds).toBe(3);
  });

  it('the status table shows ci-round n/3', () => {
    const rows = (rounds: number) => {
      const rec = record(hist(rounds));
      const dir = path.join(board, 'landing');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '9.json'), JSON.stringify(rec));
      return formatPrTable(board, Date.now());
    };
    expect(rows(2).join('\n')).toContain('ci-round 2/3');
    expect(rows(0).join('\n')).not.toContain('ci-round');
  });
});
