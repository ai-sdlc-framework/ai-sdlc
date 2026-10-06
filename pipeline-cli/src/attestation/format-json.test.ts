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
