/**
 * Tests for `cli-classifier` corpus aggregator + sweeper + stats
 * (AISDLC-321 AC-5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runClassifierCli } from './classifier.js';
import {
  appendCorpusEntry,
  readCorpus,
  type CalibrationCorpusEntry,
} from '../classifier/substrate/index.js';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'aisdlc-321-cli-classifier-'));
}

function fakeEntry(overrides: Partial<CalibrationCorpusEntry> = {}): CalibrationCorpusEntry {
  return {
    id: overrides.id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
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

// Capture stdout/stderr from the yargs CLI.
function captureStdio(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    },
  };
}

describe('cli-classifier corpus aggregate', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('emits an empty per-task-type breakdown when no corpus exists', async () => {
    const stdio = captureStdio();
    try {
      await runClassifierCli(['corpus', 'aggregate', '--repo-root', repo]);
    } finally {
      stdio.restore();
    }
    const out = JSON.parse(stdio.stdout.join(''));
    expect(out.perTaskType).toHaveLength(5);
    expect(out.totalResolvedExemplars).toBe(0);
    for (const t of out.perTaskType) {
      expect(t.resolvedExemplars).toEqual([]);
      expect(t.pendingCount).toBe(0);
    }
  });

  it('separates positive vs negative exemplars + counts per task type', async () => {
    appendCorpusEntry(
      repo,
      fakeEntry({ id: 'p1', polarity: 'positive', classification: 'quick-fix-task' }),
    );
    appendCorpusEntry(
      repo,
      fakeEntry({
        id: 'n1',
        polarity: 'negative',
        classification: 'quick-fix-task',
        operatorOverrideClassification: 'new-feature-issue',
      }),
    );
    appendCorpusEntry(repo, fakeEntry({ id: 'pending', polarity: 'pending' }));

    const stdio = captureStdio();
    try {
      await runClassifierCli([
        'corpus',
        'aggregate',
        '--repo-root',
        repo,
        '--task-type',
        'capture-triage',
      ]);
    } finally {
      stdio.restore();
    }
    const out = JSON.parse(stdio.stdout.join(''));
    expect(out.perTaskType).toHaveLength(1);
    expect(out.perTaskType[0].positiveCount).toBe(1);
    expect(out.perTaskType[0].negativeCount).toBe(1);
    expect(out.perTaskType[0].pendingCount).toBe(1);
    expect(out.totalResolvedExemplars).toBe(2);
    const exemplars = out.perTaskType[0].resolvedExemplars;
    const negative = exemplars.find((e: { polarity: string }) => e.polarity === 'negative');
    expect(negative.correctClassification).toBe('new-feature-issue');
    expect(negative.llmClassification).toBe('quick-fix-task');
  });

  it('renders --format table without throwing', async () => {
    appendCorpusEntry(repo, fakeEntry({ polarity: 'positive' }));
    const stdio = captureStdio();
    try {
      await runClassifierCli(['corpus', 'aggregate', '--repo-root', repo, '--format', 'table']);
    } finally {
      stdio.restore();
    }
    const text = stdio.stdout.join('');
    expect(text).toContain('Task type');
    expect(text).toContain('capture-triage');
    expect(text).toContain('Accuracy');
  });

  it('rejects an unknown task type with a clear error', async () => {
    const stdio = captureStdio();
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
      throw new Error(`exit-${code ?? 0}`);
    }) as unknown as (code?: number | string | null) => never);
    try {
      await expect(
        runClassifierCli(['corpus', 'aggregate', '--repo-root', repo, '--task-type', 'banana']),
      ).rejects.toThrow(/exit-1/);
      const stderr = stdio.stderr.join('');
      expect(stderr).toContain('unknown task type');
    } finally {
      exitMock.mockRestore();
      stdio.restore();
    }
  });
});

describe('cli-classifier corpus stats', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports accuracy + above/below-threshold override rates', async () => {
    // Above threshold, correct.
    appendCorpusEntry(
      repo,
      fakeEntry({ id: '1', metBehindThreshold: true, polarity: 'positive', confidence: 0.85 }),
    );
    // Above threshold, overridden.
    appendCorpusEntry(
      repo,
      fakeEntry({ id: '2', metBehindThreshold: true, polarity: 'negative', confidence: 0.85 }),
    );
    // Below threshold, correct.
    appendCorpusEntry(
      repo,
      fakeEntry({ id: '3', metBehindThreshold: false, polarity: 'positive', confidence: 0.5 }),
    );
    // Below threshold, overridden.
    appendCorpusEntry(
      repo,
      fakeEntry({ id: '4', metBehindThreshold: false, polarity: 'negative', confidence: 0.5 }),
    );

    const stdio = captureStdio();
    try {
      await runClassifierCli([
        'corpus',
        'stats',
        '--repo-root',
        repo,
        '--task-type',
        'capture-triage',
      ]);
    } finally {
      stdio.restore();
    }
    const out = JSON.parse(stdio.stdout.join(''));
    expect(out.perTaskType).toHaveLength(1);
    const t = out.perTaskType[0];
    expect(t.accuracy).toBe(0.5);
    expect(t.overrideRateAboveThreshold).toBe(0.5);
    expect(t.overrideRateBelowThreshold).toBe(0.5);
  });
});

describe('cli-classifier corpus resolve-silence', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('flips old pending entries to positive', async () => {
    // Need to seed an OLD pending entry — use timestamp far in the past.
    appendCorpusEntry(repo, fakeEntry({ id: 'old', timestamp: '2020-01-01T00:00:00Z' }));
    appendCorpusEntry(repo, fakeEntry({ id: 'fresh', timestamp: new Date().toISOString() }));

    const stdio = captureStdio();
    try {
      await runClassifierCli([
        'corpus',
        'resolve-silence',
        '--repo-root',
        repo,
        '--task-type',
        'capture-triage',
      ]);
    } finally {
      stdio.restore();
    }
    const out = JSON.parse(stdio.stdout.join(''));
    expect(out.promotedCount).toBe(1);
    expect(out.perTaskType['capture-triage']).toBe(1);
    const corpus = readCorpus(repo, 'capture-triage');
    expect(corpus.find((e) => e.id === 'old')?.polarity).toBe('positive');
    expect(corpus.find((e) => e.id === 'fresh')?.polarity).toBe('pending');
  });
});
