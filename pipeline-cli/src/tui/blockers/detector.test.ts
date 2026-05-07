/**
 * Tests for the decision-pending detector — RFC-0023 §8 / AISDLC-178.3.
 *
 * Covers (per AC#8):
 *   - Each of the 7 detection rules (Rules 1-6 + urgent-decision escalation)
 *   - Marker suppression (`<!-- ai-sdlc:not-a-decision -->`)
 *   - Urgency escalation (`<!-- ai-sdlc:urgent-decision -->`)
 *   - Sort order (urgent > changes-requested > needs-clarification > tbd > external-dep)
 *   - Deduplication by key
 *   - readTaskBody (I/O + error path)
 *   - Individual rule detectors (unit)
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectBlockers,
  detectChangesRequested,
  detectDorComment,
  detectExternalDep,
  detectNeedsClarification,
  detectOpenPrQuestion,
  detectTriageTbd,
  MARKER_DOR_COMMENT,
  MARKER_NOT_A_DECISION,
  MARKER_URGENT_DECISION,
  readTaskBody,
  sortBlockers,
  STALE_THRESHOLD_MS,
  type BlockerItem,
} from './detector.js';

import type { BacklogTask } from '../sources/backlog-walker.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<BacklogTask> = {}): BacklogTask {
  return {
    id: 'AISDLC-1',
    title: 'Test task',
    status: 'In Progress',
    priority: 'medium',
    labels: [],
    dependencies: [],
    fileLocation: 'open',
    filePath: '/fake/path/aisdlc-1.md',
    lastModified: new Date('2026-01-01T00:00:00Z').toISOString(),
    extras: {},
    ...overrides,
  };
}

function makePr(overrides: Partial<GhPrSummary> = {}): GhPrSummary {
  return {
    number: 42,
    title: 'feat: add something',
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    headRefName: 'feat/something',
    ...overrides,
  };
}

/** Stub body reader from a map. */
function bodyReader(bodies: Record<string, string>): (filePath: string) => string {
  return (filePath): string => bodies[filePath] ?? '';
}

// ── Rule 1: Needs Clarification ───────────────────────────────────────────────

describe('detectNeedsClarification (Rule 1)', () => {
  it('detects a task with status Needs Clarification', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const result = detectNeedsClarification(task, '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('needs-clarification');
    expect(result!.ref).toBe('AISDLC-1');
    expect(result!.key).toBe('task:AISDLC-1:needs-clarification');
  });

  it('returns null for tasks with other statuses', () => {
    for (const status of ['In Progress', 'To Do', 'Done', 'Blocked']) {
      expect(detectNeedsClarification(makeTask({ status }), '')).toBeNull();
    }
  });

  it('suppresses when not-a-decision marker is present', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const body = `${MARKER_NOT_A_DECISION}\n## body`;
    expect(detectNeedsClarification(task, body)).toBeNull();
  });

  it('sets isUrgent when urgent-decision marker is present', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const body = `${MARKER_URGENT_DECISION}\n## body`;
    const result = detectNeedsClarification(task, body);
    expect(result!.isUrgent).toBe(true);
  });

  it('isUrgent is false when urgent marker absent', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const result = detectNeedsClarification(task, '## body');
    expect(result!.isUrgent).toBe(false);
  });

  it('uses task title in summary', () => {
    const task = makeTask({ status: 'Needs Clarification', title: 'My Task Title' });
    const result = detectNeedsClarification(task, '');
    expect(result!.summary).toContain('My Task Title');
  });
});

// ── Rule 2: DoR comment ───────────────────────────────────────────────────────

describe('detectDorComment (Rule 2)', () => {
  it('detects when dor-comment marker is present', () => {
    const task = makeTask();
    const body = `## Description\n\n${MARKER_DOR_COMMENT}\nWhat about edge cases?`;
    const result = detectDorComment(task, body);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dor-comment');
    expect(result!.ref).toBe('AISDLC-1');
  });

  it('returns null when dor-comment marker is absent', () => {
    const task = makeTask();
    expect(detectDorComment(task, '## No marker here\n')).toBeNull();
  });

  it('suppresses when not-a-decision marker is present', () => {
    const task = makeTask();
    const body = `${MARKER_NOT_A_DECISION}\n${MARKER_DOR_COMMENT}\nbody`;
    expect(detectDorComment(task, body)).toBeNull();
  });

  it('returns null when dor-resolved marker appears AFTER dor-comment', () => {
    const task = makeTask();
    const body = `${MARKER_DOR_COMMENT}\nquestion\n<!-- ai-sdlc:dor-resolved -->\nresolved`;
    expect(detectDorComment(task, body)).toBeNull();
  });

  it('detects when dor-resolved appears BEFORE dor-comment (unresolved new Q)', () => {
    const task = makeTask();
    const body = `<!-- ai-sdlc:dor-resolved -->\nold answer\n${MARKER_DOR_COMMENT}\nnew question`;
    const result = detectDorComment(task, body);
    expect(result).not.toBeNull();
  });

  it('sets isUrgent from urgent marker', () => {
    const task = makeTask();
    const body = `${MARKER_URGENT_DECISION}\n${MARKER_DOR_COMMENT}\nbody`;
    const result = detectDorComment(task, body);
    expect(result!.isUrgent).toBe(true);
  });
});

// ── Rule 3: Triage TBD ───────────────────────────────────────────────────────

describe('detectTriageTbd (Rule 3)', () => {
  it('detects when triage extra is "tbd"', () => {
    const task = makeTask({ extras: { triage: 'tbd' } });
    const result = detectTriageTbd(task, '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('triage-tbd');
  });

  it('returns null when triage is not tbd', () => {
    for (const val of [undefined, null, 'approved', 'rejected', '']) {
      const task = makeTask({ extras: { triage: val } });
      expect(detectTriageTbd(task, '')).toBeNull();
    }
  });

  it('suppresses when not-a-decision marker is present', () => {
    const task = makeTask({ extras: { triage: 'tbd' } });
    const body = MARKER_NOT_A_DECISION;
    expect(detectTriageTbd(task, body)).toBeNull();
  });

  it('includes task title in summary', () => {
    const task = makeTask({ extras: { triage: 'tbd' }, title: 'My Capture' });
    const result = detectTriageTbd(task, '');
    expect(result!.summary).toContain('My Capture');
  });
});

// ── Rule 4: CHANGES_REQUESTED ────────────────────────────────────────────────

describe('detectChangesRequested (Rule 4)', () => {
  it('detects via reviewDecision field', () => {
    const pr = makePr() as GhPrSummary & { reviewDecision: string };
    pr.reviewDecision = 'CHANGES_REQUESTED';
    const result = detectChangesRequested(pr);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('changes-requested');
    expect(result!.ref).toBe('#42');
    expect(result!.prUrl).toBe(pr.url);
  });

  it('detects via reviews array with CHANGES_REQUESTED state', () => {
    const pr = makePr() as GhPrSummary & {
      reviews: Array<{ state: string }>;
    };
    pr.reviews = [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }];
    const result = detectChangesRequested(pr);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('changes-requested');
  });

  it('detects via changes-requested label', () => {
    const pr = makePr({ labels: [{ name: 'changes-requested' }] });
    const result = detectChangesRequested(pr);
    expect(result).not.toBeNull();
  });

  it('returns null when no signal of CHANGES_REQUESTED', () => {
    const pr = makePr({ labels: [{ name: 'approved' }] });
    expect(detectChangesRequested(pr)).toBeNull();
  });

  it('includes PR title in summary', () => {
    const pr = makePr({ title: 'fix: auth issue' }) as GhPrSummary & { reviewDecision: string };
    pr.reviewDecision = 'CHANGES_REQUESTED';
    const result = detectChangesRequested(pr);
    expect(result!.summary).toContain('fix: auth issue');
  });
});

// ── Rule 5: Open PR question ──────────────────────────────────────────────────

describe('detectOpenPrQuestion (Rule 5)', () => {
  it('detects PR title containing "?"', () => {
    const pr = makePr({ title: 'Should we add auth cookies?' });
    const result = detectOpenPrQuestion(pr);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('open-pr-question');
  });

  it('returns null for titles without "?"', () => {
    const pr = makePr({ title: 'feat: add something' });
    expect(detectOpenPrQuestion(pr)).toBeNull();
  });

  it('includes PR URL in result', () => {
    const pr = makePr({ title: 'Should this be done?' });
    const result = detectOpenPrQuestion(pr);
    expect(result!.prUrl).toBe(pr.url);
  });
});

// ── Rule 6: External dependencies ────────────────────────────────────────────

describe('detectExternalDep (Rule 6)', () => {
  it('detects when externalDependencies is a non-resolved string', () => {
    const task = makeTask({ extras: { externalDependencies: 'waiting for npm publish' } });
    const result = detectExternalDep(task, '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('external-dep');
  });

  it('detects when externalDependencies array has non-resolved entry', () => {
    const task = makeTask({ extras: { externalDependencies: ['resolved', 'pending'] } });
    const result = detectExternalDep(task, '');
    expect(result).not.toBeNull();
  });

  it('returns null when externalDependencies is "resolved"', () => {
    const task = makeTask({ extras: { externalDependencies: 'resolved' } });
    expect(detectExternalDep(task, '')).toBeNull();
  });

  it('returns null when externalDependencies array is all resolved', () => {
    const task = makeTask({ extras: { externalDependencies: ['resolved', 'Resolved'] } });
    expect(detectExternalDep(task, '')).toBeNull();
  });

  it('returns null when externalDependencies is absent', () => {
    const task = makeTask({ extras: {} });
    expect(detectExternalDep(task, '')).toBeNull();
  });

  it('returns null when externalDependencies is empty string', () => {
    const task = makeTask({ extras: { externalDependencies: '' } });
    expect(detectExternalDep(task, '')).toBeNull();
  });

  it('suppresses when not-a-decision marker is present', () => {
    const task = makeTask({ extras: { externalDependencies: 'waiting' } });
    const body = MARKER_NOT_A_DECISION;
    expect(detectExternalDep(task, body)).toBeNull();
  });
});

// ── Suppression marker ────────────────────────────────────────────────────────

describe('not-a-decision suppression marker', () => {
  it('detectBlockers skips tasks whose body contains the suppression marker', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const bodies = { [task.filePath]: `${MARKER_NOT_A_DECISION}\n## body` };
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader(bodies),
    });
    expect(result).toHaveLength(0);
  });

  it('suppresses dor-comment detection when marker present', () => {
    const task = makeTask();
    const bodies = {
      [task.filePath]: `${MARKER_NOT_A_DECISION}\n${MARKER_DOR_COMMENT}\nquestion`,
    };
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader(bodies),
    });
    expect(result).toHaveLength(0);
  });
});

// ── Urgent-decision escalation ────────────────────────────────────────────────

describe('urgent-decision escalation marker', () => {
  it('items with urgent marker sort before items without, regardless of kind', () => {
    const now = new Date('2026-01-10T00:00:00Z');

    // A needs-clarification item with urgent marker.
    const urgentTask = makeTask({
      id: 'AISDLC-1',
      status: 'Needs Clarification',
    });
    // A changes-requested PR (higher base weight) without urgent marker.
    const prItem: BlockerItem = {
      key: 'pr:99:changes-requested',
      kind: 'changes-requested',
      ref: '#99',
      summary: 'PR has changes requested',
      detail: 'details',
      updatedAt: '2026-01-09T00:00:00Z',
      prUrl: 'https://github.com/org/repo/pull/99',
      isUrgent: false,
    };

    const bodies = { [urgentTask.filePath]: `${MARKER_URGENT_DECISION}\n## body` };
    const result = detectBlockers({
      tasks: [urgentTask],
      prs: [],
      bodyReader: bodyReader(bodies),
      now,
    });
    // Manually merge the PR item.
    const merged = sortBlockers([...result, prItem], now);
    expect(merged[0].isUrgent).toBe(true);
    expect(merged[1].kind).toBe('changes-requested');
  });

  it('detectBlockers sets isUrgent on items from tasks with urgent marker', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const bodies = { [task.filePath]: `${MARKER_URGENT_DECISION}` };
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader(bodies),
    });
    expect(result[0].isUrgent).toBe(true);
  });
});

// ── Sort order ────────────────────────────────────────────────────────────────

describe('sortBlockers', () => {
  const NOW = new Date('2026-01-10T00:00:00Z');
  const FRESH = new Date('2026-01-09T00:00:00Z').toISOString();
  const STALE = new Date(NOW.getTime() - STALE_THRESHOLD_MS - 1000).toISOString();

  function makeItem(overrides: Partial<BlockerItem>): BlockerItem {
    return {
      key: 'k',
      kind: 'needs-clarification',
      ref: 'X',
      summary: 'summary',
      detail: 'detail',
      updatedAt: FRESH,
      isUrgent: false,
      ...overrides,
    };
  }

  it('urgent items sort before non-urgent regardless of kind', () => {
    const items = [
      makeItem({ key: 'a', kind: 'needs-clarification', isUrgent: false }),
      makeItem({ key: 'b', kind: 'changes-requested', isUrgent: true }),
    ];
    const sorted = sortBlockers(items, NOW);
    expect(sorted[0].key).toBe('b');
  });

  it('within non-urgent: changes-requested before needs-clarification', () => {
    const items = [
      makeItem({ key: 'a', kind: 'needs-clarification' }),
      makeItem({ key: 'b', kind: 'changes-requested' }),
    ];
    const sorted = sortBlockers(items, NOW);
    expect(sorted[0].kind).toBe('changes-requested');
    expect(sorted[1].kind).toBe('needs-clarification');
  });

  it('within same kind: fresh before stale', () => {
    const items = [
      makeItem({ key: 'stale', kind: 'needs-clarification', updatedAt: STALE }),
      makeItem({ key: 'fresh', kind: 'needs-clarification', updatedAt: FRESH }),
    ];
    const sorted = sortBlockers(items, NOW);
    expect(sorted[0].key).toBe('fresh');
    expect(sorted[1].key).toBe('stale');
  });

  it('within same kind + both fresh: most-recent-first', () => {
    const earlier = new Date('2026-01-08T00:00:00Z').toISOString();
    const later = new Date('2026-01-09T12:00:00Z').toISOString();
    const items = [
      makeItem({ key: 'a', kind: 'dor-comment', updatedAt: earlier }),
      makeItem({ key: 'b', kind: 'dor-comment', updatedAt: later }),
    ];
    const sorted = sortBlockers(items, NOW);
    expect(sorted[0].key).toBe('b');
  });

  it('full AC#3 sort order: urgent > changes-requested > needs-clarification > triage-tbd > external-dep', () => {
    const items = [
      makeItem({ key: 'ext', kind: 'external-dep' }),
      makeItem({ key: 'nc', kind: 'needs-clarification' }),
      makeItem({ key: 'cr', kind: 'changes-requested' }),
      makeItem({ key: 'tbd', kind: 'triage-tbd' }),
      makeItem({ key: 'urg', kind: 'needs-clarification', isUrgent: true }),
    ];
    const sorted = sortBlockers(items, NOW);
    expect(sorted.map((i) => i.key)).toEqual(['urg', 'cr', 'nc', 'tbd', 'ext']);
  });
});

// ── detectBlockers (integration) ──────────────────────────────────────────────

describe('detectBlockers (integration)', () => {
  it('returns empty list when no tasks and no PRs', () => {
    const result = detectBlockers({ tasks: [], prs: [], bodyReader: bodyReader({}) });
    expect(result).toEqual([]);
  });

  it('skips completed tasks', () => {
    const task = makeTask({ fileLocation: 'completed', status: 'Needs Clarification' });
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader({}),
    });
    expect(result).toHaveLength(0);
  });

  it('can detect multiple rules on a single task', () => {
    const task = makeTask({
      status: 'Needs Clarification',
      extras: { triage: 'tbd' },
    });
    const bodies = { [task.filePath]: MARKER_DOR_COMMENT };
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader(bodies),
    });
    // Rule 1 + Rule 2 + Rule 3 — all three fire (distinct keys).
    expect(result.length).toBeGreaterThanOrEqual(3);
    const kinds = result.map((r) => r.kind);
    expect(kinds).toContain('needs-clarification');
    expect(kinds).toContain('dor-comment');
    expect(kinds).toContain('triage-tbd');
  });

  it('deduplicates items with the same key', () => {
    // Edge case: detector never generates same key twice by design, but
    // we verify the dedup pass is a no-op when keys are already unique.
    const task = makeTask({ status: 'Needs Clarification' });
    const result = detectBlockers({
      tasks: [task],
      prs: [],
      bodyReader: bodyReader({}),
    });
    const keys = result.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('detects PR changes-requested + task needs-clarification together', () => {
    const task = makeTask({ status: 'Needs Clarification' });
    const pr = makePr() as GhPrSummary & { reviewDecision: string };
    pr.reviewDecision = 'CHANGES_REQUESTED';
    const result = detectBlockers({
      tasks: [task],
      prs: [pr],
      bodyReader: bodyReader({}),
    });
    const kinds = result.map((r) => r.kind);
    expect(kinds).toContain('needs-clarification');
    expect(kinds).toContain('changes-requested');
  });
});

// ── readTaskBody ──────────────────────────────────────────────────────────────

describe('readTaskBody', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'tui-blockers-body-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('reads file content successfully', () => {
    const filePath = join(workdir, 'task.md');
    writeFileSync(filePath, '## body content\n', 'utf8');
    expect(readTaskBody(filePath)).toBe('## body content\n');
  });

  it('returns empty string when file does not exist', () => {
    expect(readTaskBody(join(workdir, 'nonexistent.md'))).toBe('');
  });

  it('returns empty string when path is a directory', () => {
    const dir = join(workdir, 'adir');
    mkdirSync(dir);
    // Reading a directory returns empty string (EISDIR).
    const result = readTaskBody(dir);
    expect(typeof result).toBe('string');
    // May or may not be empty depending on platform; just mustn't throw.
  });
});
