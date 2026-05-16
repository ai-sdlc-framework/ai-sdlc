/**
 * Signal-collector tests — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Covers AC #2 (six deterministic signals implemented per §5) and
 * AC #6 (unit tests cover all six signals + class-default fallback).
 *
 * Tests are pure: each collector is a single function with explicit
 * inputs; no temp directories, no environment mutation.
 */

import { describe, expect, it } from 'vitest';
import {
  blockedPathsSignal,
  classDefaultSignal,
  coverageSignal,
  dependencyDepthSignal,
  fileScopeSignal,
  fileTypeSignal,
  historicalActualsSignal,
  locDeltaSignal,
  reviewerIterationSignal,
} from './signals.js';

// ── #1 File scope ────────────────────────────────────────────────────

describe('fileScopeSignal (#1)', () => {
  it('returns unknown when fileCount is 0', () => {
    const out = fileScopeSignal({ fileCount: 0 });
    expect(out.id).toBe(1);
    expect(out.result.kind).toBe('unknown');
  });

  it('emits XS-S for a single-file change', () => {
    const out = fileScopeSignal({ fileCount: 1 });
    expect(out.result).toEqual({ kind: 'range', low: 'XS', high: 'S' });
  });

  it.each([
    [2, 'S', 'M'],
    [3, 'S', 'M'],
    [5, 'S', 'M'],
  ] as const)('emits S-M for %d-file changes', (n, low, high) => {
    expect(fileScopeSignal({ fileCount: n }).result).toEqual({ kind: 'range', low, high });
  });

  it.each([
    [6, 'M', 'L'],
    [10, 'M', 'L'],
    [15, 'M', 'L'],
  ] as const)('emits M-L for %d-file changes', (n, low, high) => {
    expect(fileScopeSignal({ fileCount: n }).result).toEqual({ kind: 'range', low, high });
  });

  it.each([
    [16, 'L', 'XL'],
    [50, 'L', 'XL'],
    [200, 'L', 'XL'],
  ] as const)('emits L-XL for %d-file changes', (n, low, high) => {
    expect(fileScopeSignal({ fileCount: n }).result).toEqual({ kind: 'range', low, high });
  });

  it('captures the input fileCount for the audit trail', () => {
    expect(fileScopeSignal({ fileCount: 7 }).inputs).toEqual({ fileCount: 7 });
  });
});

// ── #2 Historical actuals (Phase 3 stub) ─────────────────────────────

describe('historicalActualsSignal (#2)', () => {
  it('always returns unknown in Phase 1 (calibration data does not exist yet)', () => {
    const out = historicalActualsSignal({ taskClass: 'bug' });
    expect(out.id).toBe(2);
    expect(out.result.kind).toBe('unknown');
    if (out.result.kind === 'unknown') {
      expect(out.result.reason).toMatch(/calibration/i);
    }
  });

  it('records the class it would have looked up', () => {
    expect(historicalActualsSignal({ taskClass: 'feature' }).inputs).toMatchObject({
      taskClass: 'feature',
      n: 0,
    });
  });
});

// ── #3 LOC delta ─────────────────────────────────────────────────────

describe('locDeltaSignal (#3)', () => {
  it('returns unknown when no LOC value provided', () => {
    expect(locDeltaSignal({}).result.kind).toBe('unknown');
  });

  it.each([
    [0, 'XS'],
    [49, 'XS'],
    [50, 'S'],
    [199, 'S'],
    [200, 'M'],
    [499, 'M'],
    [500, 'L'],
    [1499, 'L'],
    [1500, 'XL'],
    [10000, 'XL'],
  ] as const)('maps loc=%d to bucket %s', (loc, expected) => {
    const out = locDeltaSignal({ loc });
    expect(out.result).toEqual({ kind: 'bucket', bucket: expected });
  });

  it('rejects a negative LOC value with unknown', () => {
    expect(locDeltaSignal({ loc: -1 }).result.kind).toBe('unknown');
  });

  it('rejects NaN / Infinity with unknown', () => {
    expect(locDeltaSignal({ loc: Number.NaN }).result.kind).toBe('unknown');
    expect(locDeltaSignal({ loc: Number.POSITIVE_INFINITY }).result.kind).toBe('unknown');
  });
});

// ── #4 Test coverage ─────────────────────────────────────────────────

describe('coverageSignal (#4)', () => {
  it('emits no bump when codecov.yml is absent', () => {
    const out = coverageSignal({ hasCodecovYaml: false });
    expect(out.result).toEqual({ kind: 'bump', delta: 0 });
  });

  it('emits no bump for the AI-SDLC standard 80% threshold', () => {
    expect(coverageSignal({ hasCodecovYaml: true, patchThreshold: 80 }).result).toEqual({
      kind: 'bump',
      delta: 0,
    });
  });

  it.each([85, 89])('emits no bump for sub-90%% thresholds (%d%%)', (thr) => {
    expect(coverageSignal({ hasCodecovYaml: true, patchThreshold: thr }).result).toEqual({
      kind: 'bump',
      delta: 0,
    });
  });

  it.each([90, 95, 100])('emits +1 bump for strict %d%% threshold', (thr) => {
    expect(coverageSignal({ hasCodecovYaml: true, patchThreshold: thr }).result).toEqual({
      kind: 'bump',
      delta: 1,
    });
  });

  it('emits no bump when codecov.yml exists but threshold is unparseable', () => {
    expect(coverageSignal({ hasCodecovYaml: true }).result).toEqual({ kind: 'bump', delta: 0 });
  });
});

// ── #5 Dependency depth ──────────────────────────────────────────────

describe('dependencyDepthSignal (#5)', () => {
  it.each([0, 1])('emits no bump for depth=%d (single dep is normal sequencing)', (d) => {
    expect(dependencyDepthSignal({ depth: d }).result).toEqual({ kind: 'bump', delta: 0 });
  });

  it.each([2, 3, 10])('emits +1 bump for depth=%d (real coordination cost)', (d) => {
    expect(dependencyDepthSignal({ depth: d }).result).toEqual({ kind: 'bump', delta: 1 });
  });

  it('returns unknown for negative depth', () => {
    expect(dependencyDepthSignal({ depth: -1 }).result.kind).toBe('unknown');
  });
});

// ── #6 Blocked paths ─────────────────────────────────────────────────

describe('blockedPathsSignal (#6)', () => {
  it('emits no bump when no references match blocked fragments', () => {
    expect(
      blockedPathsSignal({ references: ['src/foo.ts', 'README.md', 'package.json'] }).result,
    ).toEqual({ kind: 'bump', delta: 0 });
  });

  it('emits +1 bump when any reference touches .github/workflows/', () => {
    expect(
      blockedPathsSignal({
        references: ['src/foo.ts', '.github/workflows/ci.yml'],
      }).result,
    ).toEqual({ kind: 'bump', delta: 1 });
  });

  it('emits +1 bump when any reference touches .ai-sdlc/', () => {
    expect(
      blockedPathsSignal({ references: ['.ai-sdlc/agents/developer/agent-role.yaml'] }).result,
    ).toEqual({ kind: 'bump', delta: 1 });
  });

  it('emits +1 bump when any reference touches .husky/', () => {
    expect(blockedPathsSignal({ references: ['.husky/pre-push'] }).result).toEqual({
      kind: 'bump',
      delta: 1,
    });
  });

  it('emits +1 bump when any reference is a *.schema.json', () => {
    expect(
      blockedPathsSignal({
        references: ['src/foo.ts', '.ai-sdlc/schemas/estimate.v1.schema.json'],
      }).result,
    ).toEqual({ kind: 'bump', delta: 1 });
  });

  it('treats references case-insensitively', () => {
    expect(blockedPathsSignal({ references: ['.GITHUB/Workflows/foo.yml'] }).result).toEqual({
      kind: 'bump',
      delta: 1,
    });
  });

  it('records the matched references for the audit trail', () => {
    const out = blockedPathsSignal({
      references: ['src/foo.ts', '.github/workflows/ci.yml', '.ai-sdlc/agents/foo.yaml'],
    });
    expect(out.inputs).toMatchObject({
      matched: ['.github/workflows/ci.yml', '.ai-sdlc/agents/foo.yaml'],
      totalRefs: 3,
    });
  });
});

// ── #7 File-type breakdown ───────────────────────────────────────────

describe('fileTypeSignal (#7)', () => {
  it('returns unknown when there are no references', () => {
    expect(fileTypeSignal({ references: [] }).result.kind).toBe('unknown');
  });

  it('emits XS-S range for pure markdown changes (any count)', () => {
    expect(fileTypeSignal({ references: ['README.md'] }).result).toEqual({
      kind: 'range',
      low: 'XS',
      high: 'S',
    });
    expect(fileTypeSignal({ references: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'] }).result).toEqual(
      {
        kind: 'range',
        low: 'XS',
        high: 'S',
      },
    );
  });

  it('emits XS-S range for yaml-majority changes with no TS', () => {
    expect(fileTypeSignal({ references: ['a.yaml', 'b.yml', 'c.yaml'] }).result).toEqual({
      kind: 'range',
      low: 'XS',
      high: 'S',
    });
  });

  it('abstains (bump 0) when YAML is present but TS is also present', () => {
    expect(fileTypeSignal({ references: ['a.yaml', 'b.ts'] }).result).toEqual({
      kind: 'bump',
      delta: 0,
    });
  });

  it('abstains (bump 0) for pure TS code (lets signal #1 drive)', () => {
    expect(fileTypeSignal({ references: ['a.ts', 'b.ts', 'c.ts'] }).result).toEqual({
      kind: 'bump',
      delta: 0,
    });
  });

  it('abstains (bump 0) for mixed code + docs', () => {
    expect(fileTypeSignal({ references: ['a.ts', 'b.md'] }).result).toEqual({
      kind: 'bump',
      delta: 0,
    });
  });

  it('handles paths with subdirectories', () => {
    expect(
      fileTypeSignal({ references: ['spec/rfcs/RFC-0016.md', 'docs/operations/x.md'] }).result,
    ).toEqual({ kind: 'range', low: 'XS', high: 'S' });
  });

  it('strips line-anchor suffixes from refs (e.g. `path.ts:42`)', () => {
    expect(fileTypeSignal({ references: ['src/foo.md:42'] }).result).toEqual({
      kind: 'range',
      low: 'XS',
      high: 'S',
    });
  });
});

// ── #8 Reviewer-iteration history (Phase 3 stub) ─────────────────────

describe('reviewerIterationSignal (#8)', () => {
  it('always returns unknown in Phase 1 (events.jsonl history does not exist yet)', () => {
    const out = reviewerIterationSignal({ taskClass: 'feature' });
    expect(out.id).toBe(8);
    expect(out.result.kind).toBe('unknown');
  });

  it('records the class it would have looked up', () => {
    expect(reviewerIterationSignal({ taskClass: 'bug' }).inputs).toMatchObject({
      taskClass: 'bug',
      n: 0,
    });
  });
});

// ── #9 Class-default fallback (Q8 resolution) ────────────────────────

describe('classDefaultSignal (#9 — Q8 resolution)', () => {
  it('seeds bug → S per RFC-0016 §13 Phase 1', () => {
    const out = classDefaultSignal({ taskClass: 'bug' });
    expect(out.id).toBe(9);
    expect(out.result).toEqual({ kind: 'bucket', bucket: 'S' });
    expect(out.inputs).toMatchObject({ taskClass: 'bug', seedBucket: 'S' });
  });

  it('seeds feature → M per RFC-0016 §13 Phase 1', () => {
    const out = classDefaultSignal({ taskClass: 'feature' });
    expect(out.result).toEqual({ kind: 'bucket', bucket: 'M' });
    expect(out.inputs).toMatchObject({ taskClass: 'feature', seedBucket: 'M' });
  });

  it('seeds chore → S per RFC-0016 §13 Phase 1', () => {
    const out = classDefaultSignal({ taskClass: 'chore' });
    expect(out.result).toEqual({ kind: 'bucket', bucket: 'S' });
    expect(out.inputs).toMatchObject({ taskClass: 'chore', seedBucket: 'S' });
  });

  it('produces a non-unknown bucket for uncategorized (defensive — the heuristic never emits this in Phase 1)', () => {
    // The §6.1 LLM path (Phase 2+) may surface `uncategorized`; we
    // pin a Phase-1-stable default to avoid a crash here.
    const out = classDefaultSignal({ taskClass: 'uncategorized' });
    expect(out.result.kind).toBe('bucket');
  });
});
