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

// Reference copies of the pre-AISDLC-704.1 single-regex matchers. They pin the
// behaviour the linear rewrite must keep; they are only ever run on short lines.
const OLD_HEADING_RE = /^###[ \t]+(T-\d+)[ \t]*[—\-:]?[ \t]*(.+)$/;
const OLD_CHECKBOX_RE = /^-[ \t]*\[[ x]\][ \t]*(T-\d+)[ \t]*[—\-:]?[ \t]*(.+)$/i;
const OLD_AC_LINE_RE = /^[ \t]*(?:-[ \t]*)?AC:[ \t]*(.+)$/i;

const sampleLines = [
  '### T-001 — Build the thing',
  '### T-42 - Title',
  '###\tT-7:\tTabbed',
  '### T-5:Tight',
  '### T-5',
  '### T-5 ',
  '### T-5 —',
  '### T-12',
  '### T-1 title\r',
  '### T-12 title\r',
  '### T-12\r',
  '### T-12 title\u2028',
  '- [ ] T-12 x\r',
  '- [ ] T-12\r',
  '###T-1 no space',
  '#### T-1 deeper',
  '- [ ] T-001 — Build',
  '- [x] T-2 - Done',
  '- [X] t-3: Upper',
  '-[ ]T-4 packed',
  '- [ ] T-9',
  '- [ ] T-9  ',
  '- [y] T-1 bad box',
  'AC: first',
  '  - AC: indented',
  '-AC:tight',
  'ac:\tlower',
  'AC:',
  'AC: ',
  'AC: has\rcr',
  'AC first',
  '',
  'plain prose',
];

describe('parser — linear matchers keep the old regex behaviour (AISDLC-704.1)', () => {
  it.each(sampleLines)('heading, checkbox and AC detection agree for %j', (line) => {
    const oldHeading = OLD_HEADING_RE.exec(line);
    const oldCheckbox = OLD_CHECKBOX_RE.exec(line);
    const oldAc = OLD_AC_LINE_RE.exec(line);

    const headingSrc = `${line}\nbody`;
    const parsedHeading = parseTasksMd(`### T-000 seed\n${line}`);
    // Schema detection sees the seed heading first; entry parsing sees `line`.
    const headingEntries = parsedHeading.entries.filter((e) => e.taskId !== 'T-000');
    if (oldHeading) {
      expect(headingEntries[0]).toMatchObject({
        taskId: oldHeading[1],
        title: oldHeading[2].trim(),
      });
    } else {
      expect(headingEntries).toHaveLength(0);
    }

    const parsedCheckbox = parseTasksMd(`- [ ] T-000 seed\n${line}`);
    const checkboxEntries = parsedCheckbox.entries.filter((e) => e.taskId !== 'T-000');
    if (oldCheckbox) {
      expect(checkboxEntries[0]).toMatchObject({
        taskId: oldCheckbox[1],
        title: oldCheckbox[2].trim(),
      });
    } else {
      expect(checkboxEntries).toHaveLength(0);
    }

    const acEntries = parseTasksMd(`### T-000 seed\n${line}`).entries;
    const acs = acEntries.find((e) => e.taskId === 'T-000')?.acceptanceCriteria ?? [];
    if (oldAc && !oldHeading) {
      expect(acs).toEqual([oldAc[1].trim()]);
    } else if (!oldHeading) {
      expect(acs).toEqual([]);
    }

    expect(detectSchema(headingSrc)).toBe(
      oldHeading ? 'v0.8-headings' : oldCheckbox ? 'v0.7-checkboxes' : 'unknown',
    );
  });

  it('stays fast on tab-run inputs that made the old regexes polynomial', () => {
    const tabs = '\t'.repeat(50_000);
    const inputs = [
      `###\tT-0${tabs}`,
      `###\tT-0${tabs}\r`,
      `- [ ] T-0${tabs}\r`,
      `### T-1 title\n-${tabs}AC:${tabs}\r`,
      `### T-1 title\nAC:${tabs}\r`,
      `${tabs}AC:${tabs}\r`,
    ];
    const started = Date.now();
    for (const input of inputs) {
      detectSchema(input);
      parseTasksMd(input);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
