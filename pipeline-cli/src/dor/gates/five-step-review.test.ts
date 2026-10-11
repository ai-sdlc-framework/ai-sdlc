import { describe, expect, it } from 'vitest';
import { evaluateGate2 } from './gate-2-no-markers.js';
import { applyFrontmatterFields, stripFrontmatter } from '../ingress-claude.js';
import type { IssueInput } from '../types.js';

const base = (over: Partial<IssueInput>): IssueInput => ({
  source: 'backlog',
  id: 'AISDLC-1',
  title: 'Add a thing',
  body: 'Body text.',
  ...over,
});

const GOOD =
  '**Five-step review (requirements first).** The requirement was set by DEC-1. Deleted the old hook.';

describe('five-step review check (AISDLC-804)', () => {
  it('fails a labelled task with no paragraph, quoting the five steps', () => {
    const v = evaluateGate2(base({ labels: ['governance'] }));
    expect(v.verdict).toBe('fail');
    expect(v.clarificationQuestion).toMatch(/question the requirement/);
    expect(v.clarificationQuestion).toMatch(/delete/);
    expect(v.clarificationQuestion).toMatch(/simplify/);
    expect(v.clarificationQuestion).toMatch(/accelerate/);
    expect(v.clarificationQuestion).toMatch(/automate/);
  });

  it('fails a fix-titled task without the paragraph', () => {
    expect(evaluateGate2(base({ title: 'Fix the flaky hook' })).verdict).toBe('fail');
  });

  it('fails when the paragraph names no deletion', () => {
    const v = evaluateGate2(base({ labels: ['ci'], body: '**Five-step review.** Looked at it.' }));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/deletion/);
  });

  it('passes with the paragraph, and with "nothing to delete"', () => {
    expect(
      evaluateGate2(base({ labels: ['bug'], body: `Intro.\n\n${GOOD}\n\nMore.` })).verdict,
    ).toBe('pass');
    const nothing = '**Five-step review.** Requirement from DEC-2; nothing to delete.';
    expect(evaluateGate2(base({ labels: ['hooks'], body: nothing })).verdict).toBe('pass');
  });

  it('passes unlabelled non-fix tasks without the paragraph', () => {
    expect(evaluateGate2(base({ labels: ['docs'] })).verdict).toBe('pass');
  });

  it('is overridden by blocked.reason frontmatter', () => {
    const fm = "labels:\n  - governance\nblocked:\n  reason: 'operator ack'";
    const input = base({});
    applyFrontmatterFields(input, fm);
    expect(input.labels).toEqual(['governance']);
    expect(evaluateGate2(input).verdict).toBe('pass');
  });

  it('parses inline labels and folded titles', () => {
    const input = base({});
    applyFrontmatterFields(input, 'labels: [bug, ci]');
    expect(input.labels).toEqual(['bug', 'ci']);
    const { title } = stripFrontmatter('---\ntitle: >-\n  Fix a thing\nstatus: x\n---\nbody');
    expect(title).toBe('Fix a thing');
  });
});
