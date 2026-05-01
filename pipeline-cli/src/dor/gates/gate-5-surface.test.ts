import { describe, expect, it } from 'vitest';
import { evaluateGate5, findSurfaceSignals } from './gate-5-surface.js';
import type { IssueInput } from '../types.js';

function input(body: string, title = 't'): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title, body };
}

describe('findSurfaceSignals', () => {
  it('matches backtick paths', () => {
    expect(findSurfaceSignals('change `pipeline-cli/src/foo.ts`')).toContain('backtick-path');
  });
  it('matches bare paths with extension', () => {
    expect(findSurfaceSignals('see pipeline-cli/src/foo.ts behavior')).toContain('bare-path');
  });
  it('matches route patterns with verbs', () => {
    expect(findSurfaceSignals('GET /api/users/{id}')).toContain('route-pattern');
  });
  it('matches /api paths bare', () => {
    expect(findSurfaceSignals('Adjust /api/v2/users payload')).toContain('api-path');
  });
  it('matches RFC ID', () => {
    expect(findSurfaceSignals('per RFC-0011 §4')).toContain('rfc-ref');
  });
  it('matches AISDLC ID', () => {
    expect(findSurfaceSignals('see AISDLC-115.1')).toContain('aisdlc-ref');
  });
  it('matches workspace package', () => {
    expect(findSurfaceSignals('@ai-sdlc/pipeline-cli does this')).toContain('workspace-package');
  });
  it('matches database table phrasing', () => {
    expect(findSurfaceSignals('create table tasks with two columns')).toContain('database-table');
  });
  it('matches workflow files', () => {
    expect(findSurfaceSignals('edit .github/workflows/ci.yml')).toContain('github-workflow');
  });
  it('returns empty for vague text', () => {
    expect(findSurfaceSignals('make the dashboard faster')).toEqual([]);
  });
});

describe('evaluateGate5', () => {
  it('passes when title contains a surface signal', () => {
    const v = evaluateGate5(input('vague body', 'fix RFC-0011 typo'));
    expect(v.verdict).toBe('pass');
  });
  it('fails when neither title nor body name a surface', () => {
    const v = evaluateGate5(input('Make the dashboard faster.', 'speedup'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/No affected-surface signal/);
  });
});
