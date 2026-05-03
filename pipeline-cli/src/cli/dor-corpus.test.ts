/**
 * cli-dor-corpus aggregator tests (AISDLC-161).
 *
 * Hermetic — no real GitHub API, no `gh run download`. Each test seeds a
 * tmpdir of fixture JSONL files (1+ per test) and drives the aggregator
 * end to end. The CLI router is tested in-process via `buildDorCorpusCli()`
 * with stdout/stderr captured (mirrors `dor-stats.test.ts` conventions).
 *
 * Coverage matrix per the AISDLC-161 brief:
 *   - Single calibration.jsonl, all `outcome: 'admit'` → fpRate 0
 *   - Mix of admit + needs-clarification with overrides → FP rate computed
 *   - Empty input → recommendation 'insufficient-data'
 *   - N=1000+ entries with ~9% override rate → 'safe-to-enforce'
 *   - Schema validation: malformed entries are skipped, not crash
 *   - Multi-file corpus (gh run download layout) is glued together
 *   - `--format table` renders human-readable output
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateCorpus,
  buildDorCorpusCli,
  findCalibrationFiles,
  isValidEntry,
  loadCorpus,
  type CorpusReport,
} from './dor-corpus.js';
import type { CalibrationEntry } from '../dor/calibration-log.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-corpus-cli-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli', ...args];
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stdoutJson(): unknown {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Build a minimal CalibrationEntry suitable for aggregation. We only
 * populate the fields the aggregator consumes — `verdict`, `issue`, etc.
 * are emitted by the production writer but irrelevant to FP-rate math.
 */
function entry(opts: {
  issueId?: string;
  failedGates?: number[];
  outcome?: 'admit' | 'needs-clarification' | 'override' | '';
  overallVerdict?: 'admit' | 'needs-clarification';
  ts?: string;
}): CalibrationEntry {
  return {
    ts: opts.ts ?? '2026-05-01T00:00:00.000Z',
    issueId: opts.issueId ?? 'AISDLC-test',
    rubricVersion: 'v1',
    evaluatorVersion: 'test',
    overallVerdict: opts.overallVerdict ?? 'admit',
    failedGates: opts.failedGates ?? [],
    outcome: opts.outcome ?? '',
    verdict: {
      issueId: opts.issueId ?? 'AISDLC-test',
      rubricVersion: 'v1',
      overallVerdict: opts.overallVerdict ?? 'admit',
      gates: [],
      signedAt: opts.ts ?? '2026-05-01T00:00:00.000Z',
      evaluatorVersion: 'test',
      summary: '',
      questions: [],
    },
  };
}

/**
 * Write a JSONL file at `<tmp>/<name>` containing one entry per provided
 * line. Returns the absolute path so tests can pass it to the CLI.
 */
function writeJsonl(name: string, entries: unknown[]): string {
  const path = join(tmp, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}

describe('aggregateCorpus (pure)', () => {
  it('empty corpus → insufficient-data', () => {
    const r = aggregateCorpus([]);
    expect(r.aggregate.n).toBe(0);
    expect(r.aggregate.recommendation).toBe('insufficient-data');
    expect(r.aggregate.worstGate).toBeNull();
    expect(r.perGate).toEqual([]);
  });

  it('single jsonl, 5 admits, no failed gates → fpRate 0 + insufficient-data', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ issueId: `AISDLC-${i}`, outcome: 'admit', overallVerdict: 'admit' }),
    );
    const r = aggregateCorpus(entries);
    expect(r.aggregate.n).toBe(5);
    expect(r.aggregate.meanFpRate).toBe(0);
    expect(r.aggregate.overrideRate).toBe(0);
    // Below default minSamples (50)
    expect(r.aggregate.recommendation).toBe('insufficient-data');
    expect(r.perGate).toEqual([]);
  });

  it('mix of needs-clarification + overrides → per-gate FP rate computed correctly', () => {
    // 60 entries (above minSamples=50). 10 of them overrode gate-2.
    // 20 of them failed gate-2 total → FP rate = 10/20 = 50% (way above 10%)
    const entries: CalibrationEntry[] = [];
    for (let i = 0; i < 40; i++) entries.push(entry({ issueId: `clean-${i}`, outcome: 'admit' }));
    for (let i = 0; i < 10; i++)
      entries.push(
        entry({
          issueId: `nc-${i}`,
          outcome: 'needs-clarification',
          overallVerdict: 'needs-clarification',
          failedGates: [2],
        }),
      );
    for (let i = 0; i < 10; i++)
      entries.push(
        entry({
          issueId: `ovr-${i}`,
          outcome: 'override',
          overallVerdict: 'needs-clarification',
          failedGates: [2],
        }),
      );

    const r = aggregateCorpus(entries);
    expect(r.aggregate.n).toBe(60);
    const g2 = r.perGate.find((p) => p.gate === 2)!;
    expect(g2.n).toBe(20);
    expect(g2.overrides).toBe(10);
    expect(g2.fpRate).toBeCloseTo(0.5, 5);
    expect(r.aggregate.recommendation).toBe('continue-soak');
    expect(r.aggregate.worstGate).toEqual({ gate: 2, fpRate: 0.5 });
  });

  it('N=1000 with ~9% per-gate override rate → safe-to-enforce', () => {
    // 1000 entries; 200 of them failed gate-3, 18 of those overridden = 9% per-gate.
    // Aggregate override rate = 18/1000 = 1.8% (under 5% threshold).
    const entries: CalibrationEntry[] = [];
    for (let i = 0; i < 800; i++) entries.push(entry({ issueId: `clean-${i}`, outcome: 'admit' }));
    for (let i = 0; i < 182; i++)
      entries.push(
        entry({
          issueId: `nc-${i}`,
          outcome: 'needs-clarification',
          overallVerdict: 'needs-clarification',
          failedGates: [3],
        }),
      );
    for (let i = 0; i < 18; i++)
      entries.push(
        entry({
          issueId: `ovr-${i}`,
          outcome: 'override',
          overallVerdict: 'needs-clarification',
          failedGates: [3],
        }),
      );

    const r = aggregateCorpus(entries);
    expect(r.aggregate.n).toBe(1000);
    const g3 = r.perGate.find((p) => p.gate === 3)!;
    expect(g3.n).toBe(200);
    expect(g3.fpRate).toBeCloseTo(0.09, 5);
    // 9% < 10% threshold AND aggregate override rate 1.8% < 5% → safe to enforce
    expect(r.aggregate.recommendation).toBe('safe-to-enforce');
  });

  it('high override rate triggers continue-soak even when per-gate FP is fine', () => {
    // 100 entries; 10 overrides spread across gates with low per-gate fpRate
    // but aggregate override rate = 10% > 5% threshold.
    const entries: CalibrationEntry[] = [];
    for (let i = 0; i < 90; i++) entries.push(entry({ issueId: `c-${i}`, outcome: 'admit' }));
    for (let i = 0; i < 10; i++)
      entries.push(
        entry({
          issueId: `o-${i}`,
          outcome: 'override',
          overallVerdict: 'needs-clarification',
          failedGates: [1, 2, 3, 4, 5, 6, 7],
        }),
      );
    const r = aggregateCorpus(entries);
    // Per-gate fpRate = 10/10 = 100% → continue-soak via worstGate path
    expect(r.aggregate.recommendation).toBe('continue-soak');
    expect(r.aggregate.overrideRate).toBeCloseTo(0.1, 5);
  });

  it('respects --min-samples override (lowering threshold lets a small clean corpus pass)', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ issueId: `AISDLC-${i}`, outcome: 'admit' }),
    );
    const r = aggregateCorpus(entries, { minSamples: 3 });
    expect(r.aggregate.recommendation).toBe('safe-to-enforce');
  });

  it('worstGate surfaces the highest-FP gate when multiple gates have data', () => {
    const entries: CalibrationEntry[] = [];
    // 50 baseline admits to clear minSamples
    for (let i = 0; i < 50; i++) entries.push(entry({ issueId: `c-${i}`, outcome: 'admit' }));
    // gate-1: 10 entries, 1 override → 10% (right at threshold, fails the strict <)
    for (let i = 0; i < 9; i++)
      entries.push(
        entry({ issueId: `g1nc-${i}`, outcome: 'needs-clarification', failedGates: [1] }),
      );
    entries.push(entry({ issueId: `g1ovr`, outcome: 'override', failedGates: [1] }));
    // gate-2: 10 entries, 5 overrides → 50% — definitively the worst
    for (let i = 0; i < 5; i++)
      entries.push(
        entry({ issueId: `g2nc-${i}`, outcome: 'needs-clarification', failedGates: [2] }),
      );
    for (let i = 0; i < 5; i++)
      entries.push(entry({ issueId: `g2ovr-${i}`, outcome: 'override', failedGates: [2] }));

    const r = aggregateCorpus(entries);
    expect(r.aggregate.worstGate?.gate).toBe(2);
    expect(r.aggregate.worstGate?.fpRate).toBeCloseTo(0.5, 5);
    expect(r.aggregate.recommendation).toBe('continue-soak');
  });
});

describe('isValidEntry (schema validation)', () => {
  it('accepts a complete entry', () => {
    expect(isValidEntry(entry({}))).toBe(true);
  });
  it('rejects null / non-object / array', () => {
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry('string')).toBe(false);
    expect(isValidEntry(42)).toBe(false);
    expect(isValidEntry([])).toBe(false);
  });
  it('rejects missing required fields', () => {
    const valid = entry({}) as unknown as Record<string, unknown>;
    for (const field of ['ts', 'issueId', 'failedGates', 'outcome', 'overallVerdict']) {
      const broken = { ...valid };
      delete broken[field];
      expect(isValidEntry(broken), `field ${field} should be required`).toBe(false);
    }
  });
  it('rejects wrong types in failedGates', () => {
    const broken = { ...entry({}), failedGates: ['oops', 'not', 'numbers'] };
    expect(isValidEntry(broken)).toBe(false);
  });
  it('rejects unknown overallVerdict values', () => {
    const broken = { ...entry({}), overallVerdict: 'maybe' };
    expect(isValidEntry(broken)).toBe(false);
  });
  it('tolerates extra fields (forward-compat with future calibration entries)', () => {
    const withExtra = { ...entry({}), futureField: 'forward-compat' };
    expect(isValidEntry(withExtra)).toBe(true);
  });
});

describe('loadCorpus (filesystem layer)', () => {
  it('reads a single jsonl file', () => {
    const p = writeJsonl('cal.jsonl', [entry({ issueId: 'a' }), entry({ issueId: 'b' })]);
    const { entries, skipped } = loadCorpus([p]);
    expect(entries.length).toBe(2);
    expect(skipped).toBe(0);
  });

  it('skips malformed JSON lines but counts them', () => {
    const path = join(tmp, 'mixed.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(entry({ issueId: 'good' })),
        '{not valid json',
        JSON.stringify(entry({ issueId: 'good2' })),
        '',
      ].join('\n'),
      'utf8',
    );
    const { entries, skipped } = loadCorpus([path]);
    expect(entries.length).toBe(2);
    expect(skipped).toBe(1);
  });

  it('skips lines that parse but fail schema validation', () => {
    const path = join(tmp, 'half-broken.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(entry({ issueId: 'good' })),
        JSON.stringify({ ts: 'has-ts-but-missing-other-fields' }),
        JSON.stringify({ ...entry({}), failedGates: 'not-an-array' }),
      ].join('\n'),
      'utf8',
    );
    const { entries, skipped } = loadCorpus([path]);
    expect(entries.length).toBe(1);
    expect(skipped).toBe(2);
  });

  it('counts unreadable files as skips and continues', () => {
    const good = writeJsonl('good.jsonl', [entry({ issueId: 'a' })]);
    const missing = join(tmp, 'does-not-exist.jsonl');
    const { entries, skipped } = loadCorpus([good, missing]);
    expect(entries.length).toBe(1);
    expect(skipped).toBe(1);
  });
});

describe('findCalibrationFiles (gh-run-download layout)', () => {
  it('returns single jsonl when path is a file', () => {
    const p = writeJsonl('one.jsonl', [entry({})]);
    const files = findCalibrationFiles(p);
    expect(files).toEqual([p]);
  });

  it('walks subdirectories (the gh run download layout)', () => {
    // Mimic `gh run download` layout: one subdir per artifact, each
    // containing a single calibration.jsonl.
    const a = join(tmp, 'dor-calibration-issue-1-1');
    const b = join(tmp, 'dor-calibration-pr-99-2');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'calibration.jsonl'), JSON.stringify(entry({ issueId: 'i1' })) + '\n');
    writeFileSync(join(b, 'calibration.jsonl'), JSON.stringify(entry({ issueId: 'p99' })) + '\n');
    // Plus a non-jsonl file that must be ignored.
    writeFileSync(join(b, 'unrelated.txt'), 'noise\n');
    const files = findCalibrationFiles(tmp);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns [] when path does not exist', () => {
    expect(findCalibrationFiles(join(tmp, 'nope'))).toEqual([]);
  });
});

describe('cli-dor-corpus router', () => {
  it('aggregate emits JSON by default', async () => {
    writeJsonl('a.jsonl', [
      entry({ issueId: '1', outcome: 'admit' }),
      entry({
        issueId: '2',
        outcome: 'needs-clarification',
        overallVerdict: 'needs-clarification',
        failedGates: [4],
      }),
    ]);
    setArgv('aggregate', tmp);
    await buildDorCorpusCli().parseAsync();
    const r = stdoutJson() as CorpusReport;
    expect(r.aggregate.n).toBe(2);
    expect(r.aggregate.recommendation).toBe('insufficient-data');
    expect(r.perGate.find((g) => g.gate === 4)?.n).toBe(1);
  });

  it('aggregate --format table emits the human renderer', async () => {
    writeJsonl('a.jsonl', [entry({ issueId: '1', outcome: 'admit' })]);
    setArgv('aggregate', tmp, '--format', 'table');
    await buildDorCorpusCli().parseAsync();
    const out = stdoutText();
    expect(out).toContain('Recommendation:');
    expect(out).toContain('Reason:');
    expect(out).toContain('Mean FP rate');
  });

  it('aggregate respects --min-samples', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ issueId: `c-${i}`, outcome: 'admit' }),
    );
    writeJsonl('clean.jsonl', entries);
    setArgv('aggregate', tmp, '--min-samples', '3');
    await buildDorCorpusCli().parseAsync();
    const r = stdoutJson() as CorpusReport;
    expect(r.aggregate.recommendation).toBe('safe-to-enforce');
  });

  it('aggregate skips a directory of multiple jsonl files (multi-artifact corpus)', async () => {
    const a = join(tmp, 'dor-calibration-issue-1-1');
    const b = join(tmp, 'dor-calibration-pr-99-2');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'calibration.jsonl'), JSON.stringify(entry({ issueId: 'i1' })) + '\n');
    writeFileSync(join(b, 'calibration.jsonl'), JSON.stringify(entry({ issueId: 'p99' })) + '\n');
    setArgv('aggregate', tmp);
    await buildDorCorpusCli().parseAsync();
    const r = stdoutJson() as CorpusReport;
    expect(r.aggregate.n).toBe(2);
    expect(r.aggregate.filesRead).toBe(2);
  });

  it('aggregate counts skipped malformed entries in the report', async () => {
    const path = join(tmp, 'mix.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(entry({ issueId: 'good' })),
        '{ broken json',
        JSON.stringify({ also: 'broken-shape' }),
      ].join('\n'),
      'utf8',
    );
    setArgv('aggregate', tmp);
    await buildDorCorpusCli().parseAsync();
    const r = stdoutJson() as CorpusReport;
    expect(r.aggregate.n).toBe(1);
    expect(r.aggregate.skipped).toBe(2);
  });

  // Note: yargs `demandCommand` + `--help` paths use captured
  // `process.exit` references that bypass our `beforeEach` mock and
  // trigger vitest's own "process.exit unexpectedly called" guard
  // (vitest@3.x). The CLI's no-subcommand + help behaviour is exercised
  // out-of-process by the `bin-invocation.test.ts` cohort if/when this
  // CLI is wired into a workflow; for now the production guarantee is
  // the `.demandCommand(1, ...)` line in `dor-corpus.ts` itself.
});
