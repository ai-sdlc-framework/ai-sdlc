/**
 * `cli-decisions evidence check|hash` (AISDLC-1451): drive the yargs program
 * in-process, as decisions.test.ts does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDecisionsCli } from './decisions.js';
import { draftSha256 } from '../decisions/evidence-ledger.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let tmp: string;
let out: string[];
let err: string[];
const saved = {
  argv: process.argv,
  write: process.stdout.write,
  errWrite: process.stderr.write,
  exit: process.exit,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-evidence-'));
  out = [];
  err = [];
  saved.argv = process.argv;
  saved.write = process.stdout.write;
  saved.errWrite = process.stderr.write;
  saved.exit = process.exit;
  process.stdout.write = ((c: string) => (
    out.push(String(c)),
    true
  )) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (
    err.push(String(c)),
    true
  )) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  mkdirSync(join(tmp, 'src'));
  writeFileSync(join(tmp, 'src', 'a.ts'), 'export const A = 1;\n');
  writeFileSync(join(tmp, 'draft.md'), 'Pick A.\n');
});

afterEach(() => {
  process.argv = saved.argv;
  process.stdout.write = saved.write;
  process.stderr.write = saved.errWrite;
  process.exit = saved.exit;
  removeFixtureDir(tmp);
});

async function run(...args: string[]): Promise<void> {
  process.argv = ['node', 'cli-decisions', '--work-dir', tmp, ...args];
  await buildDecisionsCli().parseAsync();
}

function writeLedger(quote: string): string {
  const p = join(tmp, 'ledger.json');
  writeFileSync(
    p,
    JSON.stringify({
      schemaVersion: 1,
      ref: 'some-slug',
      draftSha256: draftSha256('Pick A.'),
      researchedBy: 'Explore (sonnet)',
      researchedAt: '2026-11-27T10:00:00Z',
      entries: [
        {
          id: 'f1',
          kind: 'fact',
          claim: 'A is 1',
          status: 'checked',
          source: { file: 'src/a.ts', line: 1, quote },
        },
      ],
    }),
  );
  return p;
}

describe('cli-decisions evidence', () => {
  it('hash prints the draftSha256', async () => {
    await run('evidence', 'hash', join(tmp, 'draft.md'));
    expect(out.join('').trim()).toBe(draftSha256('Pick A.'));
  });

  it('hash fails on a missing draft', async () => {
    await expect(run('evidence', 'hash', join(tmp, 'none.md'))).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/cannot read draft/);
  });

  it('check passes a good ledger against its draft', async () => {
    const p = writeLedger('A = 1');
    await run('evidence', 'check', p, '--draft', join(tmp, 'draft.md'));
    expect(out.join('')).toMatch(/evidence ledger passes/);
  });

  it('check exits non-zero and lists each failing entry', async () => {
    const p = writeLedger('A = 2');
    writeFileSync(join(tmp, 'draft.md'), 'Pick B.\n');
    await expect(
      run('evidence', 'check', p, '--draft', join(tmp, 'draft.md'), '--format', 'json'),
    ).rejects.toThrow(/exit\(1\)/);
    const json = JSON.parse(out.join('')) as { ok: boolean; failures: unknown[] };
    expect(json.ok).toBe(false);
    expect(json.failures).toHaveLength(2);
    expect(err.join('')).toMatch(/f1: quote not found in src\/a\.ts/);
    expect(err.join('')).toMatch(/ledger: draftSha256 does not match/);
  });

  it('check fails on an unreadable ledger or draft', async () => {
    await expect(run('evidence', 'check', join(tmp, 'none.json'))).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/cannot read ledger/);
    const p = writeLedger('A = 1');
    await expect(run('evidence', 'check', p, '--draft', join(tmp, 'none.md'))).rejects.toThrow(
      /exit\(1\)/,
    );
    expect(err.join('')).toMatch(/cannot read draft/);
  });
});

describe('decision gate (AISDLC-1452)', () => {
  const ADD = ['add', '--summary', 'Pick a store', '--scope', 'workspace', '--option', 'a:A'];
  const stored = (id: string): string =>
    join(tmp, '.ai-sdlc', 'decisions', 'evidence', `${id}.json`);
  const answer = (...extra: string[]): Promise<void> =>
    run('answer', 'DEC-0001', 'a', '--by', 'op@test', '--rationale', 'r', ...extra);

  it('add refuses with no --evidence and names the re-check command', async () => {
    await expect(run(...ADD)).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/--evidence <ledger> is required/);
    expect(err.join('')).toMatch(/cli-decisions\.mjs evidence check/);
  });

  it('add refuses a failing ledger, naming the failing entry and the re-check command', async () => {
    const p = writeLedger('A = 2');
    await expect(run(...ADD, '--evidence', p)).rejects.toThrow(/exit\(1\)/);
    const msg = err.join('');
    expect(msg).toMatch(/add: refused, no passing evidence ledger/);
    expect(msg).toMatch(/f1: quote not found in src\/a\.ts/);
    expect(msg).toContain(`cli-decisions.mjs evidence check ${p}`);
    expect(existsSync(stored('DEC-0001'))).toBe(false);
  });

  it('add refuses an unreadable or invalid ledger', async () => {
    await expect(run(...ADD, '--evidence', join(tmp, 'none.json'))).rejects.toThrow(/exit/);
    expect(err.join('')).toMatch(/ledger: cannot read/);
    writeFileSync(join(tmp, 'bad.json'), '{not json');
    await expect(run(...ADD, '--evidence', join(tmp, 'bad.json'))).rejects.toThrow(/exit/);
    expect(err.join('')).toMatch(/ledger: not valid JSON/);
  });

  it('add with a passing ledger records the decision and stores the ledger under its id', async () => {
    const p = writeLedger('A = 1');
    await run(...ADD, '--evidence', p);
    expect(out.join('')).toMatch(/decision added: DEC-0001/);
    expect(readFileSync(stored('DEC-0001'), 'utf8')).toBe(readFileSync(p, 'utf8'));
  });

  it('a subagent escalation needs no ledger', async () => {
    await run(...ADD, '--source', 'subagent-escalation');
    expect(out.join('')).toMatch(/decision added: DEC-0001/);
    expect(existsSync(stored('DEC-0001'))).toBe(false);
  });

  it('answer refuses a decision with no stored ledger and no --evidence', async () => {
    await run(...ADD, '--source', 'subagent-escalation');
    await expect(answer()).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/answer DEC-0001: refused, no passing evidence ledger/);
    expect(err.join('')).toMatch(/evidence check .*DEC-0001\.json/);
  });

  it('answer passes on the stored ledger', async () => {
    await run(...ADD, '--evidence', writeLedger('A = 1'));
    await answer();
    expect(out.join('')).toMatch(/decision answered: DEC-0001/);
  });

  it('answer from a Pattern C parent reads the ledger add stored in the active worktree', async () => {
    mkdirSync(join(tmp, '.worktrees', 't-1'), { recursive: true });
    const prev = process.env.AI_SDLC_ACTIVE_TASK_ID;
    process.env.AI_SDLC_ACTIVE_TASK_ID = 'T-1';
    try {
      await run(...ADD, '--evidence', writeLedger('A = 1'));
      const wtLedger = join(tmp, '.worktrees', 't-1', '.ai-sdlc', 'decisions', 'evidence');
      expect(existsSync(join(wtLedger, 'DEC-0001.json'))).toBe(true);
      expect(existsSync(stored('DEC-0001'))).toBe(false);
      await answer();
      expect(out.join('')).toMatch(/decision answered: DEC-0001/);
    } finally {
      if (prev === undefined) delete process.env.AI_SDLC_ACTIVE_TASK_ID;
      else process.env.AI_SDLC_ACTIVE_TASK_ID = prev;
    }
  });

  it('answer refuses when the stored ledger no longer passes', async () => {
    await run(...ADD, '--evidence', writeLedger('A = 1'));
    writeFileSync(join(tmp, 'src', 'a.ts'), 'export const A = 3;\n');
    await expect(answer()).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/f1: quote not found/);
  });

  it('answer --evidence supplies a ledger for an older decision and stores it', async () => {
    await run(...ADD, '--source', 'subagent-escalation');
    const p = writeLedger('A = 1');
    await answer('--evidence', p);
    expect(out.join('')).toMatch(/decision answered: DEC-0001/);
    expect(readFileSync(stored('DEC-0001'), 'utf8')).toBe(readFileSync(p, 'utf8'));
  });

  it('answer --evidence refuses a failing ledger', async () => {
    await run(...ADD, '--source', 'subagent-escalation');
    await expect(answer('--evidence', writeLedger('nope'))).rejects.toThrow(/exit\(1\)/);
    expect(err.join('')).toMatch(/answer DEC-0001: refused/);
  });
});
