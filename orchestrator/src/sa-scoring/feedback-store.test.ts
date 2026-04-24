import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '../state/store.js';
import {
  SAFeedbackStore,
  SA_FEEDBACK_LABELS,
  classifyLabel,
  recordOverrideFeedback,
} from './feedback-store.js';

let db: InstanceType<typeof Database>;
let store: StateStore;
let feedback: SAFeedbackStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = StateStore.open(db);
  feedback = new SAFeedbackStore(store);
});

afterEach(() => {
  store.close();
});

describe('SAFeedbackStore.record (AC #1)', () => {
  it('persists a row with all fields', () => {
    const id = feedback.record({
      didName: 'acme',
      issueNumber: 42,
      dimension: 'SA-1',
      signal: 'accept',
      principal: 'alice',
      category: 'product',
      structuralScore: 0.7,
      llmScore: 0.8,
      compositeScore: 0.77,
      notes: 'shipped cleanly',
    });
    expect(id).toBeGreaterThan(0);

    const rows = feedback.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].didName).toBe('acme');
    expect(rows[0].issueNumber).toBe(42);
    expect(rows[0].structuralScore).toBeCloseTo(0.7, 6);
    expect(rows[0].llmScore).toBeCloseTo(0.8, 6);
    expect(rows[0].category).toBe('product');
  });
});

describe('structuralPrecision (AC #2)', () => {
  it('returns precision fraction over trailing window', () => {
    // 3 directionally correct, 1 incorrect
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      structuralScore: 0.8, // high + accept → correct
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 2,
      dimension: 'SA-1',
      signal: 'dismiss',
      structuralScore: 0.2, // low + dismiss → correct
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 3,
      dimension: 'SA-1',
      signal: 'escalate',
      structuralScore: 0.3, // low + escalate → correct (was underscored)
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 4,
      dimension: 'SA-1',
      signal: 'dismiss',
      structuralScore: 0.9, // high + dismiss → incorrect
    });

    const result = feedback.structuralPrecision();
    expect(result.sampleSize).toBe(4);
    expect(result.correct).toBe(3);
    expect(result.precision).toBeCloseTo(0.75, 6);
  });

  it('excludes override signals from precision computation', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'override',
      structuralScore: 0.1,
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 2,
      dimension: 'SA-1',
      signal: 'accept',
      structuralScore: 0.8,
    });
    const result = feedback.structuralPrecision();
    expect(result.sampleSize).toBe(1);
    expect(result.correct).toBe(1);
  });

  it('returns 0 precision when no samples', () => {
    expect(feedback.structuralPrecision()).toEqual({
      sampleSize: 0,
      correct: 0,
      precision: 0,
    });
  });

  it('respects `since` window filter', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      structuralScore: 0.9,
    });
    // Only last second → none included
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = feedback.structuralPrecision({ since: future });
    expect(result.sampleSize).toBe(0);
  });

  it('respects dimension filter', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      structuralScore: 0.9,
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 2,
      dimension: 'SA-2',
      signal: 'dismiss',
      structuralScore: 0.2,
    });
    expect(feedback.structuralPrecision({ dimension: 'SA-1' }).sampleSize).toBe(1);
    expect(feedback.structuralPrecision({ dimension: 'SA-2' }).sampleSize).toBe(1);
  });
});

describe('llmPrecision', () => {
  it('evaluates LLM score directionally (same logic as structural)', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      llmScore: 0.85, // high + accept → correct
    });
    feedback.record({
      didName: 'acme',
      issueNumber: 2,
      dimension: 'SA-1',
      signal: 'dismiss',
      llmScore: 0.9, // high + dismiss → incorrect
    });
    const result = feedback.llmPrecision();
    expect(result.sampleSize).toBe(2);
    expect(result.correct).toBe(1);
    expect(result.precision).toBeCloseTo(0.5, 6);
  });
});

describe('highFalsePositiveCategories', () => {
  it('ranks categories by dismiss/total ratio', () => {
    // category A: 1 accept, 3 dismiss (FP rate 0.75)
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      category: 'A',
    });
    for (let i = 2; i <= 4; i++) {
      feedback.record({
        didName: 'acme',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'dismiss',
        category: 'A',
      });
    }
    // category B: 3 accept, 1 dismiss (FP rate 0.25)
    for (let i = 5; i <= 7; i++) {
      feedback.record({
        didName: 'acme',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'accept',
        category: 'B',
      });
    }
    feedback.record({
      didName: 'acme',
      issueNumber: 8,
      dimension: 'SA-1',
      signal: 'dismiss',
      category: 'B',
    });

    const result = feedback.highFalsePositiveCategories();
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe('A');
    expect(result[0].falsePositiveRate).toBeCloseTo(0.75, 6);
    expect(result[1].category).toBe('B');
    expect(result[1].falsePositiveRate).toBeCloseTo(0.25, 6);
  });

  it('filters out categories below minSampleSize', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'dismiss',
      category: 'rare',
    });
    const result = feedback.highFalsePositiveCategories({}, 3);
    expect(result).toEqual([]);
  });

  it('ignores events with no category', () => {
    feedback.record({
      didName: 'acme',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
    });
    expect(feedback.highFalsePositiveCategories()).toEqual([]);
  });
});

describe('classifyLabel', () => {
  it('maps sa/accept, sa/dismiss, sa/escalate to their signals', () => {
    expect(classifyLabel('sa/accept')).toBe('accept');
    expect(classifyLabel('sa/dismiss')).toBe('dismiss');
    expect(classifyLabel('sa/escalate')).toBe('escalate');
  });

  it('is case-insensitive', () => {
    expect(classifyLabel('SA/Accept')).toBe('accept');
  });

  it('returns undefined for non-SA labels', () => {
    expect(classifyLabel('bug')).toBeUndefined();
    expect(classifyLabel('sa/unknown')).toBeUndefined();
  });

  it('SA_FEEDBACK_LABELS exposes the supported label set', () => {
    expect(SA_FEEDBACK_LABELS).toEqual(['sa/accept', 'sa/dismiss', 'sa/escalate']);
  });
});

describe('recordOverrideFeedback (AC #3)', () => {
  it('emits override signal row when override is present', () => {
    recordOverrideFeedback(
      feedback,
      { reason: 'security hotfix — bypassing SA gate' },
      { didName: 'acme', issueNumber: 99, principal: 'security-lead' },
    );
    const events = feedback.list();
    expect(events).toHaveLength(1);
    expect(events[0].signal).toBe('override');
    expect(events[0].principal).toBe('security-lead');
    expect(events[0].notes).toContain('security hotfix');
  });

  it('no-ops when override is undefined', () => {
    recordOverrideFeedback(feedback, undefined, {
      didName: 'acme',
      issueNumber: 1,
    });
    expect(feedback.list()).toEqual([]);
  });

  it('records against SA-1 by convention', () => {
    recordOverrideFeedback(feedback, { reason: 'any' }, { didName: 'acme', issueNumber: 1 });
    const events = feedback.list();
    expect(events[0].dimension).toBe('SA-1');
  });
});
