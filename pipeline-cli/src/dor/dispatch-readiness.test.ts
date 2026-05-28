/**
 * Tests for the frontier dispatch-readiness rubric (AISDLC-451).
 *
 * Covers all five verdicts:
 *   - ready             — file exists, no blocker, no stale shipped commit, no closed PR
 *   - missing-id        — no file under tasks/ or completed/
 *   - blocked           — frontmatter `blocked.reason` present
 *   - stale-shipped     — file in tasks/, but merged commit on origin/main carries (ID)
 *   - closed-prior-pr   — `gh pr list --state closed` returns a non-merged PR
 *
 * Plus precedence checks (missing-id beats blocked beats stale-shipped beats closed-prior-pr)
 * and the batch helper.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicaliseTaskId,
  checkDispatchReadiness,
  checkDispatchReadinessBatch,
  findClosedPriorPRs,
  findShippedCommits,
} from './dispatch-readiness.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dispatch-readiness-test-'));
  mkdirSync(join(tmp, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(tmp, 'backlog', 'completed'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeOpenTask(id: string, body = ''): void {
  const filename = `${id.toLowerCase()} - sample-${id}.md`;
  writeFileSync(
    join(tmp, 'backlog', 'tasks', filename),
    `---\nid: ${id}\ntitle: sample\nstatus: To Do\n---\n${body}\n`,
  );
}

function writeBlockedTask(id: string, reason: string): void {
  const filename = `${id.toLowerCase()} - sample-${id}.md`;
  writeFileSync(
    join(tmp, 'backlog', 'tasks', filename),
    `---\nid: ${id}\ntitle: sample\nstatus: To Do\nblocked:\n  reason: ${reason}\n---\nbody\n`,
  );
}

function writeCompletedTask(id: string): void {
  const filename = `${id.toLowerCase()} - sample-${id}.md`;
  writeFileSync(
    join(tmp, 'backlog', 'completed', filename),
    `---\nid: ${id}\ntitle: sample\nstatus: Done\n---\nbody\n`,
  );
}

describe('dispatch-readiness — verdict matrix', () => {
  it('returns ready when file exists and all signals are negative', () => {
    writeOpenTask('AISDLC-100');
    const v = checkDispatchReadiness('AISDLC-100', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('ready');
    expect(v.taskId).toBe('AISDLC-100');
    expect(v.evidence).toEqual({});
  });

  it('returns missing-id when no file exists in either tasks/ or completed/', () => {
    const v = checkDispatchReadiness('AISDLC-NOPE', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('missing-id');
    expect(v.reason).toContain('no backlog file found');
  });

  it('returns blocked when task frontmatter has blocked.reason', () => {
    writeBlockedTask('AISDLC-101', 'Awaiting operator walkthrough');
    const v = checkDispatchReadiness('AISDLC-101', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('blocked');
    expect(v.evidence.blockedReason).toBe('Awaiting operator walkthrough');
  });

  it('returns stale-shipped when origin/main has a merged commit referencing the ID', () => {
    writeOpenTask('AISDLC-102');
    const v = checkDispatchReadiness('AISDLC-102', {
      workDir: tmp,
      gitLogCmd: () => 'abc1234 feat: ship something (AISDLC-102)\n',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('stale-shipped');
    expect(v.evidence.staleShippedCommits).toEqual(['abc1234']);
  });

  it('does NOT return stale-shipped when the task is already in completed/', () => {
    writeCompletedTask('AISDLC-103');
    const v = checkDispatchReadiness('AISDLC-103', {
      workDir: tmp,
      // Even if git log shows a match, a task in completed/ is correctly closed.
      gitLogCmd: () => 'abc1234 feat: ship (AISDLC-103)\n',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('ready');
  });

  it('returns closed-prior-pr when gh shows a closed non-merged PR', () => {
    writeOpenTask('AISDLC-104');
    const v = checkDispatchReadiness('AISDLC-104', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => JSON.stringify([{ number: 4321, state: 'CLOSED', mergedAt: null }]),
    });
    expect(v.readiness).toBe('closed-prior-pr');
    expect(v.evidence.closedPrNumbers).toEqual([4321]);
  });

  it('does NOT return closed-prior-pr when the closed PR was merged', () => {
    writeOpenTask('AISDLC-105');
    const v = checkDispatchReadiness('AISDLC-105', {
      workDir: tmp,
      // A merged PR should NOT trigger closed-prior-pr — it's evidence of shipping,
      // which is the stale-shipped check's job.
      gitLogCmd: () => '',
      ghPrListCmd: () =>
        JSON.stringify([{ number: 4321, state: 'CLOSED', mergedAt: '2026-05-20T10:00:00Z' }]),
    });
    expect(v.readiness).toBe('ready');
  });
});

describe('dispatch-readiness — verdict precedence', () => {
  it('missing-id wins over every other check (no file → no other check possible)', () => {
    const v = checkDispatchReadiness('AISDLC-200', {
      workDir: tmp,
      // Stub returns matches; precedence dictates missing-id still wins.
      gitLogCmd: () => 'abc1234 feat: (AISDLC-200)\n',
      ghPrListCmd: () => JSON.stringify([{ number: 1, state: 'CLOSED', mergedAt: null }]),
    });
    expect(v.readiness).toBe('missing-id');
  });

  it('blocked wins over stale-shipped (operator override is the strongest signal)', () => {
    writeBlockedTask('AISDLC-201', 'Held for triage');
    const v = checkDispatchReadiness('AISDLC-201', {
      workDir: tmp,
      gitLogCmd: () => 'abc1234 feat: (AISDLC-201)\n',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('blocked');
  });

  it('stale-shipped wins over closed-prior-pr (a merged commit is the more decisive signal)', () => {
    writeOpenTask('AISDLC-202');
    const v = checkDispatchReadiness('AISDLC-202', {
      workDir: tmp,
      gitLogCmd: () => 'abc1234 feat: (AISDLC-202)\n',
      ghPrListCmd: () => JSON.stringify([{ number: 999, state: 'CLOSED', mergedAt: null }]),
    });
    expect(v.readiness).toBe('stale-shipped');
  });
});

describe('dispatch-readiness — degrade-open behavior', () => {
  it('treats git-log throw as no matches (returns ready when nothing else fires)', () => {
    writeOpenTask('AISDLC-300');
    const v = checkDispatchReadiness('AISDLC-300', {
      workDir: tmp,
      gitLogCmd: () => {
        throw new Error('git not on PATH');
      },
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('ready');
  });

  it('treats gh malformed JSON as no closed PRs', () => {
    writeOpenTask('AISDLC-301');
    const v = checkDispatchReadiness('AISDLC-301', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => 'not-json',
    });
    expect(v.readiness).toBe('ready');
  });

  it('treats gh null return as no closed PRs', () => {
    writeOpenTask('AISDLC-302');
    const v = checkDispatchReadiness('AISDLC-302', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => null,
    });
    expect(v.readiness).toBe('ready');
  });

  it('treats gh empty array as no closed PRs', () => {
    writeOpenTask('AISDLC-303');
    const v = checkDispatchReadiness('AISDLC-303', {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(v.readiness).toBe('ready');
  });
});

describe('checkDispatchReadinessBatch', () => {
  it('runs the rubric over multiple IDs and returns a Map keyed by canonical ID', () => {
    writeOpenTask('AISDLC-400');
    writeBlockedTask('AISDLC-401', 'soak');
    const out = checkDispatchReadinessBatch(['AISDLC-400', 'aisdlc-401', 'AISDLC-MISSING'], {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(out.size).toBe(3);
    expect(out.get('AISDLC-400')?.readiness).toBe('ready');
    expect(out.get('AISDLC-401')?.readiness).toBe('blocked');
    expect(out.get('AISDLC-MISSING')?.readiness).toBe('missing-id');
  });

  it('normalises lowercase IDs to canonical UPPER form in the Map key', () => {
    writeOpenTask('AISDLC-500');
    const out = checkDispatchReadinessBatch(['aisdlc-500'], {
      workDir: tmp,
      gitLogCmd: () => '',
      ghPrListCmd: () => '[]',
    });
    expect(out.has('AISDLC-500')).toBe(true);
    expect(out.has('aisdlc-500')).toBe(false);
  });
});

describe('findShippedCommits', () => {
  it('parses git log --oneline output into short SHAs', () => {
    const shas = findShippedCommits('AISDLC-1', {
      workDir: tmp,
      gitLogCmd: () => 'abc1234 feat: x (AISDLC-1)\ndef5678 fix: y (AISDLC-1)\n',
    });
    expect(shas).toEqual(['abc1234', 'def5678']);
  });

  it('skips lines that do not start with a hex SHA', () => {
    const shas = findShippedCommits('AISDLC-1', {
      workDir: tmp,
      gitLogCmd: () => 'warning: ambiguous refspec\nabc1234 feat: x\n',
    });
    expect(shas).toEqual(['abc1234']);
  });

  it('returns [] on empty stdout', () => {
    const shas = findShippedCommits('AISDLC-1', {
      workDir: tmp,
      gitLogCmd: () => '',
    });
    expect(shas).toEqual([]);
  });

  it('returns [] when the runner throws', () => {
    const shas = findShippedCommits('AISDLC-1', {
      workDir: tmp,
      gitLogCmd: () => {
        throw new Error('boom');
      },
    });
    expect(shas).toEqual([]);
  });
});

describe('findClosedPriorPRs', () => {
  it('returns numbers of PRs whose mergedAt is null', () => {
    const nums = findClosedPriorPRs('AISDLC-1', {
      workDir: tmp,
      ghPrListCmd: () =>
        JSON.stringify([
          { number: 1, state: 'CLOSED', mergedAt: null },
          { number: 2, state: 'CLOSED', mergedAt: '2026-05-20T00:00:00Z' },
          { number: 3, state: 'CLOSED', mergedAt: null },
        ]),
    });
    expect(nums).toEqual([1, 3]);
  });

  it('treats missing mergedAt field as null (closed without merge)', () => {
    const nums = findClosedPriorPRs('AISDLC-1', {
      workDir: tmp,
      ghPrListCmd: () => JSON.stringify([{ number: 7, state: 'CLOSED' }]),
    });
    expect(nums).toEqual([7]);
  });

  it('returns [] on non-array JSON', () => {
    const nums = findClosedPriorPRs('AISDLC-1', {
      workDir: tmp,
      ghPrListCmd: () => JSON.stringify({ error: 'rate-limited' }),
    });
    expect(nums).toEqual([]);
  });

  it('returns [] when the runner returns null', () => {
    const nums = findClosedPriorPRs('AISDLC-1', {
      workDir: tmp,
      ghPrListCmd: () => null,
    });
    expect(nums).toEqual([]);
  });
});

describe('canonicaliseTaskId', () => {
  it('upper-cases the prefix and preserves digits', () => {
    expect(canonicaliseTaskId('aisdlc-451')).toBe('AISDLC-451');
    expect(canonicaliseTaskId('AISDLC-451')).toBe('AISDLC-451');
  });

  it('preserves dotted sub-IDs (e.g. AISDLC-100.5)', () => {
    expect(canonicaliseTaskId('aisdlc-100.5')).toBe('AISDLC-100.5');
  });

  it('falls back to upper-casing the whole string for non-matching input', () => {
    expect(canonicaliseTaskId('garbage')).toBe('GARBAGE');
  });
});
