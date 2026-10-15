import { describe, it, expect } from 'vitest';
import { formatEnvelopeJson } from './format-json.js';

describe('formatEnvelopeJson (AISDLC-732)', () => {
  const h = 'a'.repeat(64);

  it('collapses a short single-element array like prettier and keeps long ones expanded', () => {
    const out = formatEnvelopeJson({ proof: [h], pair: [h, h] });
    expect(out).toContain(`"proof": ["${h}"]`);
    expect(out).toContain(`"pair": [\n    "${h}",\n    "${h}"\n  ]`);
    expect(out.endsWith('}\n')).toBe(true);
  });

  it('round-trips arbitrary content', () => {
    const v = { a: [], b: {}, c: [{ d: [h], e: 1 }], f: [[1, 2], [3]] };
    expect(JSON.parse(formatEnvelopeJson(v))).toEqual(v);
  });
});

describe('formatEnvelopeJson key prefix width (AISDLC-916)', () => {
  // `    "appliedReviewers": [..]` sits at indent 2 in a real envelope.
  const build = (flatLen: number) => {
    // flat = `["x…", "y…"]`; pad to the requested total column count of the line.
    const prefix = '    "appliedReviewers": '.length;
    const target = flatLen - prefix; // flat form length
    const fixed = '["", ""]'.length;
    const a = 'a'.repeat(Math.floor((target - fixed) / 2));
    const b = 'b'.repeat(target - fixed - a.length);
    return { reviewScope: { appliedReviewers: [a, b] } };
  };

  it.each([99, 100, 101])('matches prettier at %i columns', async (cols) => {
    const prettier = await import('prettier');
    const v = { x: build(cols) };
    const out = formatEnvelopeJson(v);
    // prettier keeps objects the way the input wrote them, so it must leave our output unchanged.
    expect(await prettier.format(out, { parser: 'json', printWidth: 100 })).toBe(out);
  });
});

describe('formatEnvelopeJson on the envelopes from PR 1571 and 1585 (AISDLC-916)', () => {
  it.each(['envelope-a', 'envelope-b'])('%s matches prettier', async (name) => {
    const { readFileSync } = await import('node:fs');
    const prettier = await import('prettier');
    const v = JSON.parse(
      readFileSync(new URL(`./__fixtures__/${name}.json.txt`, import.meta.url), 'utf8'),
    );
    const out = formatEnvelopeJson(v);
    // prettier keeps objects the way the input wrote them, so it must leave our output unchanged.
    expect(await prettier.format(out, { parser: 'json', printWidth: 100 })).toBe(out);
  });
});
