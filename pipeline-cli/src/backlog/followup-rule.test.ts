import { describe, it, expect } from 'vitest';
import { checkFollowups, formatFollowupViolations } from './followup-rule.js';

const wrap = (section: string): string =>
  `## Final Summary\n\nDone.\n\n### Follow-up\n${section}\n`;

describe('checkFollowups', () => {
  it('passes when the section is absent', () => {
    expect(checkFollowups('## Final Summary\n\nDone.\n').ok).toBe(true);
  });

  it('passes on (none), bare or in a list', () => {
    expect(checkFollowups(wrap('(none)')).ok).toBe(true);
    expect(checkFollowups(wrap('- (none)')).ok).toBe(true);
    expect(checkFollowups(wrap('')).ok).toBe(true);
  });

  it('passes when every item cites a task id or issue reference', () => {
    const r = checkFollowups(
      wrap('- Inject the adapter (AISDLC-700)\n- Fix docs, see #12\n- x, see org/repo#34'),
    );
    expect(r.ok).toBe(true);
  });

  it('fails a prose item and reports it verbatim', () => {
    const r = checkFollowups(
      wrap('- The orchestrator should inject the adapter\n- Filed as AISDLC-9'),
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      { item: 'The orchestrator should inject the adapter', reason: 'no-tracked-id' },
    ]);
    const msg = formatFollowupViolations(r.violations, { file: 'a.md' });
    expect(msg).toContain('"The orchestrator should inject the adapter"');
    expect(msg).toContain('(none)');
    expect(msg).toContain('declined:');
    expect(msg).toContain('a.md');
  });

  it('accepts declined with a reason and rejects it without', () => {
    expect(checkFollowups(wrap('- declined: not worth the churn for now')).ok).toBe(true);
    const r = checkFollowups(wrap('- declined:\n- declined: short'));
    expect(r.violations.map((v) => v.reason)).toEqual([
      'declined-without-reason',
      'declined-without-reason',
    ]);
    expect(formatFollowupViolations(r.violations)).toContain('needs a reason');
  });

  it('checks paragraphs and multi-line list items', () => {
    expect(checkFollowups(wrap('Someone should look at this.')).ok).toBe(false);
    expect(checkFollowups(wrap('- Wire the thing\n  tracked in AISDLC-5')).ok).toBe(true);
  });

  it('ignores other prefixes by default and honours a custom prefix', () => {
    expect(checkFollowups(wrap('- do it, RFC-0049')).ok).toBe(false);
    expect(checkFollowups(wrap('- do it, PROJ-42'), { taskPrefix: 'PROJ' }).ok).toBe(true);
    expect(checkFollowups(wrap('- do it, PROJ-42')).ok).toBe(false);
  });

  it('supports h2 headings and stops at the next heading', () => {
    const md = '## Follow-up (deferred)\n- AISDLC-1 covers it\n\n## Other\nprose here\n';
    expect(checkFollowups(md).ok).toBe(true);
  });

  it('keeps sub-headings inside the section and ignores fenced headings', () => {
    const md = '### Follow-up\n#### Detail\n- prose only\n';
    expect(checkFollowups(md).ok).toBe(false);
    const fenced = '```\n### Follow-up\n- prose\n```\n';
    expect(checkFollowups(fenced).ok).toBe(true);
  });

  it('handles checkbox list items and emphasised none', () => {
    expect(checkFollowups(wrap('- [ ] thing (AISDLC-3)')).ok).toBe(true);
    expect(checkFollowups(wrap('**(none)**')).ok).toBe(true);
  });
});
