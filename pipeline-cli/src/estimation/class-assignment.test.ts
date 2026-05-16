/**
 * Class assignment tests — RFC-0016 Phase 1 (AISDLC-279).
 *
 * The Phase 1 stand-in for the §6.1 LLM classifier is a 3-tier rule:
 *
 *  1. Frontmatter `class:` value wins.
 *  2. Conventional-commit keyword heuristic on the title.
 *  3. Default to `feature`.
 *
 * Tests probe each tier in isolation + the precedence order.
 */

import { describe, expect, it } from 'vitest';
import { assignClass } from './class-assignment.js';

describe('assignClass — frontmatter precedence', () => {
  it('accepts the canonical class values from frontmatter', () => {
    expect(assignClass({ frontmatterClass: 'bug', title: 'fix anything' })).toEqual({
      taskClass: 'bug',
      source: 'frontmatter',
    });
    expect(assignClass({ frontmatterClass: 'feature', title: 'fix anything' })).toEqual({
      taskClass: 'feature',
      source: 'frontmatter',
    });
    expect(assignClass({ frontmatterClass: 'chore', title: 'fix anything' })).toEqual({
      taskClass: 'chore',
      source: 'frontmatter',
    });
  });

  it('accepts case-insensitive frontmatter values + trims whitespace', () => {
    expect(assignClass({ frontmatterClass: 'BUG', title: 'feat: anything' })).toEqual({
      taskClass: 'bug',
      source: 'frontmatter',
    });
    expect(assignClass({ frontmatterClass: '  Feature  ', title: 'fix x' })).toEqual({
      taskClass: 'feature',
      source: 'frontmatter',
    });
  });

  it('ignores an unrecognized frontmatter value (falls back to heuristic)', () => {
    expect(assignClass({ frontmatterClass: 'epic', title: 'feat: add x' })).toEqual({
      taskClass: 'feature',
      source: 'heuristic',
    });
  });

  it('frontmatter overrides a clear keyword in the title', () => {
    // Title says `fix:` (would match bug) but frontmatter overrides to chore.
    expect(assignClass({ frontmatterClass: 'chore', title: 'fix: bump deps' })).toEqual({
      taskClass: 'chore',
      source: 'frontmatter',
    });
  });
});

describe('assignClass — keyword heuristic', () => {
  it.each([
    ['fix: regression in PaymentValidator', 'bug'],
    ['hotfix the proxy auth header', 'bug'],
    ['bugfix: null pointer on submit', 'bug'],
    ['patch: pre-commit hook crash', 'bug'],
    ['Restore behavior after middleware regression', 'bug'],
    ['Tests are broken on Node 22', 'bug'],
  ] as const)('classifies %s as bug', (title, expected) => {
    expect(assignClass({ title }).taskClass).toBe(expected);
  });

  it.each([
    ['feat: add t-shirt-size schema field', 'feature'],
    ['feature: capability X', 'feature'],
    ['Add /ai-sdlc estimate CLI command', 'feature'],
    ['Implement Stage A signal collectors', 'feature'],
    ['Introduce ensemble sampling for estimates', 'feature'],
  ] as const)('classifies %s as feature', (title, expected) => {
    expect(assignClass({ title }).taskClass).toBe(expected);
  });

  it.each([
    ['chore: bump @types/node', 'chore'],
    ['docs: clarify CONTRIBUTING.md', 'chore'],
    ['refactor: extract helper', 'chore'],
    ['style: prettier sweep', 'chore'],
    ['test: add coverage for parser', 'chore'],
    ['ci: tighten workflow timeout', 'chore'],
    ['perf: cache the YAML parse', 'chore'],
    ['deps: bump vitest', 'chore'],
    ['rename internal helper for clarity', 'chore'],
  ] as const)('classifies %s as chore', (title, expected) => {
    expect(assignClass({ title }).taskClass).toBe(expected);
  });

  it('marks the source as heuristic when keyword matches', () => {
    expect(assignClass({ title: 'feat: add CLI' }).source).toBe('heuristic');
    expect(assignClass({ title: 'fix: crash' }).source).toBe('heuristic');
    expect(assignClass({ title: 'chore: tidy' }).source).toBe('heuristic');
  });

  it('prefers bug keywords over feature keywords (matching order)', () => {
    // "fix the new feature" — bug regex matches before feature regex.
    expect(assignClass({ title: 'fix the new feature' }).taskClass).toBe('bug');
  });
});

describe('assignClass — default fallback', () => {
  it('defaults to feature when title has no recognizable keyword', () => {
    expect(assignClass({ title: 'something inscrutable' })).toEqual({
      taskClass: 'feature',
      source: 'default',
    });
  });

  it('NEVER returns uncategorized from the Phase 1 heuristic', () => {
    // uncategorized is reserved for the Phase 2+ LLM confidence-gate
    // path; Phase 1 should never surface it (would corrupt cold-start
    // signal #9 — class-default fallback expects bug/feature/chore).
    const r1 = assignClass({ title: '' });
    const r2 = assignClass({ title: '???' });
    const r3 = assignClass({ title: 'arbitrary words' });
    expect(r1.taskClass).not.toBe('uncategorized');
    expect(r2.taskClass).not.toBe('uncategorized');
    expect(r3.taskClass).not.toBe('uncategorized');
  });
});
