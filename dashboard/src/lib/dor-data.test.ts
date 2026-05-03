/**
 * Tests for the DoR calibration loader (AISDLC-162).
 *
 * Hermetic — every test seeds a tmpdir of fixture JSONL files and
 * drives `loadDorData()` end to end (the same pattern used by the
 * `cli-dor-corpus` aggregator's own tests in
 * `pipeline-cli/src/cli/dor-corpus.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CalibrationEntry } from '@ai-sdlc/pipeline-cli/dor-corpus';
import { loadDorData, resolveCorpusRoot } from './dor-data';

let tmp: string;
let savedEnv: string | undefined;
let savedCwd: typeof process.cwd;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-dashboard-'));
  savedEnv = process.env.DOR_CORPUS_DIR;
  savedCwd = process.cwd;
  delete process.env.DOR_CORPUS_DIR;
});

afterEach(() => {
  process.cwd = savedCwd;
  if (savedEnv === undefined) delete process.env.DOR_CORPUS_DIR;
  else process.env.DOR_CORPUS_DIR = savedEnv;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function entry(opts: {
  ts?: string;
  issueId?: string;
  failedGates?: number[];
  outcome?: 'admit' | 'needs-clarification' | 'override' | '';
  overallVerdict?: 'admit' | 'needs-clarification';
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

function writeJsonl(name: string, entries: unknown[]): string {
  const path = join(tmp, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}

describe('resolveCorpusRoot', () => {
  it('honors explicit corpusRoot first', () => {
    process.env.DOR_CORPUS_DIR = '/env/path';
    expect(resolveCorpusRoot({ corpusRoot: '/explicit' })).toBe('/explicit');
  });

  it('falls back to DOR_CORPUS_DIR env var', () => {
    process.env.DOR_CORPUS_DIR = '/env/path';
    expect(resolveCorpusRoot()).toBe('/env/path');
  });

  it('treats empty DOR_CORPUS_DIR as unset', () => {
    process.env.DOR_CORPUS_DIR = '';
    const root = resolveCorpusRoot();
    expect(root.endsWith(join('artifacts', '_dor'))).toBe(true);
  });

  it('defaults to <cwd>/artifacts/_dor', () => {
    const root = resolveCorpusRoot();
    expect(root).toBe(join(process.cwd(), 'artifacts', '_dor'));
  });
});

describe('loadDorData', () => {
  it('returns null when the corpus root does not exist', () => {
    const result = loadDorData({ corpusRoot: join(tmp, 'does-not-exist') });
    expect(result).toBeNull();
  });

  it('returns insufficient-data report when directory is empty', () => {
    const result = loadDorData({ corpusRoot: tmp });
    expect(result).not.toBeNull();
    expect(result!.report.aggregate.recommendation).toBe('insufficient-data');
    expect(result!.report.aggregate.n).toBe(0);
    expect(result!.report.aggregate.filesRead).toBe(0);
    expect(result!.recentEntries).toEqual([]);
  });

  it('aggregates a single jsonl file', () => {
    writeJsonl('calibration.jsonl', [
      entry({ issueId: 'A', outcome: 'admit' }),
      entry({ issueId: 'B', outcome: 'admit' }),
    ]);
    const result = loadDorData({ corpusRoot: tmp, minSamples: 1 });
    expect(result).not.toBeNull();
    expect(result!.report.aggregate.n).toBe(2);
    expect(result!.report.aggregate.recommendation).toBe('safe-to-enforce');
    expect(result!.report.aggregate.filesRead).toBe(1);
  });

  it('flags continue-soak when a gate exceeds fpThreshold', () => {
    const entries: CalibrationEntry[] = [];
    for (let i = 0; i < 10; i++)
      entries.push(
        entry({
          issueId: `nc-${i}`,
          outcome: 'needs-clarification',
          overallVerdict: 'needs-clarification',
          failedGates: [3],
        }),
      );
    for (let i = 0; i < 10; i++)
      entries.push(
        entry({
          issueId: `ovr-${i}`,
          outcome: 'override',
          overallVerdict: 'needs-clarification',
          failedGates: [3],
        }),
      );
    writeJsonl('calibration.jsonl', entries);
    const result = loadDorData({ corpusRoot: tmp, minSamples: 5 });
    expect(result).not.toBeNull();
    expect(result!.report.aggregate.recommendation).toBe('continue-soak');
    expect(result!.report.aggregate.worstGate).toEqual({ gate: 3, fpRate: 0.5 });
  });

  it('returns the freshest entries first via recentEntries', () => {
    writeJsonl('calibration.jsonl', [
      entry({ ts: '2026-04-01T00:00:00.000Z', issueId: 'old' }),
      entry({ ts: '2026-05-01T00:00:00.000Z', issueId: 'new' }),
      entry({ ts: '2026-04-15T00:00:00.000Z', issueId: 'mid' }),
    ]);
    const result = loadDorData({ corpusRoot: tmp, minSamples: 1, recentLimit: 10 });
    expect(result).not.toBeNull();
    expect(result!.recentEntries.map((e) => e.issueId)).toEqual(['new', 'mid', 'old']);
  });

  it('caps recentEntries at recentLimit', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({
        ts: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        issueId: `e-${i}`,
      }),
    );
    writeJsonl('calibration.jsonl', entries);
    const result = loadDorData({ corpusRoot: tmp, minSamples: 1, recentLimit: 3 });
    expect(result!.recentEntries).toHaveLength(3);
    // Freshest are e-9, e-8, e-7
    expect(result!.recentEntries.map((e) => e.issueId)).toEqual(['e-9', 'e-8', 'e-7']);
  });

  it('glues together a multi-file gh-run-download layout', () => {
    // Simulate the `gh run download --pattern dor-calibration-*` shape:
    // one directory per workflow artifact, each containing a single
    // calibration.jsonl.
    mkdirSync(join(tmp, 'dor-calibration-issue-1-A'));
    mkdirSync(join(tmp, 'dor-calibration-issue-2-A'));
    writeFileSync(
      join(tmp, 'dor-calibration-issue-1-A', 'calibration.jsonl'),
      JSON.stringify(entry({ issueId: 'one', outcome: 'admit' })) + '\n',
      'utf8',
    );
    writeFileSync(
      join(tmp, 'dor-calibration-issue-2-A', 'calibration.jsonl'),
      JSON.stringify(entry({ issueId: 'two', outcome: 'admit' })) + '\n',
      'utf8',
    );
    const result = loadDorData({ corpusRoot: tmp, minSamples: 1 });
    expect(result).not.toBeNull();
    expect(result!.report.aggregate.n).toBe(2);
    expect(result!.report.aggregate.filesRead).toBe(2);
  });

  it('counts skipped entries when JSONL contains malformed lines', () => {
    const path = join(tmp, 'calibration.jsonl');
    writeFileSync(
      path,
      [JSON.stringify(entry({ issueId: 'good' })), 'not valid json', '{}'].join('\n') + '\n',
      'utf8',
    );
    const result = loadDorData({ corpusRoot: tmp, minSamples: 1 });
    expect(result).not.toBeNull();
    expect(result!.report.aggregate.n).toBe(1);
    expect(result!.report.aggregate.skipped).toBe(2);
  });
});
