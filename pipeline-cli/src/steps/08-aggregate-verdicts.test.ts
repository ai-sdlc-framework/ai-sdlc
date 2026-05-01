import { describe, expect, it } from 'vitest';
import { aggregateVerdicts, formatFeedback } from './08-aggregate-verdicts.js';
import type { ReviewerVerdict } from '../types.js';

function v(
  agentId: ReviewerVerdict['agentId'],
  approved: boolean,
  findings: ReviewerVerdict['findings'] = [],
): ReviewerVerdict {
  return { agentId, harness: 'claude-code', approved, findings };
}

describe('Step 8 — aggregateVerdicts', () => {
  it('APPROVED when all approve and no critical/major findings', async () => {
    const r = await aggregateVerdicts({
      verdicts: [
        v('code-reviewer', true),
        v('test-reviewer', true),
        v('security-reviewer', true, [{ severity: 'minor', message: 'nit' }]),
      ],
    });
    expect(r.decision).toBe('APPROVED');
    expect(r.approved).toBe(true);
    expect(r.counts.minor).toBe(1);
    expect(r.summary).toContain('APPROVED');
  });

  it('CHANGES_REQUESTED when any reviewer dissents', async () => {
    const r = await aggregateVerdicts({
      verdicts: [v('code-reviewer', true), v('test-reviewer', false)],
    });
    expect(r.decision).toBe('CHANGES_REQUESTED');
    expect(r.approved).toBe(false);
  });

  it('CHANGES_REQUESTED when critical/major findings exist even if all approve', async () => {
    const r = await aggregateVerdicts({
      verdicts: [
        v('code-reviewer', true, [{ severity: 'critical', message: 'bug' }]),
        v('test-reviewer', true),
      ],
    });
    expect(r.decision).toBe('CHANGES_REQUESTED');
    expect(r.counts.critical).toBe(1);
  });

  it('counts findings by severity across reviewers', async () => {
    const r = await aggregateVerdicts({
      verdicts: [
        v('code-reviewer', true, [
          { severity: 'critical', message: 'a' },
          { severity: 'major', message: 'b' },
        ]),
        v('test-reviewer', true, [{ severity: 'minor', message: 'c' }]),
      ],
    });
    expect(r.counts.critical).toBe(1);
    expect(r.counts.major).toBe(1);
    expect(r.counts.minor).toBe(1);
    expect(r.counts.suggestion).toBe(0);
  });

  it('prepends harness note to summary when present', async () => {
    const r = await aggregateVerdicts({
      verdicts: [v('code-reviewer', true)],
      harnessNote: '⚠ HARNESS WARNING',
    });
    expect(r.summary.split('\n')[0]).toBe('⚠ HARNESS WARNING');
  });

  it('handles empty verdict list as CHANGES_REQUESTED (defensive)', async () => {
    const r = await aggregateVerdicts({ verdicts: [] });
    expect(r.decision).toBe('CHANGES_REQUESTED');
  });

  it('coerces unknown severity to suggestion', async () => {
    const r = await aggregateVerdicts({
      verdicts: [v('code-reviewer', true, [{ severity: 'wat' as 'minor', message: 'x' }])],
    });
    expect(r.counts.suggestion).toBe(1);
  });
});

describe('Step 8 — formatFeedback', () => {
  it('renders blocking findings as bullet list', () => {
    const out = formatFeedback([
      v('code-reviewer', false, [
        { severity: 'critical', file: 'foo.ts', line: 42, message: 'bug' },
        { severity: 'minor', message: 'ignored — minor' },
      ]),
    ]);
    expect(out).toContain('### code-reviewer');
    expect(out).toContain('[critical] foo.ts:42 — bug');
    expect(out).not.toContain('ignored — minor');
  });

  it('skips reviewers with no blocking findings', () => {
    const out = formatFeedback([v('test-reviewer', true, [{ severity: 'minor', message: 'nit' }])]);
    expect(out).toBe('');
  });

  it('omits line when not provided', () => {
    const out = formatFeedback([
      v('code-reviewer', false, [{ severity: 'major', file: 'bar.ts', message: 'X' }]),
    ]);
    expect(out).toContain('bar.ts');
    expect(out).not.toContain('bar.ts:');
  });

  it('uses general label when no file', () => {
    const out = formatFeedback([
      v('code-reviewer', false, [{ severity: 'critical', message: 'X' }]),
    ]);
    expect(out).toContain('general');
  });
});
