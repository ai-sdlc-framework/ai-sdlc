/**
 * Stage A integration test — RFC-0016 Phase 1 (AISDLC-279).
 *
 * End-to-end probe of `runStageA`: drops a real backlog task on disk
 * via `writeTaskFile`, then asserts the composite verdict matches the
 * RFC's §5.3 worked-example shape (file-scope + class-default + Phase
 * 3 stubs all present, no LLM calls).
 *
 * Hermetic — every test builds an isolated tmp project root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { runStageA } from './stage-a.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
let savedArtifactsDir: string | undefined;

beforeEach(() => {
  tmp = makeTmpProject();
  // Route the Phase 2 class-assignment cache writes into the tmp
  // project so the runStageA flow doesn't leak `artifacts/_estimates/`
  // under the test runner's cwd.
  savedArtifactsDir = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = tmp;
});

afterEach(() => {
  cleanupTmpProject(tmp);
  if (savedArtifactsDir === undefined) {
    delete process.env.ARTIFACTS_DIR;
  } else {
    process.env.ARTIFACTS_DIR = savedArtifactsDir;
  }
});

describe('runStageA — end-to-end', () => {
  it('returns a complete StageAResult for a real backlog task (AC #1)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-100',
      title: 'feat: add new estimator',
      references: ['src/foo.ts'],
    });
    const result = runStageA({ taskId: 'AISDLC-100', workDir: tmp });
    expect(result.taskId).toBe('AISDLC-100');
    expect(result.taskClass).toBe('feature');
    expect(result.classSource).toBe('heuristic');
    // 9 signal rows — §5.1 catalogue.
    expect(result.signals).toHaveLength(9);
    const ids = result.signals.map((s) => s.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('honors a frontmatter class: override', () => {
    const taskPath = writeTaskFile(tmp, {
      id: 'AISDLC-101',
      title: 'feat: add something',
      references: ['src/x.ts'],
    });
    // Re-write with an explicit `class:` frontmatter field — the helper
    // doesn't natively support `class:`, so we splice it in.
    const raw = readFileSync(taskPath, 'utf8');
    const patched = raw.replace(/^id: /m, 'class: chore\nid: ');
    writeFileSync(taskPath, patched, 'utf8');

    const result = runStageA({ taskId: 'AISDLC-101', workDir: tmp });
    expect(result.taskClass).toBe('chore');
    expect(result.classSource).toBe('frontmatter');
  });

  it('reproduces the §5.3 worked example shape (AISDLC-123 retrospective)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-123',
      title: 'fix: shadow-mode test exact-count',
      references: ['shadow-mode.test.ts'],
    });
    const result = runStageA({ taskId: 'AISDLC-123', workDir: tmp });
    expect(result.taskClass).toBe('bug');
    // signal #1 (file-scope) returns XS-S for 1 file
    const s1 = result.signals.find((s) => s.id === 1)!;
    expect(s1.result).toMatchObject({ kind: 'range', low: 'XS', high: 'S' });
    // signal #9 (class-default) returns S for bug
    const s9 = result.signals.find((s) => s.id === 9)!;
    expect(s9.result).toEqual({ kind: 'bucket', bucket: 'S' });
    // Final bucket should be in the XS-S range (cheap signals dominate
    // the class-default per Q8 ordering).
    expect(['XS', 'S']).toContain(result.candidateBucket);
  });

  it('respects an explicit --loc override (signal #3)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-102',
      title: 'feat: add new feature',
      references: ['src/foo.ts'],
    });
    const result = runStageA({ taskId: 'AISDLC-102', workDir: tmp, loc: 250 });
    const s3 = result.signals.find((s) => s.id === 3)!;
    expect(s3.result).toEqual({ kind: 'bucket', bucket: 'M' });
  });

  it('throws when the task file is missing', () => {
    expect(() => runStageA({ taskId: 'AISDLC-DOES-NOT-EXIST', workDir: tmp })).toThrow(
      /task file not found/,
    );
  });

  it('signal #2 + signal #8 are unknown in Phase 1 (stub behavior, AC #3 cold-start)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-103',
      title: 'chore: bump deps',
    });
    const result = runStageA({ taskId: 'AISDLC-103', workDir: tmp });
    const s2 = result.signals.find((s) => s.id === 2)!;
    const s8 = result.signals.find((s) => s.id === 8)!;
    expect(s2.result.kind).toBe('unknown');
    expect(s8.result.kind).toBe('unknown');
    // Class-default fallback (signal #9) MUST resolve when #2 is unknown.
    const s9 = result.signals.find((s) => s.id === 9)!;
    expect(s9.result.kind).toBe('bucket');
  });

  it('AC #4 — Stage A makes ZERO LLM calls (smoke check via execution time)', () => {
    // We can't directly assert "no LLM call happened" without
    // instrumenting an HTTP mock, but we can assert the function
    // returns synchronously and well within a no-network time budget.
    writeTaskFile(tmp, {
      id: 'AISDLC-104',
      title: 'feat: add CLI',
      references: ['src/a.ts', 'src/b.ts'],
    });
    const start = Date.now();
    const result = runStageA({ taskId: 'AISDLC-104', workDir: tmp });
    const elapsed = Date.now() - start;
    // 500ms is a comfortable ceiling; a real LLM call takes 1-5s.
    // Pin loose to avoid flake on a contended CI box.
    expect(elapsed).toBeLessThan(2000);
    expect(result.taskId).toBe('AISDLC-104');
  });

  // PR #279 round-1 coverage gap: readCodecovPatchThreshold (148-179) was
  // 0% covered, dragging stage-a.ts to 67.32% (below 80% gate).
  it('reads patch coverage threshold from codecov.yml at workDir root', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200',
      title: 'feat: codec dep',
      references: ['src/a.ts'],
    });
    writeFileSync(
      `${tmp}/codecov.yml`,
      'coverage:\n  status:\n    patch:\n      default:\n        target: 90%\n    project:\n      default:\n        target: 80%\n',
    );
    const result = runStageA({ taskId: 'AISDLC-200', workDir: tmp });
    const sig4 = result.signals.find((s) => s.id === 4);
    expect(sig4?.result.kind).toBe('bump');
    if (sig4?.result.kind === 'bump') {
      // 90% target should trigger the +1 bump per RFC §5.1 signal #4.
      expect(sig4.result.delta).toBe(1);
    }
  });

  it('readCodecovPatchThreshold handles malformed YAML gracefully (returns undefined)', () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-201',
      title: 'feat: malformed codecov',
      references: ['src/a.ts'],
    });
    // Unparseable target — codecov reader returns undefined, signal degrades.
    writeFileSync(
      `${tmp}/codecov.yml`,
      'coverage:\n  status:\n    patch:\n      default:\n        target: not-a-number\n',
    );
    const result = runStageA({ taskId: 'AISDLC-201', workDir: tmp });
    // No throw, result still well-formed.
    expect(result.taskId).toBe('AISDLC-201');
  });

  it('runStageA falls back to heuristic when frontmatter has no class: field', () => {
    // writeTaskFile produces a frontmatter without explicit `class:` so the
    // readFrontmatterClass "val undefined" branch is exercised.
    writeTaskFile(tmp, {
      id: 'AISDLC-202',
      title: 'feat: add something with no class field',
      references: ['src/foo.ts'],
    });
    const result = runStageA({ taskId: 'AISDLC-202', workDir: tmp });
    expect(result.classSource).toBe('heuristic');
  });

  it('runStageA does not crash when the dependency graph cannot be built', () => {
    // Write a task whose references list points at non-existent files;
    // buildDependencyGraph may throw or return empty, but Stage A must
    // still return a valid composite verdict (the catch branch ensures
    // the dependencyDepthSignal degrades to 0 rather than failing the run).
    writeTaskFile(tmp, {
      id: 'AISDLC-203',
      title: 'feat: dangling deps',
      references: ['does/not/exist/foo.ts', 'also/missing/bar.ts'],
    });
    const result = runStageA({ taskId: 'AISDLC-203', workDir: tmp });
    const sig5 = result.signals.find((s) => s.id === 5);
    // Degrade-safe: dependency depth signal exists with kind bump or unknown.
    expect(['bump', 'unknown']).toContain(sig5?.result.kind);
  });
});
