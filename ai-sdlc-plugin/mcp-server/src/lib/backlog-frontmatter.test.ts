import { describe, it, expect } from 'vitest';
import {
  applyTaskEdit,
  checkAcceptanceCriteria,
  joinFrontmatter,
  parseFrontmatterBlocks,
  readFrontmatterScalar,
  serializeFrontmatterBlocks,
  setFinalSummary,
  setFrontmatterScalar,
  splitFrontmatter,
} from './backlog-frontmatter.js';

// ── AC #1 — bug reproducer ─────────────────────────────────────────────
//
// The original `mcp__backlog__task_edit` re-serialises frontmatter from
// its known schema and silently strips unknown keys. The dogfood example
// is `permittedExternalPaths` getting wiped on every status flip. This
// test is the regression guard: status flip MUST preserve every other
// key in the frontmatter, byte-for-byte where reasonable.

describe('applyTaskEdit (AISDLC-73 regression)', () => {
  const aisdlc68Fixture = [
    '---',
    'id: AISDLC-68',
    "title: 'Documentation consolidation'",
    'status: To Do',
    'assignee: []',
    "created_date: '2026-04-26 19:20'",
    "updated_date: '2026-04-27 22:00'",
    'labels:',
    '  - docs',
    '  - infrastructure',
    'dependencies: []',
    'priority: medium',
    'permittedExternalPaths:',
    "  - '../ai-sdlc-io/'",
    '---',
    '',
    '## Description',
    '',
    'Body text.',
    '',
  ].join('\n');

  it('preserves permittedExternalPaths across a status flip (AC #1)', () => {
    const result = applyTaskEdit(aisdlc68Fixture, {
      status: 'In Progress',
      updatedDate: '2026-04-27 22:30',
    });

    // The bug we're fixing: this assertion would FAIL before the fix.
    expect(result).toContain('permittedExternalPaths:');
    expect(result).toContain("  - '../ai-sdlc-io/'");

    // And the actual change still happened.
    expect(result).toContain('status: In Progress');
    expect(result).toContain("updated_date: '2026-04-27 22:30'");

    // And nothing else was disturbed.
    expect(result).toContain('id: AISDLC-68');
    expect(result).toContain("title: 'Documentation consolidation'");
    expect(result).toContain('  - docs');
    expect(result).toContain('  - infrastructure');
    expect(result).toContain('priority: medium');
  });

  it('preserves permittedExternalPaths across MULTIPLE status flips (AC #4)', () => {
    // Simulate the AISDLC-68 dogfood scenario: To Do → In Progress → Done.
    // The bug surfaced after a single flip; this test asserts repeated
    // flips don't accumulate damage either.
    const afterFirst = applyTaskEdit(aisdlc68Fixture, {
      status: 'In Progress',
      updatedDate: '2026-04-27 22:30',
    });
    const afterSecond = applyTaskEdit(afterFirst, {
      status: 'Done',
      updatedDate: '2026-04-27 23:00',
      finalSummary: 'Done.',
    });

    expect(afterSecond).toContain('permittedExternalPaths:');
    expect(afterSecond).toContain("  - '../ai-sdlc-io/'");
    expect(afterSecond).toContain('status: Done');
    expect(afterSecond).toContain('## Final Summary');
  });
});

// ── splitFrontmatter / joinFrontmatter ─────────────────────────────────

describe('splitFrontmatter', () => {
  it('round-trips a typical task file byte-for-byte', () => {
    const content = ['---', 'id: T-1', 'status: To Do', '---', '', 'Body line.', ''].join('\n');
    expect(joinFrontmatter(splitFrontmatter(content))).toBe(content);
  });

  it('handles CRLF line endings', () => {
    const content = ['---', 'id: T-1', 'status: To Do', '---', '', 'Body.', ''].join('\r\n');
    const split = splitFrontmatter(content);
    expect(split.lineEnding).toBe('\r\n');
    expect(joinFrontmatter(split)).toBe(content);
  });

  it('returns no frontmatter for a file without a leading ---', () => {
    const content = 'Just a body.\nNo frontmatter.\n';
    const split = splitFrontmatter(content);
    expect(split.hasFrontmatter).toBe(false);
    expect(split.frontmatterLines).toEqual([]);
    expect(joinFrontmatter(split)).toBe(content);
  });

  it('treats an unclosed --- as no frontmatter (safer than truncating)', () => {
    const content = '---\nid: T-1\nstatus: To Do\n\nBody.\n';
    const split = splitFrontmatter(content);
    expect(split.hasFrontmatter).toBe(false);
    expect(joinFrontmatter(split)).toBe(content);
  });

  it('handles an empty frontmatter (AC #5 edge case)', () => {
    const content = '---\n---\n\nBody.\n';
    const split = splitFrontmatter(content);
    expect(split.hasFrontmatter).toBe(true);
    expect(split.frontmatterLines).toEqual([]);
    expect(joinFrontmatter(split)).toBe(content);
  });
});

// ── parseFrontmatterBlocks ─────────────────────────────────────────────

describe('parseFrontmatterBlocks', () => {
  it('parses scalar keys into single-line blocks', () => {
    const blocks = parseFrontmatterBlocks(['id: T-1', 'status: To Do', 'priority: medium']);
    expect(blocks).toEqual([
      { key: 'id', lines: ['id: T-1'] },
      { key: 'status', lines: ['status: To Do'] },
      { key: 'priority', lines: ['priority: medium'] },
    ]);
  });

  it('folds block sequences into the preceding key', () => {
    const blocks = parseFrontmatterBlocks(['labels:', '  - docs', '  - infrastructure']);
    expect(blocks).toEqual([
      { key: 'labels', lines: ['labels:', '  - docs', '  - infrastructure'] },
    ]);
  });

  it('folds folded scalars (>-) into the preceding key (AC #5)', () => {
    const blocks = parseFrontmatterBlocks([
      'title: >-',
      '  A long title that wraps',
      '  across multiple lines',
      'status: Done',
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].key).toBe('title');
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[1]).toEqual({ key: 'status', lines: ['status: Done'] });
  });

  it('preserves stray pre-key lines as keyless blocks', () => {
    const blocks = parseFrontmatterBlocks(['# top-level comment', 'id: T-1']);
    expect(blocks[0].key).toBe('');
    expect(blocks[0].lines).toEqual(['# top-level comment']);
    expect(blocks[1].key).toBe('id');
  });

  it('round-trips through serializeFrontmatterBlocks', () => {
    const lines = [
      'id: T-1',
      'labels:',
      '  - a',
      '  - b',
      'permittedExternalPaths:',
      "  - '../x/'",
    ];
    expect(serializeFrontmatterBlocks(parseFrontmatterBlocks(lines))).toEqual(lines);
  });

  it('handles only-unknown-fields frontmatter (AC #5)', () => {
    const blocks = parseFrontmatterBlocks(['customField: 1', 'anotherCustom: 2']);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.key)).toEqual(['customField', 'anotherCustom']);
  });
});

// ── setFrontmatterScalar ───────────────────────────────────────────────

describe('setFrontmatterScalar', () => {
  it('replaces an existing scalar in place (preserving key order)', () => {
    const blocks = parseFrontmatterBlocks(['id: T-1', 'status: To Do', 'priority: medium']);
    const next = setFrontmatterScalar(blocks, 'status', 'In Progress');
    expect(next.map((b) => b.key)).toEqual(['id', 'status', 'priority']);
    expect(serializeFrontmatterBlocks(next)).toEqual([
      'id: T-1',
      'status: In Progress',
      'priority: medium',
    ]);
  });

  it('appends a new scalar at the end when the key is absent', () => {
    const blocks = parseFrontmatterBlocks(['id: T-1', 'status: To Do']);
    const next = setFrontmatterScalar(blocks, 'updated_date', '2026-04-27 22:30');
    expect(serializeFrontmatterBlocks(next)).toEqual([
      'id: T-1',
      'status: To Do',
      "updated_date: '2026-04-27 22:30'",
    ]);
  });

  it('replaces a multi-line block with a single-line scalar when re-set', () => {
    const blocks = parseFrontmatterBlocks(['labels:', '  - a', '  - b']);
    const next = setFrontmatterScalar(blocks, 'labels', 'overridden');
    expect(serializeFrontmatterBlocks(next)).toEqual(['labels: overridden']);
  });

  it('quotes values that need quoting (date, special chars)', () => {
    const blocks: ReturnType<typeof parseFrontmatterBlocks> = [];
    expect(
      serializeFrontmatterBlocks(setFrontmatterScalar(blocks, 'updated_date', '2026-04-27 22:30')),
    ).toEqual(["updated_date: '2026-04-27 22:30'"]);
    expect(serializeFrontmatterBlocks(setFrontmatterScalar(blocks, 'title', 'Has: colon'))).toEqual(
      ["title: 'Has: colon'"],
    );
    expect(serializeFrontmatterBlocks(setFrontmatterScalar(blocks, 'flag', 'true'))).toEqual([
      "flag: 'true'",
    ]);
  });

  it("escapes single quotes in YAML 1.2 style ('' -> ')", () => {
    const blocks: ReturnType<typeof parseFrontmatterBlocks> = [];
    const next = setFrontmatterScalar(blocks, 'title', "It's: a test");
    expect(serializeFrontmatterBlocks(next)).toEqual(["title: 'It''s: a test'"]);
    // And the read helper round-trips it back.
    const fileContent = ['---', ...serializeFrontmatterBlocks(next), '---', ''].join('\n');
    expect(readFrontmatterScalar(fileContent, 'title')).toBe("It's: a test");
  });

  it('emits unquoted scalars when no quoting is needed', () => {
    const blocks: ReturnType<typeof parseFrontmatterBlocks> = [];
    expect(serializeFrontmatterBlocks(setFrontmatterScalar(blocks, 'status', 'Done'))).toEqual([
      'status: Done',
    ]);
    expect(serializeFrontmatterBlocks(setFrontmatterScalar(blocks, 'priority', 'medium'))).toEqual([
      'priority: medium',
    ]);
  });
});

// ── checkAcceptanceCriteria ────────────────────────────────────────────

describe('checkAcceptanceCriteria', () => {
  const body = [
    '## Description',
    '',
    'Some description.',
    '',
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    '- [ ] #1 First criterion',
    '- [ ] #2 Second criterion',
    '- [ ] #3 Third criterion',
    '<!-- AC:END -->',
    '',
    '## Notes',
    '',
    '- [ ] Not an AC, do not flip',
  ];

  it('flips checkboxes for the requested indices', () => {
    const out = checkAcceptanceCriteria(body, [1, 3]);
    expect(out).toContain('- [x] #1 First criterion');
    expect(out).toContain('- [ ] #2 Second criterion');
    expect(out).toContain('- [x] #3 Third criterion');
  });

  it('leaves non-AC checkboxes alone', () => {
    const out = checkAcceptanceCriteria(body, [1, 2, 3]);
    expect(out).toContain('- [ ] Not an AC, do not flip');
  });

  it('is a no-op when given an empty index list', () => {
    expect(checkAcceptanceCriteria(body, [])).toBe(body);
  });

  it('handles ACs without explicit #N markers (positional)', () => {
    const positional = ['## Acceptance Criteria', '- [ ] First', '- [ ] Second'];
    const out = checkAcceptanceCriteria(positional, [2]);
    expect(out).toEqual(['## Acceptance Criteria', '- [ ] First', '- [x] Second']);
  });

  it('does not re-check already-checked criteria (idempotent on already-checked)', () => {
    const partlyChecked = ['## Acceptance Criteria', '- [x] #1 Done', '- [ ] #2 Pending'];
    const out = checkAcceptanceCriteria(partlyChecked, [1, 2]);
    expect(out).toEqual(['## Acceptance Criteria', '- [x] #1 Done', '- [x] #2 Pending']);
  });
});

// ── setFinalSummary ────────────────────────────────────────────────────

describe('setFinalSummary', () => {
  it('appends a Final Summary section when none exists', () => {
    const body = ['## Description', '', 'Hello.', ''];
    const out = setFinalSummary(body, 'All ACs met.');
    expect(out).toEqual([
      '## Description',
      '',
      'Hello.',
      '',
      '## Final Summary',
      '',
      'All ACs met.',
      '',
    ]);
  });

  it('replaces an existing Final Summary section', () => {
    const body = ['## Description', '', 'Body.', '', '## Final Summary', '', 'old summary', ''];
    const out = setFinalSummary(body, 'new summary');
    expect(out).toContain('## Final Summary');
    expect(out).toContain('new summary');
    expect(out).not.toContain('old summary');
  });

  it('preserves later sections when replacing Final Summary', () => {
    const body = ['## Description', 'a', '', '## Final Summary', '', 'old', '', '## Notes', 'kept'];
    const out = setFinalSummary(body, 'new');
    expect(out).toEqual([
      '## Description',
      'a',
      '',
      '## Final Summary',
      '',
      'new',
      '',
      '## Notes',
      'kept',
    ]);
  });
});

// ── readFrontmatterScalar ──────────────────────────────────────────────

describe('readFrontmatterScalar', () => {
  const fixture = ['---', 'id: AISDLC-1', 'status: To Do', "title: 'A title'", '---', ''].join(
    '\n',
  );

  it('returns unquoted scalars', () => {
    expect(readFrontmatterScalar(fixture, 'status')).toBe('To Do');
    expect(readFrontmatterScalar(fixture, 'id')).toBe('AISDLC-1');
  });

  it('strips surrounding quotes', () => {
    expect(readFrontmatterScalar(fixture, 'title')).toBe('A title');
  });

  it('returns undefined for missing keys / no frontmatter', () => {
    expect(readFrontmatterScalar(fixture, 'priority')).toBeUndefined();
    expect(readFrontmatterScalar('No frontmatter at all.', 'status')).toBeUndefined();
  });
});

// ── End-to-end applyTaskEdit ───────────────────────────────────────────

describe('applyTaskEdit (end-to-end)', () => {
  const taskFixture = [
    '---',
    'id: AISDLC-99',
    'title: A test task',
    'status: To Do',
    'assignee: []',
    "created_date: '2026-04-26 12:00'",
    "updated_date: '2026-04-26 12:00'",
    'labels:',
    '  - test',
    'dependencies: []',
    'priority: medium',
    'customField: keep-me',
    'nested:',
    '  - level: 1',
    '    name: foo',
    '---',
    '',
    '## Description',
    '',
    'Test description.',
    '',
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    '- [ ] #1 First',
    '- [ ] #2 Second',
    '<!-- AC:END -->',
    '',
  ].join('\n');

  it('preserves customField and nested unknown structures across a full edit (AC #3)', () => {
    const out = applyTaskEdit(taskFixture, {
      status: 'Done',
      updatedDate: '2026-04-27 23:00',
      acceptanceCriteriaCheck: [1, 2],
      finalSummary: 'All ACs met.',
    });
    expect(out).toContain('customField: keep-me');
    expect(out).toContain('nested:');
    expect(out).toContain('  - level: 1');
    expect(out).toContain('    name: foo');
    expect(out).toContain('status: Done');
    expect(out).toContain('- [x] #1 First');
    expect(out).toContain('- [x] #2 Second');
    expect(out).toContain('## Final Summary');
    expect(out).toContain('All ACs met.');
  });

  it('auto-stamps updated_date when other fields change and updatedDate is not set', () => {
    const out = applyTaskEdit(taskFixture, { status: 'In Progress' });
    // Default-on stamping replaces the existing updated_date.
    expect(out).toMatch(/updated_date: '\d{4}-\d{2}-\d{2} \d{2}:\d{2}'/);
    expect(out).not.toContain("updated_date: '2026-04-26 12:00'");
  });

  it('skips updated_date stamping when updatedDate: false', () => {
    const out = applyTaskEdit(taskFixture, { status: 'In Progress', updatedDate: false });
    expect(out).toContain("updated_date: '2026-04-26 12:00'");
  });

  it('is a no-op when no operation is provided', () => {
    expect(applyTaskEdit(taskFixture, {})).toBe(taskFixture);
  });
});
