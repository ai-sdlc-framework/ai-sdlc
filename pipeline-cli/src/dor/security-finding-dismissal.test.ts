import { describe, it, expect } from 'vitest';
import { checkSecurityFindingCompletion } from './security-finding-dismissal.js';

const mk = (extra: string, labels = '  - security-finding', body = 'body') =>
  `---\nid: AISDLC-1\nlabels:\n${labels}\n${extra}---\n${body}\n`;

describe('checkSecurityFindingCompletion', () => {
  it('ignores tasks outside backlog/completed', () => {
    expect(checkSecurityFindingCompletion(mk(''), false).applicable).toBe(false);
  });
  it('ignores tasks without the label', () => {
    expect(checkSecurityFindingCompletion(mk('', '  - other'), true).applicable).toBe(false);
  });
  it('fails with neither PR nor dismissal', () => {
    const r = checkSecurityFindingCompletion(mk(''), true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no dismissal');
  });
  it('passes with a PR reference in the body', () => {
    expect(checkSecurityFindingCompletion(mk('', undefined, 'Fixed in PR #123'), true).ok).toBe(
      true,
    );
  });
  it('passes with prUrl frontmatter', () => {
    expect(checkSecurityFindingCompletion(mk('prUrl: https://x/pull/9\n'), true).ok).toBe(true);
  });
  it('passes with a complete dismissal', () => {
    const fm = 'dismissal:\n  reason: false positive\n  by: dom\n  date: 2026-10-27\n';
    expect(checkSecurityFindingCompletion(mk(fm), true).ok).toBe(true);
  });
  it('fails with an incomplete dismissal', () => {
    const fm = 'dismissal:\n  reason: false positive\n';
    const r = checkSecurityFindingCompletion(mk(fm), true);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('by, date');
  });
  it('fails with a scalar dismissal', () => {
    expect(checkSecurityFindingCompletion(mk('dismissal: nope\n'), true).ok).toBe(false);
  });
  it('handles missing or broken frontmatter', () => {
    expect(checkSecurityFindingCompletion('no frontmatter', true).applicable).toBe(false);
    expect(checkSecurityFindingCompletion('---\n: : [\n---\nx', true).applicable).toBe(false);
  });
});
