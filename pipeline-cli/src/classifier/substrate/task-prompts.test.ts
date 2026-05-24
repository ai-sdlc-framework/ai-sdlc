/**
 * Tests for the per-task-type prompt builder + classification validator
 * (AISDLC-321 / RFC-0024 Refit Phase 2).
 */

import { describe, expect, it } from 'vitest';

import { ALLOWED_CLASSIFICATIONS, buildPrompt, isAllowedClassification } from './task-prompts.js';
import { ALL_TASK_TYPES } from './types.js';

describe('buildPrompt', () => {
  it('emits a non-empty prompt for each of the 5 task types', () => {
    for (const t of ALL_TASK_TYPES) {
      const prompt = buildPrompt(t, { text: 'sample finding text' });
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain('JSON');
    }
  });

  it('includes the input text in the prompt body', () => {
    const finding = 'unique-marker-1741';
    for (const t of ALL_TASK_TYPES) {
      const opts =
        t === 'decision-recommendation'
          ? {
              text: finding,
              context: { optionIds: ['a', 'b'], optionDescriptions: { a: 'A', b: 'B' } },
            }
          : { text: finding };
      const prompt = buildPrompt(t, opts);
      expect(prompt).toContain(finding);
    }
  });

  it('renders the allowed set in the prompt for closed-vocabulary task types', () => {
    expect(buildPrompt('capture-triage', { text: 'x' })).toContain('quick-fix-task');
    expect(buildPrompt('capture-severity', { text: 'x' })).toContain('critical');
    expect(buildPrompt('pr-comment-is-capture', { text: 'x' })).toContain('is-capture');
    expect(buildPrompt('dor-answer-is-new-concern', { text: 'x' })).toContain('new-concern');
  });

  it('renders the caller-supplied option list for decision-recommendation', () => {
    const prompt = buildPrompt('decision-recommendation', {
      text: 'choose how to handle the rate limit',
      context: {
        optionIds: ['rate-limit-strict', 'rate-limit-warn'],
        optionDescriptions: {
          'rate-limit-strict': 'Block requests above the cap',
          'rate-limit-warn': 'Warn but allow',
        },
      },
    });
    expect(prompt).toContain('rate-limit-strict');
    expect(prompt).toContain('Block requests above the cap');
    expect(prompt).toContain('rate-limit-warn');
  });

  it('renders ad-hoc context entries (excluding decision-recommendation reserved keys)', () => {
    const prompt = buildPrompt('capture-triage', {
      text: 'finding',
      context: { prTitle: 'fix(auth): rotate session keys', author: 'octocat' },
    });
    expect(prompt).toContain('fix(auth): rotate session keys');
    expect(prompt).toContain('octocat');
  });

  it('handles missing context gracefully', () => {
    const prompt = buildPrompt('capture-triage', { text: 'finding' });
    expect(prompt).toContain('finding');
    expect(prompt).not.toContain('CONTEXT:');
  });
});

describe('isAllowedClassification', () => {
  it('accepts every value in the per-task-type allowed set', () => {
    for (const t of ALL_TASK_TYPES) {
      if (t === 'decision-recommendation') continue;
      for (const v of ALLOWED_CLASSIFICATIONS[t]) {
        expect(isAllowedClassification(t, v, { text: '' })).toBe(true);
      }
    }
  });

  it('rejects values outside the allowed set', () => {
    expect(isAllowedClassification('capture-severity', 'mid', { text: '' })).toBe(false);
    expect(isAllowedClassification('pr-comment-is-capture', 'maybe', { text: '' })).toBe(false);
  });

  it('consults caller-supplied optionIds for decision-recommendation', () => {
    const input = { text: 'x', context: { optionIds: ['option-a', 'option-b'] } };
    expect(isAllowedClassification('decision-recommendation', 'option-a', input)).toBe(true);
    expect(isAllowedClassification('decision-recommendation', 'option-c', input)).toBe(false);
  });

  it('returns false for decision-recommendation when no optionIds supplied', () => {
    expect(isAllowedClassification('decision-recommendation', 'option-a', { text: 'x' })).toBe(
      false,
    );
  });
});
