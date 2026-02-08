import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { validateIssue, parseComplexity } from './validate-issue.js';
import { loadConfig } from './load-config.js';
import type { Issue } from '@ai-sdlc/reference';

const CONFIG_DIR = resolve(import.meta.dirname, '../../../.ai-sdlc');

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '1',
    title: 'Test issue',
    description: [
      '## Description',
      'A test issue description',
      '',
      '## Acceptance Criteria',
      '- It should work',
      '',
      '### Complexity',
      '2',
    ].join('\n'),
    status: 'open',
    labels: ['ai-eligible'],
    url: 'https://github.com/test/repo/issues/1',
    ...overrides,
  };
}

describe('validateIssue()', () => {
  const config = loadConfig(CONFIG_DIR);
  const qualityGate = config.qualityGate!;

  it('passes a well-formed issue', () => {
    const result = validateIssue(makeIssue(), qualityGate);
    expect(result.allowed).toBe(true);
  });

  it('passes issue with complexity at boundary (3)', () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n## Acceptance Criteria\n- ok\n\n### Complexity\n3',
    });
    const result = validateIssue(issue, qualityGate);
    expect(result.allowed).toBe(true);
  });

  it('fails issue with complexity too high (4)', () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n## Acceptance Criteria\n- ok\n\n### Complexity\n4',
    });
    const result = validateIssue(issue, qualityGate);
    expect(result.allowed).toBe(false);
  });

  it('fails issue missing acceptance criteria (soft-mandatory)', () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n### Complexity\n2',
    });
    const result = validateIssue(issue, qualityGate);
    expect(result.allowed).toBe(false);
  });

  it('allows issue with empty description (advisory gate)', () => {
    const issue = makeIssue({
      description: '## Acceptance Criteria\n- ok\n\n### Complexity\n1',
    });
    const result = validateIssue(issue, qualityGate);
    // advisory gate failure should not block
    expect(result.allowed).toBe(true);
  });

  it('returns individual gate results', () => {
    const result = validateIssue(makeIssue(), qualityGate);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.gate)).toEqual([
      'issue-has-description',
      'issue-has-acceptance-criteria',
      'complexity-in-range',
    ]);
  });
});

describe('parseComplexity()', () => {
  it('parses complexity from issue body', () => {
    expect(parseComplexity('### Complexity\n2')).toBe(2);
    expect(parseComplexity('### Complexity\n\n3')).toBe(3);
  });

  it('returns 0 for missing complexity', () => {
    expect(parseComplexity('No complexity here')).toBe(0);
    expect(parseComplexity(undefined)).toBe(0);
  });

  it('handles complexity with extra whitespace', () => {
    expect(parseComplexity('### Complexity\n  1')).toBe(1);
  });
});
