import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendReviewLedgerRecord,
  type ReviewLedgerRecord,
} from '../attestation/reviews-ledger.js';
import { buildReviewsCli, loadCorpus, runReviewsCli } from './reviews.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

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
  removeFixtureDir(tmpRoot);
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
      removeFixtureDir(repoA);
      removeFixtureDir(repoB);
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
      removeFixtureDir(repoA);
      removeFixtureDir(repoB);
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

describe('compare', () => {
  const finding = (severity: 'major' | 'minor', title: string) => ({
    severity,
    summary: title,
    title,
  });

  function seed(): void {
    const sha = (c: string) => c.repeat(40);
    // PR-1: only the staged set found a major finding; security agrees on a minor.
    appendReviewLedgerRecord(
      rec({ taskId: 'AISDLC-1', commitSha: sha('a'), role: 'code' }),
      tmpRoot,
    );
    appendReviewLedgerRecord(
      rec({
        taskId: 'AISDLC-1',
        commitSha: sha('a'),
        role: 'security',
        findings: [finding('minor', 'shared nit')],
      }),
      tmpRoot,
    );
    appendReviewLedgerRecord(
      rec({
        taskId: 'AISDLC-1',
        commitSha: sha('a'),
        role: 'staged',
        gating: false,
        verdict: 'rejected',
        findings: [finding('major', 'null deref'), finding('minor', 'shared nit')],
      }),
      tmpRoot,
    );
    // PR-2: both sides agree and approve.
    appendReviewLedgerRecord(
      rec({ taskId: 'AISDLC-2', commitSha: sha('b'), role: 'code' }),
      tmpRoot,
    );
    appendReviewLedgerRecord(
      rec({ taskId: 'AISDLC-2', commitSha: sha('b'), role: 'staged', gating: false }),
      tmpRoot,
    );
    // PR-3: no staged row, not compared.
    appendReviewLedgerRecord(rec({ taskId: 'AISDLC-3', commitSha: sha('c') }), tmpRoot);
  }

  it('lists staged-only, standalone-only and agreed findings, flagged first, and emits the event', async () => {
    seed();
    appendReviewLedgerRecord(
      rec({
        taskId: 'AISDLC-0',
        commitSha: 'd'.repeat(40),
        role: 'test',
        verdict: 'rejected',
        findings: [finding('major', 'missing test')],
      }),
      tmpRoot,
    );
    appendReviewLedgerRecord(
      rec({ taskId: 'AISDLC-0', commitSha: 'd'.repeat(40), role: 'staged', gating: false }),
      tmpRoot,
    );
    const events: Array<Record<string, unknown>> = [];
    await buildReviewsCli(['compare', '--repo-root', tmpRoot], {
      emit: (e) => void events.push(e),
    }).parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toContain('Compared cases: 3 (2 flagged for re-evaluation)');
    // Flagged first (AISDLC-0 then AISDLC-1), the agreeing PR last.
    expect(out.indexOf('FLAGGED AISDLC-0')).toBeLessThan(out.indexOf('FLAGGED AISDLC-1'));
    expect(out.indexOf('FLAGGED AISDLC-1')).toBeLessThan(out.indexOf('AISDLC-2 @'));
    expect(out).toContain('staged-only    [major] null deref');
    expect(out).toContain('standalone-only [major] missing test (test)');
    expect(out).toContain('agreed         [staged minor / standalone minor] shared nit');
    expect(out).toContain('security (staged vs security-reviewer):');
    expect(events.map((e) => [e.type, e.taskId])).toEqual([
      ['ReviewComparisonFlagged', 'AISDLC-0'],
      ['ReviewComparisonFlagged', 'AISDLC-1'],
    ]);
  });

  it('skips events with --no-events and prints json', async () => {
    seed();
    const events: unknown[] = [];
    await buildReviewsCli(['compare', '--repo-root', tmpRoot, '--no-events', '--json'], {
      emit: (e) => void events.push(e),
    }).parseAsync();
    expect(events).toEqual([]);
    expect(JSON.parse(stdoutChunks.join('')).flaggedCases).toBe(1);
  });

  it('--bar reports compared PRs and act-band precision against 50 and 0.95', async () => {
    seed();
    await buildReviewsCli(['compare', '--repo-root', tmpRoot, '--bar', '--no-events']).parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toContain(
      'overall   compared PRs 2, act-band precision 0.000 (0/1 staged blocks confirmed): not met',
    );
    expect(out).toContain(
      'security  compared PRs 1, act-band precision 0.000 (0/1 staged blocks confirmed): not met',
    );
    expect(out).toContain('need 50 PRs and 0.95');
  });

  it('meets the bar at 50 PRs with confirmed blocks and reports n/a with no blocks', async () => {
    const { compareStagedToGating } = await import('../attestation/reviews-compare.js');
    const rows: ReviewLedgerRecord[] = [];
    for (let i = 0; i < 50; i++) {
      const base = {
        taskId: `T-${i}`,
        commitSha: String(i % 10).repeat(40),
        verdict: 'rejected' as const,
      };
      rows.push(
        rec({ ...base, role: 'security' }),
        rec({ ...base, role: 'staged', gating: false }),
      );
    }
    const report = compareStagedToGating(rows);
    expect(report.bar.overall).toMatchObject({ comparedPrs: 50, actBandPrecision: 1, met: true });
    expect(report.bar.security.met).toBe(true);
    const none = compareStagedToGating([
      rec({ taskId: 'X', role: 'code' }),
      rec({ taskId: 'X', role: 'staged', gating: false }),
    ]);
    expect(none.bar.overall.actBandPrecision).toBeNull();
    expect(none.bar.overall.met).toBe(false);
  });
});
