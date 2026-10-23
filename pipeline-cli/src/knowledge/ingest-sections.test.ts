import { describe, expect, it } from 'vitest';
import { parseEntryFile, validateEntryFields } from './entry.js';
import { sectionsToEntries, slugify, splitSections } from './ingest-sections.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';

const MD = `# Title

intro

## Why the lockstep exists

Three copies change together.

Second paragraph.

## Empty

## Other Section

Body two.
`;

describe('sectionsToEntries (AISDLC-782)', () => {
  it('turns each non-empty section into a valid entry with trunk, source and decay', () => {
    const entries = sectionsToEntries(MD, DEFAULT_ONTOLOGY, {
      source: 'docs/x.md',
      observed: '2026-10-23',
    });
    expect(entries.map((e) => e.path)).toEqual([
      'process/why-the-lockstep-exists.md',
      'process/other-section.md',
    ]);
    const parsed = parseEntryFile(entries[0].text);
    if (!('fields' in parsed)) throw new Error('unparseable');
    expect(validateEntryFields(parsed.fields, DEFAULT_ONTOLOGY)).toEqual([]);
    expect(parsed.fields.trunk).toBe('process');
    expect(parsed.fields.source).toBe('docs/x.md#why-the-lockstep-exists');
    expect(parsed.fields.decay).toBe('durable');
    expect(parsed.fields.value).toBe('Three copies change together.');
    expect(parsed.body).toContain('Second paragraph.');
  });

  it('filters by heading and honours trunk and decay options', () => {
    const entries = sectionsToEntries(MD, DEFAULT_ONTOLOGY, {
      source: 'docs/x.md',
      observed: '2026-10-23',
      headings: ['Other Section'],
      trunk: 'systems',
      decay: 'volatile',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('systems/other-section.md');
    expect(entries[0].text).toContain('decay: volatile');
  });

  it('throws when the ontology rejects the trunk', () => {
    expect(() =>
      sectionsToEntries(MD, DEFAULT_ONTOLOGY, { source: 's.md', observed: 'd', trunk: 'nope' }),
    ).toThrow(/unknown trunk/);
  });

  it('slugifies and splits', () => {
    expect(slugify('A (b) c!')).toBe('a-b-c');
    expect(splitSections(MD).map((s) => s.heading)).toEqual([
      'Why the lockstep exists',
      'Empty',
      'Other Section',
    ]);
  });
});
