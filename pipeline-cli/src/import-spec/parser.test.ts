/**
 * Hermetic tests for `import-spec/parser`.
 *
 * Covers both spec-kit schema shapes (v0.8 headings + legacy checkbox),
 * the unknown-schema fallback, and AC extraction edge cases.
 */

import { describe, expect, it } from 'vitest';
import { detectSchema, parseTasksMd } from './parser.js';

describe('detectSchema', () => {
  it('detects v0.8-headings layout from a ### T- line', () => {
    expect(detectSchema('### T-001 — Build the thing')).toBe('v0.8-headings');
    expect(detectSchema('### T-042 - Title here')).toBe('v0.8-headings');
  });

  it('detects v0.7-checkboxes layout from a - [ ] T- line', () => {
    expect(detectSchema('- [ ] T-001 — Build')).toBe('v0.7-checkboxes');
    expect(detectSchema('- [x] T-2 - Done')).toBe('v0.7-checkboxes');
  });

  it('returns unknown for prose with no task markers', () => {
    expect(detectSchema('# A spec\n\nSome prose here.')).toBe('unknown');
  });

  it('prefers headings when both shapes are present', () => {
    const src = '### T-001 — Heading task\n\n- [ ] T-002 — Checkbox';
    expect(detectSchema(src)).toBe('v0.8-headings');
  });
});

describe('parseTasksMd — v0.8 headings', () => {
  it('parses a typical spec-kit tasks.md with headings + AC lines', () => {
    const src = [
      '# Tasks for auth-feature',
      '',
      '## Tasks',
      '',
      '### T-001 — Implement bearer-token validator',
      'Body line one.',
      'Body line two.',
      'AC: POST /auth/validate returns 200 on well-formed token',
      'AC: POST /auth/validate returns 401 on malformed token',
      '',
      '### T-002 — Add expiry check',
      'AC: tokens older than 1h return 401',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('v0.8-headings');
    expect(result.entries).toHaveLength(2);

    expect(result.entries[0]).toMatchObject({
      taskId: 'T-001',
      title: 'Implement bearer-token validator',
      acceptanceCriteria: [
        'POST /auth/validate returns 200 on well-formed token',
        'POST /auth/validate returns 401 on malformed token',
      ],
    });
    expect(result.entries[0].body).toContain('Body line one.');
    expect(result.entries[0].body).toContain('Body line two.');

    expect(result.entries[1].taskId).toBe('T-002');
    expect(result.entries[1].acceptanceCriteria).toEqual(['tokens older than 1h return 401']);
  });

  it('stops a task body at the next top-level ## section', () => {
    const src = [
      '### T-001 — First',
      'Some body.',
      '',
      '## Notes',
      'This should not be in T-001 body.',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].body).toContain('Some body.');
    expect(result.entries[0].body).not.toContain('This should not');
  });

  it('handles bullet-prefixed AC: lines', () => {
    const src = ['### T-005 — Title', '- AC: one', '- AC: two'].join('\n');
    const result = parseTasksMd(src);
    expect(result.entries[0].acceptanceCriteria).toEqual(['one', 'two']);
  });
});

describe('parseTasksMd — v0.7 checkboxes', () => {
  it('parses a checkbox-style tasks.md', () => {
    const src = [
      '## Tasks',
      '',
      '- [ ] T-001 — Build endpoint',
      '  - AC: returns 200 on success',
      '  - AC: returns 400 on bad input',
      '- [x] T-002 — Done already',
      '  - AC: noop',
    ].join('\n');

    const result = parseTasksMd(src);
    expect(result.schemaVersion).toBe('v0.7-checkboxes');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].taskId).toBe('T-001');
    expect(result.entries[0].title).toBe('Build endpoint');
    expect(result.entries[0].acceptanceCriteria).toEqual([
      'returns 200 on success',
      'returns 400 on bad input',
    ]);
    expect(result.entries[1].taskId).toBe('T-002');
  });
});

describe('parseTasksMd — unknown schema', () => {
  it('returns empty entries for prose-only input', () => {
    const result = parseTasksMd('# Hello\n\nNo tasks here.');
    expect(result.schemaVersion).toBe('unknown');
    expect(result.entries).toEqual([]);
  });

  it('returns empty entries for completely empty input', () => {
    const result = parseTasksMd('');
    expect(result.schemaVersion).toBe('unknown');
    expect(result.entries).toEqual([]);
  });
});
