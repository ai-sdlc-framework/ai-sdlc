import { describe, expect, it } from 'vitest';
import { evaluateGate1, extractAcceptanceCriteria } from './gate-1-ac-testable.js';
import type { IssueInput } from '../types.js';

function input(body: string, title = 'demo'): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title, body };
}

describe('extractAcceptanceCriteria', () => {
  it('parses well-formed AC list', () => {
    const r = extractAcceptanceCriteria(
      `## Acceptance Criteria\n- [ ] #1 first\n- [x] #2 second\n`,
    );
    expect(r.count).toBe(2);
    expect(r.entries).toEqual(['first', 'second']);
    expect(r.hasHeading).toBe(true);
    expect(r.blankEntries).toBe(0);
  });

  it('counts blank entries', () => {
    const r = extractAcceptanceCriteria(`- [ ] #1   \n- [ ] #2 real`);
    expect(r.blankEntries).toBe(1);
  });

  it('detects AC:BEGIN marker as heading', () => {
    const r = extractAcceptanceCriteria(`<!-- AC:BEGIN -->\n- [ ] #1 a`);
    expect(r.hasHeading).toBe(true);
  });
});

describe('evaluateGate1', () => {
  it('passes a healthy AC list', () => {
    const v = evaluateGate1(input(`## Acceptance Criteria\n- [ ] #1 first\n- [ ] #2 second\n`));
    expect(v.verdict).toBe('pass');
    expect(v.gateId).toBe(1);
  });

  it('fails when no ACs and no heading', () => {
    const v = evaluateGate1(input('plain text only.'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/no Acceptance Criteria section/);
  });

  it('fails with empty section heading', () => {
    const v = evaluateGate1(input('## Acceptance Criteria\n\nthen nothing'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/empty/);
  });

  it('fails when AC count exceeds upper bound', () => {
    const acs = Array.from({ length: 25 }, (_, i) => `- [ ] #${i + 1} item ${i + 1}`).join('\n');
    const v = evaluateGate1(input(`## Acceptance Criteria\n${acs}`));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/upper bound/);
  });

  it('fails when an AC is blank', () => {
    const v = evaluateGate1(input(`## Acceptance Criteria\n- [ ] #1   \n- [ ] #2 ok\n`));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/blank/);
  });

  it('returns medium confidence on pass (Stage B refines)', () => {
    const v = evaluateGate1(input(`- [ ] #1 first`));
    expect(v.verdict).toBe('pass');
    expect(v.confidence).toBe('medium');
  });
});
