/**
 * Tests for the override / silence-as-positive flow (AISDLC-321 AC-6 + AC-7).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendCorpusEntry, readCorpus } from './corpus.js';
import {
  DEFAULT_OVERRIDE_WINDOW_HOURS,
  recordOperatorOverride,
  resolveOverrideWindowHours,
  resolveSilenceAsPositive,
} from './override.js';
import type { CalibrationCorpusEntry } from './types.js';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'aisdlc-321-override-'));
}

function fakeEntry(overrides: Partial<CalibrationCorpusEntry> = {}): CalibrationCorpusEntry {
  return {
    id: overrides.id ?? 'entry-1',
    timestamp: overrides.timestamp ?? '2026-05-15T10:00:00Z',
    taskType: overrides.taskType ?? 'capture-triage',
    input: overrides.input ?? { text: 'a finding' },
    model: 'claude-haiku-4-5',
    classification: 'quick-fix-task',
    confidence: 0.82,
    reasoning: 'r',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'pending',
    ...overrides,
  };
}

describe('resolveOverrideWindowHours', () => {
  it('returns default when no config file', () => {
    const repo = makeRepo();
    try {
      expect(resolveOverrideWindowHours(repo)).toBe(DEFAULT_OVERRIDE_WINDOW_HOURS);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('honours classifier.overrideWindowHours from capture-config.yaml', () => {
    const repo = makeRepo();
    try {
      mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(repo, '.ai-sdlc', 'capture-config.yaml'),
        'classifier:\n  overrideWindowHours: 48\n',
        'utf8',
      );
      expect(resolveOverrideWindowHours(repo)).toBe(48);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls back to default on invalid value', () => {
    const repo = makeRepo();
    try {
      mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(repo, '.ai-sdlc', 'capture-config.yaml'),
        'classifier:\n  overrideWindowHours: -3\n',
        'utf8',
      );
      expect(resolveOverrideWindowHours(repo)).toBe(DEFAULT_OVERRIDE_WINDOW_HOURS);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('recordOperatorOverride (AC-6)', () => {
  it('flips a pending entry to negative within the window', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 'e1' }));
      const result = recordOperatorOverride({
        repoRoot: repo,
        taskType: 'capture-triage',
        corpusEntryId: 'e1',
        newClassification: 'new-feature-issue',
        reason: 'belongs in its own Issue',
        now: '2026-05-15T20:00:00Z', // 10h after the entry
      });
      expect(result.flipped).toBe(true);
      expect(result.entry?.polarity).toBe('negative');
      expect(result.entry?.operatorOverrideClassification).toBe('new-feature-issue');
      expect(readCorpus(repo, 'capture-triage')[0].polarity).toBe('negative');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no-ops when no corpusEntryId provided', () => {
    const repo = makeRepo();
    try {
      const result = recordOperatorOverride({
        repoRoot: repo,
        taskType: 'capture-triage',
        corpusEntryId: null,
        newClassification: 'x',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('no-corpus-entry-id');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no-ops when the entry does not exist', () => {
    const repo = makeRepo();
    try {
      const result = recordOperatorOverride({
        repoRoot: repo,
        taskType: 'capture-triage',
        corpusEntryId: 'phantom',
        newClassification: 'x',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('entry-not-found');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no-ops when the override window has expired', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 'old', timestamp: '2026-05-01T00:00:00Z' }));
      const result = recordOperatorOverride({
        repoRoot: repo,
        taskType: 'capture-triage',
        corpusEntryId: 'old',
        newClassification: "won't-fix",
        now: '2026-05-15T10:00:00Z', // > 24h after the entry
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('window-expired');
      expect(readCorpus(repo, 'capture-triage')[0].polarity).toBe('pending');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('no-ops idempotently when entry already resolved', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 'e1', polarity: 'positive' }));
      const result = recordOperatorOverride({
        repoRoot: repo,
        taskType: 'capture-triage',
        corpusEntryId: 'e1',
        newClassification: 'x',
        now: '2026-05-15T20:00:00Z',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('already-resolved');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('resolveSilenceAsPositive (AC-7)', () => {
  it('promotes pending entries past the window across all task types', () => {
    const repo = makeRepo();
    try {
      // Old pending entries — should promote.
      appendCorpusEntry(
        repo,
        fakeEntry({ id: 't1', taskType: 'capture-triage', timestamp: '2026-05-10T00:00:00Z' }),
      );
      appendCorpusEntry(
        repo,
        fakeEntry({
          id: 's1',
          taskType: 'capture-severity',
          timestamp: '2026-05-10T00:00:00Z',
          classification: 'high',
        }),
      );
      // Fresh pending — should stay pending.
      appendCorpusEntry(
        repo,
        fakeEntry({ id: 't2', taskType: 'capture-triage', timestamp: '2026-05-15T08:00:00Z' }),
      );
      // Already resolved — should stay resolved.
      appendCorpusEntry(
        repo,
        fakeEntry({
          id: 't3',
          taskType: 'capture-triage',
          timestamp: '2026-05-10T00:00:00Z',
          polarity: 'negative',
        }),
      );

      const result = resolveSilenceAsPositive({
        repoRoot: repo,
        now: '2026-05-15T10:00:00Z',
      });
      expect(result.promotedCount).toBe(2);
      expect(result.perTaskType['capture-triage']).toBe(1);
      expect(result.perTaskType['capture-severity']).toBe(1);
      expect(result.windowHours).toBe(DEFAULT_OVERRIDE_WINDOW_HOURS);

      const triage = readCorpus(repo, 'capture-triage');
      expect(triage.find((e) => e.id === 't1')?.polarity).toBe('positive');
      expect(triage.find((e) => e.id === 't2')?.polarity).toBe('pending');
      expect(triage.find((e) => e.id === 't3')?.polarity).toBe('negative');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('limits scope to caller-supplied task types', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(
        repo,
        fakeEntry({ id: 't1', taskType: 'capture-triage', timestamp: '2026-05-10T00:00:00Z' }),
      );
      appendCorpusEntry(
        repo,
        fakeEntry({
          id: 's1',
          taskType: 'capture-severity',
          timestamp: '2026-05-10T00:00:00Z',
          classification: 'high',
        }),
      );

      const result = resolveSilenceAsPositive({
        repoRoot: repo,
        taskTypes: ['capture-triage'],
        now: '2026-05-15T10:00:00Z',
      });
      expect(result.promotedCount).toBe(1);
      expect(readCorpus(repo, 'capture-severity')[0].polarity).toBe('pending');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is idempotent across runs', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(
        repo,
        fakeEntry({ id: 't1', taskType: 'capture-triage', timestamp: '2026-05-10T00:00:00Z' }),
      );
      const first = resolveSilenceAsPositive({ repoRoot: repo, now: '2026-05-15T10:00:00Z' });
      const second = resolveSilenceAsPositive({ repoRoot: repo, now: '2026-05-15T10:00:00Z' });
      expect(first.promotedCount).toBe(1);
      expect(second.promotedCount).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
