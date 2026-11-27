/**
 * `cli-decisions evidence check|hash` (AISDLC-1451): drive the yargs program
 * in-process, as decisions.test.ts does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
