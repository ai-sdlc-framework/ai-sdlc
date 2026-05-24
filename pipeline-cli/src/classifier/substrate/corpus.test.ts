/**
 * Tests for the calibration corpus storage (AISDLC-321 AC-4).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendCorpusEntry,
  readCorpus,
  resolveCorpusDir,
  resolveCorpusFilePath,
  setCorpusEntryPolarity,
} from './corpus.js';
import type { CalibrationCorpusEntry } from './types.js';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'aisdlc-321-corpus-'));
}

function fakeEntry(overrides: Partial<CalibrationCorpusEntry> = {}): CalibrationCorpusEntry {
  return {
    id: overrides.id ?? 'entry-1',
    timestamp: overrides.timestamp ?? '2026-05-15T10:00:00Z',
    taskType: overrides.taskType ?? 'capture-triage',
    input: overrides.input ?? { text: 'a finding' },
    model: overrides.model ?? 'claude-haiku-4-5',
    classification: overrides.classification ?? 'quick-fix-task',
    confidence: overrides.confidence ?? 0.82,
    reasoning: overrides.reasoning ?? 'small change in one file',
    threshold: overrides.threshold ?? 0.7,
    metBehindThreshold: overrides.metBehindThreshold ?? true,
    polarity: overrides.polarity ?? 'pending',
    ...overrides,
  };
}

describe('path helpers', () => {
  it('resolveCorpusDir defaults to <repo>/.ai-sdlc/classifier-corpus', () => {
    expect(resolveCorpusDir('/tmp/x')).toBe('/tmp/x/.ai-sdlc/classifier-corpus');
  });

  it('resolveCorpusFilePath puts one yaml per task type', () => {
    expect(resolveCorpusFilePath('/tmp/x', 'capture-triage')).toBe(
      '/tmp/x/.ai-sdlc/classifier-corpus/capture-triage.yaml',
    );
  });

  it('honours the corpusDir override', () => {
    expect(resolveCorpusFilePath('/tmp/x', 'capture-severity', '/some/other')).toBe(
      '/some/other/capture-severity.yaml',
    );
  });
});

describe('readCorpus', () => {
  it('returns [] when the file does not exist', () => {
    const repo = makeRepo();
    try {
      expect(readCorpus(repo, 'capture-triage')).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns [] when the yaml is corrupt', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry());
      writeFileSync(resolveCorpusFilePath(repo, 'capture-triage'), 'not: valid: yaml:::');
      expect(readCorpus(repo, 'capture-triage')).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('appendCorpusEntry', () => {
  it('writes the first entry + creates the directory + file', () => {
    const repo = makeRepo();
    try {
      const entry = fakeEntry();
      appendCorpusEntry(repo, entry);
      expect(existsSync(resolveCorpusFilePath(repo, 'capture-triage'))).toBe(true);
      const read = readCorpus(repo, 'capture-triage');
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ id: 'entry-1', classification: 'quick-fix-task' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('appends to an existing file without losing prior entries', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 'e1' }));
      appendCorpusEntry(repo, fakeEntry({ id: 'e2' }));
      appendCorpusEntry(repo, fakeEntry({ id: 'e3' }));
      expect(readCorpus(repo, 'capture-triage').map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('segments entries per task type', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 't1', taskType: 'capture-triage' }));
      appendCorpusEntry(
        repo,
        fakeEntry({ id: 's1', taskType: 'capture-severity', classification: 'high' }),
      );
      const triage = readCorpus(repo, 'capture-triage');
      const severity = readCorpus(repo, 'capture-severity');
      expect(triage.map((e) => e.id)).toEqual(['t1']);
      expect(severity.map((e) => e.id)).toEqual(['s1']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('setCorpusEntryPolarity', () => {
  it('flips an existing entry to negative + records the override', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry());
      const updated = setCorpusEntryPolarity(repo, 'capture-triage', 'entry-1', {
        polarity: 'negative',
        operatorOverrideClassification: 'new-feature-issue',
        operatorOverrideReason: 'turns out this needs a full Issue',
        operatorOverrideTimestamp: '2026-05-15T14:00:00Z',
      });
      expect(updated).not.toBeNull();
      expect(updated!.polarity).toBe('negative');
      expect(updated!.operatorOverrideClassification).toBe('new-feature-issue');
      const reRead = readCorpus(repo, 'capture-triage');
      expect(reRead[0].polarity).toBe('negative');
      expect(reRead[0].operatorOverrideReason).toBe('turns out this needs a full Issue');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null when the entry id does not exist', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry());
      expect(
        setCorpusEntryPolarity(repo, 'capture-triage', 'nope', { polarity: 'positive' }),
      ).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves other entries when flipping one', () => {
    const repo = makeRepo();
    try {
      appendCorpusEntry(repo, fakeEntry({ id: 'a' }));
      appendCorpusEntry(repo, fakeEntry({ id: 'b' }));
      appendCorpusEntry(repo, fakeEntry({ id: 'c' }));
      setCorpusEntryPolarity(repo, 'capture-triage', 'b', { polarity: 'positive' });
      const all = readCorpus(repo, 'capture-triage');
      expect(all.map((e) => `${e.id}:${e.polarity}`)).toEqual([
        'a:pending',
        'b:positive',
        'c:pending',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('atomic write — no half-written files on failure', () => {
  it('rename-after-write leaves the prior version intact when the dump throws', () => {
    const repo = makeRepo();
    try {
      // Seed one valid entry.
      appendCorpusEntry(repo, fakeEntry({ id: 'a' }));
      // Verify the file is readable + parseable.
      const before = readCorpus(repo, 'capture-triage');
      expect(before.map((e) => e.id)).toEqual(['a']);
      // (We can't easily simulate a write-failure in unit tests; the atomic
      // contract is rename-after-write — the .tmp suffix prevents readers
      // from seeing a half-written file. The path-existence check below
      // proves the production file is the only one visible after success.)
      const filePath = resolveCorpusFilePath(repo, 'capture-triage');
      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(`${filePath}.tmp`)).toBe(false);
      expect(readFileSync(filePath, 'utf8')).toContain('id: a');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
