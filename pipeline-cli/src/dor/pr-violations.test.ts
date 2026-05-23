/**
 * Tests for `pr-violations.ts` — the AISDLC-379 workflow-gate oracle.
 *
 * We test the violation computation hermetically (no filesystem, no git):
 *   - Clean PR (all admits) → hasViolations=false
 *   - PR with violations + blocked.reason override → hasViolations=false (override honored)
 *   - PR with violations + NO override → hasViolations=true (gate fires)
 *   - Mixed batch (some override, some blocking) → hasViolations=true, blocking subset correct
 *   - Missing task file (read returns null) → falls back to "no override", verdict's
 *     own `overallVerdict` decides blocking
 */

import { describe, expect, it } from 'vitest';
import { computePrViolations } from './pr-violations.js';
import type { PrTaskVerdict } from './comment-loop.js';

function fakeVerdict(
  taskId: string,
  file: string,
  overallVerdict: 'admit' | 'needs-clarification',
): PrTaskVerdict {
  return {
    issueId: taskId,
    rubricVersion: 'v1',
    overallVerdict,
    gates:
      overallVerdict === 'needs-clarification'
        ? [
            {
              gateId: 3,
              verdict: 'fail',
              severity: 'block',
              stage: 'A',
              confidence: 'high',
              finding: 'unresolved reference',
            },
          ]
        : [],
    signedAt: '2026-05-20T12:00:00.000Z',
    evaluatorVersion: 'pr-violations-test-v1',
    __file: file,
  } as PrTaskVerdict;
}

function reader(map: Record<string, string>): (path: string) => string | null {
  return (path: string): string | null => map[path] ?? null;
}

describe('computePrViolations (AISDLC-379)', () => {
  it('returns hasViolations=false when every verdict is admit', () => {
    const verdicts = [
      fakeVerdict('AISDLC-1', 'backlog/tasks/aisdlc-1 - a.md', 'admit'),
      fakeVerdict('AISDLC-2', 'backlog/tasks/aisdlc-2 - b.md', 'admit'),
    ];
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({}),
    });
    expect(result.hasViolations).toBe(false);
    expect(result.blocking).toEqual([]);
    expect(result.decisions).toHaveLength(2);
  });

  it('returns hasViolations=true when a needs-clarification verdict has NO blocked.reason override', () => {
    const verdicts = [
      fakeVerdict('AISDLC-3', 'backlog/tasks/aisdlc-3 - c.md', 'needs-clarification'),
    ];
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({
        '/tmp/x/backlog/tasks/aisdlc-3 - c.md': `---\nid: AISDLC-3\nstatus: To Do\n---\n\nbody`,
      }),
    });
    expect(result.hasViolations).toBe(true);
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]!.taskId).toBe('AISDLC-3');
    expect(result.blocking[0]!.hasBlockedReason).toBe(false);
    expect(result.blocking[0]!.blocking).toBe(true);
  });

  it('honors blocked.reason override (two-line form) and returns hasViolations=false', () => {
    const verdicts = [
      fakeVerdict('AISDLC-4', 'backlog/tasks/aisdlc-4 - d.md', 'needs-clarification'),
    ];
    const taskContents =
      '---\n' +
      'id: AISDLC-4\n' +
      'status: To Do\n' +
      'blocked:\n' +
      "  reason: 'RFC-0024 OQs acknowledged; operator walkthrough scheduled'\n" +
      '---\n\nbody';
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({
        '/tmp/x/backlog/tasks/aisdlc-4 - d.md': taskContents,
      }),
    });
    expect(result.hasViolations).toBe(false);
    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0]!.taskId).toBe('AISDLC-4');
    expect(result.overridden[0]!.hasBlockedReason).toBe(true);
    expect(result.overridden[0]!.blockedReason).toMatch(/RFC-0024 OQs acknowledged/);
    expect(result.blocking).toEqual([]);
  });

  it('honors blocked.reason override (inline-braces form)', () => {
    const verdicts = [
      fakeVerdict('AISDLC-5', 'backlog/tasks/aisdlc-5 - e.md', 'needs-clarification'),
    ];
    const taskContents =
      '---\n' + 'id: AISDLC-5\n' + "blocked: { reason: 'operator reviewed' }\n" + '---\n\nbody';
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({
        '/tmp/x/backlog/tasks/aisdlc-5 - e.md': taskContents,
      }),
    });
    expect(result.hasViolations).toBe(false);
    expect(result.overridden).toHaveLength(1);
  });

  it('mixed batch: one override + one blocking → hasViolations=true, blocking subset correct', () => {
    const verdicts = [
      fakeVerdict('AISDLC-6', 'backlog/tasks/aisdlc-6 - clean.md', 'admit'),
      fakeVerdict('AISDLC-7', 'backlog/tasks/aisdlc-7 - override.md', 'needs-clarification'),
      fakeVerdict('AISDLC-8', 'backlog/tasks/aisdlc-8 - bad.md', 'needs-clarification'),
    ];
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({
        '/tmp/x/backlog/tasks/aisdlc-7 - override.md': '---\nblocked:\n  reason: noted\n---\nbody',
        '/tmp/x/backlog/tasks/aisdlc-8 - bad.md': '---\nid: AISDLC-8\n---\nbody',
      }),
    });
    expect(result.hasViolations).toBe(true);
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]!.taskId).toBe('AISDLC-8');
    expect(result.overridden).toHaveLength(1);
    expect(result.overridden[0]!.taskId).toBe('AISDLC-7');
    // The admit verdict is in `decisions` but neither blocking nor overridden.
    expect(result.decisions).toHaveLength(3);
  });

  it('missing task file (reader returns null) → falls back to no-override, blocks per verdict', () => {
    const verdicts = [
      fakeVerdict('AISDLC-9', 'backlog/tasks/aisdlc-9 - missing.md', 'needs-clarification'),
    ];
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({}), // file not present
    });
    expect(result.hasViolations).toBe(true);
    expect(result.blocking[0]!.hasBlockedReason).toBe(false);
  });

  it('absolute __file path is used verbatim (not joined with workDir)', () => {
    const verdicts = [
      fakeVerdict('AISDLC-10', '/abs/backlog/tasks/aisdlc-10 - abs.md', 'needs-clarification'),
    ];
    const result = computePrViolations(verdicts, {
      workDir: '/tmp/x',
      readTaskFile: reader({
        '/abs/backlog/tasks/aisdlc-10 - abs.md': '---\nblocked:\n  reason: noted\n---\nbody',
      }),
    });
    expect(result.hasViolations).toBe(false);
    expect(result.overridden).toHaveLength(1);
  });

  it('empty input → hasViolations=false, no decisions', () => {
    const result = computePrViolations([], { workDir: '/tmp/x', readTaskFile: reader({}) });
    expect(result.hasViolations).toBe(false);
    expect(result.decisions).toEqual([]);
    expect(result.blocking).toEqual([]);
    expect(result.overridden).toEqual([]);
  });
});
