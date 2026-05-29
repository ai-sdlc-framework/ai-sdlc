import { describe, expect, it } from 'vitest';
import { evaluateGate7, findInvisibleDependencies } from './gate-7-deps.js';
import type { IssueInput } from '../types.js';

function input(body: string, references?: string[]): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body, references };
}

describe('findInvisibleDependencies', () => {
  // ── AC-4: dep-phrase + tracked-work id pairs are flagged when the
  // captured id is NOT in the explicit references[] list. ───────────
  it('finds "depends on AISDLC-123" without matching frontmatter ref', () => {
    const offenders = findInvisibleDependencies(input('depends on AISDLC-123 finishing'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('AISDLC-123');
  });

  it('finds "requires #456" without matching frontmatter ref', () => {
    const offenders = findInvisibleDependencies(input('requires #456'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('#456');
  });

  it('finds "blocked by RFC-0011"', () => {
    const offenders = findInvisibleDependencies(input('blocked by RFC-0011'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('RFC-0011');
  });

  it('finds "after AISDLC-101 ships"', () => {
    const offenders = findInvisibleDependencies(input('Build after AISDLC-101 ships.'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('AISDLC-101');
  });

  it('finds "once AISDLC-200 lands"', () => {
    const offenders = findInvisibleDependencies(input('Do this once AISDLC-200 lands.'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('AISDLC-200');
  });

  it('finds "needs AISDLC-77 finishing"', () => {
    const offenders = findInvisibleDependencies(input('Needs AISDLC-77 finishing.'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('AISDLC-77');
  });

  it('finds "depends on org/repo#42" cross-repo ref', () => {
    const offenders = findInvisibleDependencies(input('depends on acme/foo#42'));
    expect(offenders.length).toBe(1);
    expect(offenders[0]?.ref).toBe('acme/foo#42');
  });

  it('passes when same tracked-work id is in explicit references[]', () => {
    const offenders = findInvisibleDependencies(
      input('depends on AISDLC-101 finishing', ['AISDLC-101']),
    );
    expect(offenders.length).toBe(0);
  });

  it('passes when references[] match is case-insensitive', () => {
    const offenders = findInvisibleDependencies(input('depends on aisdlc-101', ['AISDLC-101']));
    expect(offenders.length).toBe(0);
  });

  // ── AC-2 + AC-3: bare dep-phrases without a tracked-work id do NOT
  // trigger — natural-English uses pass cleanly. ─────────────────────
  it('passes bare "depends on the auth rewrite" (no tracked-work id)', () => {
    const offenders = findInvisibleDependencies(input('depends on the auth rewrite'));
    expect(offenders.length).toBe(0);
  });

  it('passes bare "blocked by the search refactor"', () => {
    const offenders = findInvisibleDependencies(input('blocked by the search refactor'));
    expect(offenders.length).toBe(0);
  });

  it('passes prose: "X requires Y configuration"', () => {
    const offenders = findInvisibleDependencies(input('Provider X requires Y configuration.'));
    expect(offenders.length).toBe(0);
  });

  it('passes prose: "X depends on Z baseline" (PR #743 fixture)', () => {
    const offenders = findInvisibleDependencies(
      input('Statistical drift detection depends on a rolling 30d baseline.'),
    );
    expect(offenders.length).toBe(0);
  });

  it('passes prose: "promotion to evolving requires RFC amendment" (PR #743 fixture)', () => {
    const offenders = findInvisibleDependencies(
      input('Promotion to evolving requires RFC amendment by the maintainer.'),
    );
    expect(offenders.length).toBe(0);
  });

  it('passes "Do this once auth lands" (prose, no tracked-work id)', () => {
    const offenders = findInvisibleDependencies(input('Do this once auth lands.'));
    expect(offenders.length).toBe(0);
  });

  it('passes "prerequisite to ship anything" (no tracked-work id)', () => {
    const offenders = findInvisibleDependencies(input('prerequisite to ship anything'));
    expect(offenders.length).toBe(0);
  });

  it('passes "needs a green CI" (prose; no tracked-work id)', () => {
    const offenders = findInvisibleDependencies(input('This needs a green CI run before merge.'));
    expect(offenders.length).toBe(0);
  });

  it('passes "after 1.2 ships" (version-like token, not a file path)', () => {
    const offenders = findInvisibleDependencies(input('Wait to merge until after 1.2 ships.'));
    expect(offenders.length).toBe(0);
  });

  it('passes "v0.10.0 deprecation" (version-like token, not a file path)', () => {
    const offenders = findInvisibleDependencies(
      input('Track this for the v0.10.0 deprecation window.'),
    );
    expect(offenders.length).toBe(0);
  });

  it('still flags a real file-path reference (depends on src/foo.ts)', () => {
    const offenders = findInvisibleDependencies(input('depends on src/foo.ts shipping first'));
    expect(offenders.length).toBeGreaterThan(0);
  });
});

describe('evaluateGate7', () => {
  it('passes a clean body', () => {
    const v = evaluateGate7(input('plain body'));
    expect(v.verdict).toBe('pass');
  });

  it('passes prose without tracked-work ids', () => {
    const v = evaluateGate7(input('Promotion to evolving requires RFC amendment.'));
    expect(v.verdict).toBe('pass');
  });

  it('fails on "depends on AISDLC-N" missing from references', () => {
    const v = evaluateGate7(input('depends on AISDLC-101'));
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/tracked-work dependency/);
  });

  it('passes when explicit references[] covers the body ref', () => {
    const v = evaluateGate7(input('depends on AISDLC-101', ['AISDLC-101']));
    expect(v.verdict).toBe('pass');
  });
});
