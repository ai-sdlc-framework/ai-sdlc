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

  describe('Backlog.md final-summary markers', () => {
    const real = (follow: string): string =>
      `## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->\n## Summary\n\nDone.\n\n## Follow-up\n\n${follow}\n<!-- SECTION:FINAL_SUMMARY:END -->\n`;

    it('passes (none) when the END marker follows the section', () => {
      expect(checkFollowups(real('(none)')).ok).toBe(true);
    });

    it('passes a cited id list', () => {
      expect(checkFollowups(real('- Wire it (AISDLC-70)\n- Also #12')).ok).toBe(true);
    });

    it('still fails a prose item and does not report the marker', () => {
      const r = checkFollowups(real('- The orchestrator should inject the adapter'));
      expect(r.ok).toBe(false);
      expect(r.violations.map((v) => v.item)).toEqual([
        'The orchestrator should inject the adapter',
      ]);
    });
  });

  it('checks every Follow-up section, not just the first', () => {
    const md = '### Follow-up\n(none)\n\n## Notes\nx\n\n### Follow-ups\n- prose only\n';
    const r = checkFollowups(md);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
  });

  it('attributes nested sub-bullets and continuations to the parent item', () => {
    expect(checkFollowups(wrap('- Parent (AISDLC-5)\n  - child prose\n    more prose')).ok).toBe(
      true,
    );
    const bad = checkFollowups(wrap('- Parent prose\n  - child cites AISDLC-5'));
    expect(bad.ok).toBe(true);
    expect(checkFollowups(wrap('- Parent prose\n  - child prose')).violations).toHaveLength(1);
  });

  it('treats an oversized item as a violation without crashing', () => {
    const r = checkFollowups(wrap(`- AISDLC-1 ${'a '.repeat(5000)}`));
    expect(r.ok).toBe(false);
    expect(r.violations[0].reason).toBe('item-too-large');
    expect(formatFollowupViolations(r.violations)).toContain('too long');
  });

  it('explains how to write issue references', () => {
    const msg = formatFollowupViolations([{ item: 'x', reason: 'no-tracked-id' }]);
    expect(msg).toContain('#123 or owner/repo#123');
    expect(msg).toContain('not as URLs');
  });

  describe('comment lines and section markers', () => {
    it('treats a line with prose between comments as prose', () => {
      const r = checkFollowups(wrap('<!-- --> visible prose <!-- -->'));
      expect(r.ok).toBe(false);
      expect(r.violations[0].item).toContain('visible prose');
    });

    it('skips a line that is only comments', () => {
      expect(checkFollowups(wrap('(none)\n<!-- a --> <!---->')).ok).toBe(true);
    });

    it('only the final-summary END marker ends the section', () => {
      const r = checkFollowups(wrap('(none)\n<!-- SECTION:X:END -->\n- untracked prose'));
      expect(r.ok).toBe(false);
      expect(r.violations[0].item).toBe('untracked prose');
      const begin = checkFollowups(wrap('(none)\n<!-- SECTION:X:BEGIN -->\n- untracked prose'));
      expect(begin.ok).toBe(false);
    });
  });

  describe('code fences', () => {
    it('only closes on a matching fence', () => {
      // A ~~~ line does not close a ``` fence, so the heading inside stays fenced.
      const md = '```\n~~~\n### Follow-up\n- prose\n```\n';
      expect(checkFollowups(md).ok).toBe(true);
      // A shorter fence does not close a longer one.
      const longer = '````\n```\n### Follow-up\n- prose\n````\n';
      expect(checkFollowups(longer).ok).toBe(true);
      // After the real close, a heading is live again.
      expect(checkFollowups('```\nx\n```\n### Follow-up\n- prose\n').ok).toBe(false);
    });

    it('does not close a section fence on a different fence token', () => {
      const md = '### Follow-up\n```\n~~~\n- AISDLC-1\n```\n';
      const r = checkFollowups(md);
      // fenced content counts as section text; the ~~~ line is an uncited item
      expect(r.ok).toBe(false);
    });

    it('documents: an unclosed fence before the heading hides the section', () => {
      expect(checkFollowups('```\nnever closed\n### Follow-up\n- prose\n').ok).toBe(true);
    });
  });

  it('says "(none)" must stand alone and rejects (none) with a reason', () => {
    const r = checkFollowups(wrap('(none) - nothing to do'));
    expect(r.ok).toBe(false);
    expect(formatFollowupViolations(r.violations)).toContain('must stand alone');
  });

  describe('adversarial input stays fast', () => {
    const BOUND_MS = 500;
    const inputs: Record<string, string> = {
      'comments then x (40)': `${'<!---->'.repeat(40)}x`,
      'comments then x (200)': `${'<!---->'.repeat(200)}x`,
      'comments with spaces then x': `${'<!-- a -->  '.repeat(200)}x`,
      'whitespace run then x': `${' '.repeat(3000)}x`,
      'word-char run': `${'a'.repeat(3000)}`,
      'dotted-dash run': `${'a.-'.repeat(1000)}/`,
      'emphasis run then x': `${'*'.repeat(3000)}x`,
      'underscore run then x': `${'_'.repeat(3000)}x`,
      'huge line': `${'<!---->'.repeat(5000)}x`,
    };
    for (const [name, line] of Object.entries(inputs)) {
      it(`checkFollowups: ${name}`, () => {
        const t = Date.now();
        checkFollowups(wrap(line));
        checkFollowups(wrap(`- ${line}`));
        expect(Date.now() - t).toBeLessThan(BOUND_MS);
      });
    }

    it('reports an over-long line as oversized (fail closed)', () => {
      const r = checkFollowups(wrap(`${'<!---->'.repeat(5000)}x`));
      expect(r.ok).toBe(false);
      expect(r.violations[0].reason).toBe('item-too-large');
    });

    it('many adversarial lines in one section stay fast', () => {
      const t = Date.now();
      const r = checkFollowups(
        wrap(
          Array(500)
            .fill(`${'<!---->'.repeat(100)}x`)
            .join('\n'),
        ),
      );
      expect(Date.now() - t).toBeLessThan(BOUND_MS);
      expect(r.ok).toBe(false);
    });
  });
});
