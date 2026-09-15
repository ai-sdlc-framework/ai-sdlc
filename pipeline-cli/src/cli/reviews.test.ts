import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendReviewLedgerRecord,
  type ReviewLedgerRecord,
} from '../attestation/reviews-ledger.js';
import { buildReviewsCli, loadCorpus, runReviewsCli } from './reviews.js';

let tmpRoot: string;
let stdoutChunks: string[];
let savedWrite: typeof process.stdout.write;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cli-reviews-test-'));
  stdoutChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = savedWrite;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function rec(overrides: Partial<ReviewLedgerRecord>): ReviewLedgerRecord {
  return {
    taskId: 'AISDLC-1',
    prNumber: null,
    commitSha: 'a'.repeat(40),
    iteration: 1,
    role: 'code',
    harness: 'claude-code',
    timestamp: '2026-09-14T00:00:00.000Z',
    verdict: 'approved',
    findings: [],
    ...overrides,
  };
}

describe('loadCorpus', () => {
  it('defaults to process.cwd() when no --repo-root is given', () => {
    const records = loadCorpus([]);
    expect(Array.isArray(records)).toBe(true);
  });

  it('aggregates records across multiple repo roots', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'cli-reviews-repoA-'));
    const repoB = mkdtempSync(join(tmpdir(), 'cli-reviews-repoB-'));
    try {
      appendReviewLedgerRecord(rec({ taskId: 'AISDLC-1' }), repoA);
      appendReviewLedgerRecord(rec({ taskId: 'AISDLC-2' }), repoB);
      const records = loadCorpus([repoA, repoB]);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.taskId).sort()).toEqual(['AISDLC-1', 'AISDLC-2']);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

describe('cli-reviews analyze', () => {
  it('prints a human-readable report by default', async () => {
    appendReviewLedgerRecord(
      rec({
        role: 'code',
        verdict: 'rejected',
        findings: [{ severity: 'critical', summary: 'x', title: 'x' }],
      }),
      tmpRoot,
    );
    appendReviewLedgerRecord(rec({ role: 'test' }), tmpRoot);
    appendReviewLedgerRecord(rec({ role: 'security' }), tmpRoot);

    await buildReviewsCli(['analyze', '--repo-root', tmpRoot]).parseAsync();

    const out = stdoutChunks.join('');
    expect(out).toContain('Review cycles analyzed: 1');
    expect(out).toContain('code');
  });

  it('prints JSON when --json is passed', async () => {
    appendReviewLedgerRecord(rec({ role: 'code' }), tmpRoot);

    await buildReviewsCli(['analyze', '--repo-root', tmpRoot, '--json']).parseAsync();

    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out) as { totalCycles: number };
    expect(parsed.totalCycles).toBe(1);
  });

  it('supports multiple --repo-root flags to aggregate a corpus', async () => {
    const repoA = mkdtempSync(join(tmpdir(), 'cli-reviews-repoA2-'));
    const repoB = mkdtempSync(join(tmpdir(), 'cli-reviews-repoB2-'));
    try {
      appendReviewLedgerRecord(rec({ taskId: 'AISDLC-1', commitSha: 'a'.repeat(40) }), repoA);
      appendReviewLedgerRecord(rec({ taskId: 'AISDLC-2', commitSha: 'b'.repeat(40) }), repoB);

      await buildReviewsCli([
        'analyze',
        '--repo-root',
        repoA,
        '--repo-root',
        repoB,
        '--json',
      ]).parseAsync();

      const out = stdoutChunks.join('');
      const parsed = JSON.parse(out) as { totalCycles: number };
      expect(parsed.totalCycles).toBe(2);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it('handles an empty ledger gracefully (0 cycles, no throw)', async () => {
    await expect(
      buildReviewsCli(['analyze', '--repo-root', tmpRoot, '--json']).parseAsync(),
    ).resolves.not.toThrow();
    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out) as { totalCycles: number };
    expect(parsed.totalCycles).toBe(0);
  });
});

// AISDLC-619 — the `runReviewsCli()` bin-shim entry point was previously
// untested; only `buildReviewsCli()` (the yargs-builder it delegates to) had
// coverage. This exercises the real `process.argv` -> `hideBin` -> parseAsync
// wiring the actual `pipeline-cli/bin/cli-reviews.mjs` shim invokes.
describe('runReviewsCli — bin-shim entry point', () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv;
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it('parses process.argv via hideBin and prints a JSON report', async () => {
    appendReviewLedgerRecord(rec({ role: 'code' }), tmpRoot);

    process.argv = [
      '/usr/bin/node',
      '/path/to/cli-reviews.mjs',
      'analyze',
      '--repo-root',
      tmpRoot,
      '--json',
    ];

    await runReviewsCli();

    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out) as { totalCycles: number };
    expect(parsed.totalCycles).toBe(1);
  });
});
