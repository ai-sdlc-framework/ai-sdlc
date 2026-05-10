/**
 * Filter — Blast-radius overlap detection (AISDLC-231) unit tests.
 *
 * All tests are hermetic: no real `gh`, no real filesystem access (except
 * for tests that explicitly create tmp dirs for task files). Stubs are
 * injected via `computeBlastRadiusFiles` and `listOpenPRs`.
 *
 * Covers the 5 hermetic paths required by AC #7:
 *   (a) No overlap → admitted (positive path)
 *   (b) Overlap with one in-flight task → blocked (single-overlap path)
 *   (c) Overlap with N in-flight tasks → blocked, citing FIRST hit
 *   (d) Candidate has empty blast-radius → admitted (degrade-open)
 *   (e) Bypass env vars → admitted regardless of overlap
 *
 * Also covers:
 *   - In-flight task with empty blast-radius → skip, no block
 *   - Intersection truncation at 3 entries + overlapCount
 *   - Directory-prefix overlap semantics (trailing /)
 *   - `listOpenPRs` throwing → sentinel-only fallback
 *   - filter name is always 'BlastRadiusOverlap'
 *   - `defaultComputeBlastRadiusFiles` parsing (fixture task files)
 *   - `intersectFileSets` direct tests
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBlastRadiusOverlap,
  defaultComputeBlastRadiusFiles,
  intersectFileSets,
} from './blast-radius-overlap.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

/** Stub computeBlastRadiusFiles that returns a fixed set per task ID. */
function makeStubCompute(
  map: Record<string, string[]>,
): (taskId: string, _backlogDir: string) => string[] {
  return (taskId) => map[taskId.toUpperCase()] ?? map[taskId] ?? [];
}

/** Stub listOpenPRs that always returns an empty array. */
function noOpenPRs(): { number: number; headRefName: string }[] {
  return [];
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'blast-radius-overlap-test-'));
  delete process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS;
  delete process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK;
});

afterEach(() => {
  delete process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS;
  delete process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK;
});

// ─── (a) No overlap → admitted ────────────────────────────────────────────────

describe('checkBlastRadiusOverlap — (a) no overlap → admitted', () => {
  it('passes when candidate and in-flight task have disjoint file sets (sentinel signal)', () => {
    // Create a sentinel so there's one in-flight task.
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['pipeline-cli/src/orchestrator/filters/blast-radius-overlap.ts'],
        'AISDLC-100': ['pipeline-cli/src/dor/blast-radius.ts'],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('BlastRadiusOverlap');
    expect(result.detail).toBeUndefined();
  });

  it('passes when no in-flight tasks exist', () => {
    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['pipeline-cli/src/orchestrator/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('BlastRadiusOverlap');
  });
});

// ─── (b) Overlap with one in-flight task → blocked ───────────────────────────

describe('checkBlastRadiusOverlap — (b) single-overlap → blocked', () => {
  it('fails when candidate and in-flight share one file (via sentinel)', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts', 'pipeline-cli/src/orchestrator/loop.ts'],
        'AISDLC-100': ['shared/types.ts', 'pipeline-cli/src/dor/blast-radius.ts'],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('BlastRadiusOverlap');
    expect(result.reason).toContain('AISDLC-100');
    expect(result.reason).toContain('shared/types.ts');
    expect(result.detail).toMatchObject({
      kind: 'blast-radius-overlap',
      inFlightTaskId: 'AISDLC-100',
      overlap: ['shared/types.ts'],
      overlapCount: 1,
    });
  });

  it('fails when in-flight detected via listOpenPRs (open PR signal)', () => {
    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: () => [{ number: 400, headRefName: 'ai-sdlc/aisdlc-100-shared-types' }],
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({
      kind: 'blast-radius-overlap',
      inFlightTaskId: 'AISDLC-100',
    });
  });
});

// ─── (c) Overlap with N in-flight tasks → blocked, citing FIRST ──────────────

describe('checkBlastRadiusOverlap — (c) multi-overlap → blocked, first hit cited', () => {
  it('fails on first overlap when N in-flight tasks all share the same file', () => {
    // Three in-flight tasks all touching shared/types.ts.
    // Sentinel for AISDLC-100, AISDLC-200, AISDLC-300.
    for (const id of ['aisdlc-100', 'aisdlc-200', 'aisdlc-300']) {
      const dir = join(tmp, '.worktrees', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.active-task'), id.toUpperCase());
    }

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
        'AISDLC-200': ['shared/types.ts'],
        'AISDLC-300': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(false);
    // Must cite exactly one in-flight task (the first hit).
    const detail = result.detail as import('./blast-radius-overlap.js').BlastRadiusOverlapDetail;
    expect(detail.kind).toBe('blast-radius-overlap');
    expect(['AISDLC-100', 'AISDLC-200', 'AISDLC-300']).toContain(detail.inFlightTaskId);
    expect(detail.overlap).toContain('shared/types.ts');
    expect(detail.overlapCount).toBeGreaterThanOrEqual(1);
  });

  it('truncates overlap list to 3 entries; overlapCount reflects full count', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const sharedFiles = [
      'shared/types.ts',
      'shared/registry.ts',
      'shared/ontology.ts',
      'shared/companion-map.ts',
      'shared/taxonomy.ts',
    ];
    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': sharedFiles,
        'AISDLC-100': sharedFiles,
      }),
    });
    expect(result.passed).toBe(false);
    const detail = result.detail as import('./blast-radius-overlap.js').BlastRadiusOverlapDetail;
    expect(detail.overlap.length).toBeLessThanOrEqual(3);
    expect(detail.overlapCount).toBe(5);
  });
});

// ─── (d) Candidate has empty blast-radius → admitted (degrade-open) ───────────

describe('checkBlastRadiusOverlap — (d) empty blast-radius → admitted', () => {
  it('admits the candidate when computeBlastRadiusFiles returns [] (degrade-open)', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': [], // empty blast-radius for candidate
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('BlastRadiusOverlap');
  });

  it('admits when computeBlastRadiusFiles throws for the candidate (degrade-open)', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: (taskId) => {
        if (taskId === 'AISDLC-231') throw new Error('blast-radius unavailable');
        return ['shared/types.ts'];
      },
    });
    expect(result.passed).toBe(true);
  });

  it('skips in-flight tasks whose computeBlastRadiusFiles throws (conservative: no block)', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: (taskId) => {
        if (taskId === 'AISDLC-100') throw new Error('blast-radius unavailable for in-flight');
        return ['shared/types.ts'];
      },
    });
    // Can't compute in-flight blast-radius → skip → no block.
    expect(result.passed).toBe(true);
  });
});

// ─── (e) Bypass env vars → admitted regardless of overlap ────────────────────

describe('checkBlastRadiusOverlap — (e) bypass env vars → always admitted', () => {
  it('admits when AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=1 (global bypass)', () => {
    process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS = '1';
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('BlastRadiusOverlap');
    expect(result.reason).toContain('AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS');
  });

  it('admits when AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS=true (truthy value)', () => {
    process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS = 'true';
    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({ 'AISDLC-231': ['shared/types.ts'] }),
    });
    expect(result.passed).toBe(true);
  });

  it('admits when AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK matches the candidate (per-task)', () => {
    process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK = 'AISDLC-231';
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK');
  });

  it('per-task bypass uses case-insensitive match', () => {
    process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK = 'aisdlc-231';
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
  });

  it('per-task bypass does NOT suppress OTHER candidates (different task)', () => {
    process.env.AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK = 'AISDLC-999';
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    // AISDLC-231 is NOT the bypassed task → block still fires.
    expect(result.passed).toBe(false);
  });
});

// ─── In-flight task with empty blast-radius ───────────────────────────────────

describe('checkBlastRadiusOverlap — in-flight task with empty blast-radius', () => {
  it('skips in-flight tasks with empty blast-radius (no spurious block)', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: noOpenPRs,
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': [], // in-flight has no files
      }),
    });
    expect(result.passed).toBe(true);
  });
});

// ─── gh error → sentinel fallback ────────────────────────────────────────────

describe('checkBlastRadiusOverlap — gh error → sentinel-only fallback', () => {
  it('silently skips gh signal when listOpenPRs throws; still catches sentinel overlap', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-100');
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, '.active-task'), 'AISDLC-100');

    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: () => {
        throw new Error('gh: command not found');
      },
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
        'AISDLC-100': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({
      kind: 'blast-radius-overlap',
      inFlightTaskId: 'AISDLC-100',
    });
  });

  it('admits when listOpenPRs throws and no sentinel overlap exists', () => {
    const result = checkBlastRadiusOverlap({
      taskId: 'AISDLC-231',
      repoRoot: tmp,
      listOpenPRs: () => {
        throw new Error('network error');
      },
      computeBlastRadiusFiles: makeStubCompute({
        'AISDLC-231': ['shared/types.ts'],
      }),
    });
    expect(result.passed).toBe(true);
  });
});

// ─── intersectFileSets direct tests ──────────────────────────────────────────

describe('intersectFileSets', () => {
  it('returns exact matches', () => {
    const a = ['foo.ts', 'bar.ts'];
    const b = ['bar.ts', 'baz.ts'];
    expect(intersectFileSets(a, b)).toEqual(['bar.ts']);
  });

  it('returns empty when disjoint', () => {
    expect(intersectFileSets(['a.ts'], ['b.ts'])).toEqual([]);
  });

  it('handles directory prefix in a (ends with /)', () => {
    const a = ['pipeline-cli/src/orchestrator/'];
    const b = ['pipeline-cli/src/orchestrator/loop.ts', 'pipeline-cli/src/dor/blast-radius.ts'];
    const result = intersectFileSets(a, b);
    expect(result).toContain('pipeline-cli/src/orchestrator/');
  });

  it('handles directory prefix in b covering a file in a', () => {
    const a = ['pipeline-cli/src/orchestrator/loop.ts'];
    const b = ['pipeline-cli/src/orchestrator/'];
    const result = intersectFileSets(a, b);
    expect(result).toContain('pipeline-cli/src/orchestrator/loop.ts');
  });

  it('is case-sensitive (no normalisation)', () => {
    expect(intersectFileSets(['Foo.ts'], ['foo.ts'])).toEqual([]);
    expect(intersectFileSets(['foo.ts'], ['foo.ts'])).toEqual(['foo.ts']);
  });
});

// ─── defaultComputeBlastRadiusFiles parsing ───────────────────────────────────

describe('defaultComputeBlastRadiusFiles', () => {
  it('extracts block-list references from task frontmatter', () => {
    const tasksDir = join(tmp, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const taskContent = [
      '---',
      'id: AISDLC-999',
      'title: Test task',
      'status: To Do',
      'references:',
      '  - pipeline-cli/src/orchestrator/filters/',
      '  - pipeline-cli/src/dor/blast-radius.ts',
      '---',
      '## Description',
      'test',
    ].join('\n');
    writeFileSync(join(tasksDir, 'aisdlc-999 - test-task.md'), taskContent);

    const result = defaultComputeBlastRadiusFiles('AISDLC-999', tmp);
    expect(result).toContain('pipeline-cli/src/orchestrator/filters/');
    expect(result).toContain('pipeline-cli/src/dor/blast-radius.ts');
  });

  it('returns [] when task file is not found', () => {
    const result = defaultComputeBlastRadiusFiles('AISDLC-UNKNOWN', tmp);
    expect(result).toEqual([]);
  });

  it('returns [] when frontmatter has no references field', () => {
    const tasksDir = join(tmp, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const taskContent = ['---', 'id: AISDLC-888', 'status: To Do', '---', '## Description'].join(
      '\n',
    );
    writeFileSync(join(tasksDir, 'aisdlc-888 - empty.md'), taskContent);
    const result = defaultComputeBlastRadiusFiles('AISDLC-888', tmp);
    expect(result).toEqual([]);
  });

  it('works from completed/ subdirectory too', () => {
    const completedDir = join(tmp, 'completed');
    mkdirSync(completedDir, { recursive: true });
    const taskContent = ['---', 'id: AISDLC-777', 'references:', '  - shared/types.ts', '---'].join(
      '\n',
    );
    writeFileSync(join(completedDir, 'aisdlc-777 - done.md'), taskContent);
    const result = defaultComputeBlastRadiusFiles('AISDLC-777', tmp);
    expect(result).toContain('shared/types.ts');
  });
});
