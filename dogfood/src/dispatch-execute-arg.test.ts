/**
 * Hermetic tests for `parseExecuteArg`.
 *
 * AC-9 (AISDLC-393) — covers all five argument forms (AISDLC-NNN, NNN,
 * #NNN, gh:NNN, malformed) plus edge cases. The parser is pure (no IO),
 * so these tests run instantly with no fixtures or mocks.
 */

import { describe, it, expect } from 'vitest';
import { parseExecuteArg, ExecuteArgParseError } from './dispatch-execute-arg.js';

describe('parseExecuteArg (AISDLC-393 AC-1, AC-6, AC-9)', () => {
  describe('backlog task ID form (^[A-Za-z][A-Za-z0-9]*-\\d+$)', () => {
    it('parses AISDLC-393 as a backlog task', () => {
      const result = parseExecuteArg('AISDLC-393');
      expect(result).toEqual({ kind: 'backlog-task', id: 'AISDLC-393' });
    });

    it('parses lowercase aisdlc-393 as a backlog task (preserves casing)', () => {
      const result = parseExecuteArg('aisdlc-393');
      expect(result).toEqual({ kind: 'backlog-task', id: 'aisdlc-393' });
    });

    it('parses a different prefix (INGEST-42) as a backlog task', () => {
      const result = parseExecuteArg('INGEST-42');
      expect(result).toEqual({ kind: 'backlog-task', id: 'INGEST-42' });
    });

    it('parses a mixed-case prefix (IngestAlpha2-7) as a backlog task', () => {
      const result = parseExecuteArg('IngestAlpha2-7');
      expect(result).toEqual({ kind: 'backlog-task', id: 'IngestAlpha2-7' });
    });

    it('parses a hierarchical sub-task ID (AISDLC-100.5) as a backlog task', () => {
      const result = parseExecuteArg('AISDLC-100.5');
      expect(result).toEqual({ kind: 'backlog-task', id: 'AISDLC-100.5' });
    });

    it('parses a deeply hierarchical sub-task ID (AISDLC-100.5.2) as a backlog task', () => {
      const result = parseExecuteArg('AISDLC-100.5.2');
      expect(result).toEqual({ kind: 'backlog-task', id: 'AISDLC-100.5.2' });
    });

    it('trims surrounding whitespace before matching', () => {
      const result = parseExecuteArg('  AISDLC-393  ');
      expect(result).toEqual({ kind: 'backlog-task', id: 'AISDLC-393' });
    });
  });

  describe('GH-issue bare numeric / hash-prefixed form (^#?\\d+$)', () => {
    it('parses bare 612 as a GH issue', () => {
      const result = parseExecuteArg('612');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 612, originalArg: '612' });
    });

    it('parses #612 as a GH issue', () => {
      const result = parseExecuteArg('#612');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 612, originalArg: '#612' });
    });

    it('parses single-digit 1 as a GH issue', () => {
      const result = parseExecuteArg('1');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 1, originalArg: '1' });
    });

    it('parses large issue numbers correctly', () => {
      const result = parseExecuteArg('12345');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 12345, originalArg: '12345' });
    });

    it('rejects 0 as an invalid GH issue (issue numbers are positive)', () => {
      expect(() => parseExecuteArg('0')).toThrow(ExecuteArgParseError);
    });

    it('rejects #0 as an invalid GH issue', () => {
      expect(() => parseExecuteArg('#0')).toThrow(ExecuteArgParseError);
    });

    it('trims surrounding whitespace before matching', () => {
      const result = parseExecuteArg('  612  ');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 612, originalArg: '612' });
    });
  });

  describe('GH-issue explicit gh: form (^gh:\\d+$)', () => {
    it('parses gh:612 as a GH issue', () => {
      const result = parseExecuteArg('gh:612');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 612, originalArg: 'gh:612' });
    });

    it('parses gh:1 (small issue) as a GH issue', () => {
      const result = parseExecuteArg('gh:1');
      expect(result).toEqual({ kind: 'gh-issue', issueNumber: 1, originalArg: 'gh:1' });
    });

    it('rejects gh:0 as invalid', () => {
      expect(() => parseExecuteArg('gh:0')).toThrow(ExecuteArgParseError);
    });

    it('rejects gh:foo (non-numeric) as invalid', () => {
      expect(() => parseExecuteArg('gh:foo')).toThrow(ExecuteArgParseError);
    });

    it('rejects GH:612 (wrong case on prefix) as invalid', () => {
      // gh: is the explicit form; we don't auto-uppercase it. This keeps
      // the precedence rules sharp and avoids surprise for operators who
      // expect a typo to be flagged rather than silently corrected.
      expect(() => parseExecuteArg('GH:612')).toThrow(ExecuteArgParseError);
    });
  });

  describe('AC-6: invalid arguments throw with a clear error listing accepted forms', () => {
    it('throws ExecuteArgParseError for malformed input', () => {
      expect(() => parseExecuteArg('random-garbage-text')).toThrow(ExecuteArgParseError);
    });

    it('throws for empty string', () => {
      expect(() => parseExecuteArg('')).toThrow(ExecuteArgParseError);
    });

    it('throws for whitespace-only input', () => {
      expect(() => parseExecuteArg('   ')).toThrow(ExecuteArgParseError);
    });

    it('throws for null', () => {
      expect(() => parseExecuteArg(null)).toThrow(ExecuteArgParseError);
    });

    it('throws for undefined', () => {
      expect(() => parseExecuteArg(undefined)).toThrow(ExecuteArgParseError);
    });

    it('throws for number type (not string)', () => {
      expect(() => parseExecuteArg(612)).toThrow(ExecuteArgParseError);
    });

    it('error message lists all three accepted forms', () => {
      try {
        parseExecuteArg('not-a-valid-form');
        expect.fail('should have thrown');
      } catch (err) {
        if (!(err instanceof ExecuteArgParseError)) throw err;
        expect(err.message).toMatch(/AISDLC-393|<prefix>-<number>|backlog task ID/);
        expect(err.message).toMatch(/<number>|#<number>|GitHub issue/);
        expect(err.message).toMatch(/gh:<number>|explicit GitHub issue routing/);
      }
    });

    it('error message quotes the invalid input back to the operator', () => {
      try {
        parseExecuteArg('weird-input');
        expect.fail('should have thrown');
      } catch (err) {
        if (!(err instanceof ExecuteArgParseError)) throw err;
        expect(err.message).toContain("'weird-input'");
      }
    });

    it('rejects a malformed prefix (digits-only before dash, e.g. 42-12)', () => {
      // Backlog prefixes must START with a letter — `^[A-Za-z]`. A pure
      // digits prefix is not a valid backlog ID and not a bare numeric
      // either (the dash breaks the bare-numeric regex), so it should
      // surface the rejection.
      expect(() => parseExecuteArg('42-12')).toThrow(ExecuteArgParseError);
    });

    it('rejects an unprefixed dash form (e.g. -393)', () => {
      expect(() => parseExecuteArg('-393')).toThrow(ExecuteArgParseError);
    });

    it('rejects trailing dash without digits (e.g. AISDLC-)', () => {
      expect(() => parseExecuteArg('AISDLC-')).toThrow(ExecuteArgParseError);
    });

    it('rejects multiple dashes in the backlog form (e.g. AISDLC-393-foo)', () => {
      // The regex is anchored — AISDLC-393-foo would fail to match either
      // the backlog or any GH-issue form, so it gets rejected.
      expect(() => parseExecuteArg('AISDLC-393-foo')).toThrow(ExecuteArgParseError);
    });

    it('rejects mixed alpha+numeric in the GH-issue position (e.g. 612abc)', () => {
      expect(() => parseExecuteArg('612abc')).toThrow(ExecuteArgParseError);
    });
  });

  describe('precedence / edge cases', () => {
    it('gh:42 matches the explicit form first, not the bare-numeric form', () => {
      const result = parseExecuteArg('gh:42');
      expect(result.kind).toBe('gh-issue');
      if (result.kind !== 'gh-issue') return;
      // The `originalArg` should preserve the operator's typed form so
      // downstream consumers (logging, error messages) can echo it back.
      expect(result.originalArg).toBe('gh:42');
    });

    it('the parser is pure — calling it twice with the same input gives the same result', () => {
      const a = parseExecuteArg('AISDLC-393');
      const b = parseExecuteArg('AISDLC-393');
      expect(a).toEqual(b);
    });

    it('the parser is pure — calling it with different inputs does not bleed state', () => {
      parseExecuteArg('AISDLC-393');
      const result = parseExecuteArg('612');
      expect(result.kind).toBe('gh-issue');
    });
  });
});
