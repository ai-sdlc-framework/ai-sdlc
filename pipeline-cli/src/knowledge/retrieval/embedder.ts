import type { Embedder } from './types.js';

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Zero-install default embedder: a hashed bag-of-words (plus character trigrams, so
 * near-spellings match) projected to a fixed width and L2-normalised. Deterministic,
 * offline, and replaceable by any RFC-0019 adapter.
 */
export class HashedEmbedder implements Embedder {
  readonly name = 'local-hashed';
  constructor(readonly dimensions = 256) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of tokenize(text)) {
      const feats = [tok];
      const padded = `#${tok}#`;
      for (let i = 0; i + 3 <= padded.length; i++) feats.push(padded.slice(i, i + 3));
      for (const f of feats) {
        const h = fnv1a(f);
        v[h % this.dimensions] += h & 0x80000000 ? -1 : 1;
      }
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? v : v.map((x) => x / norm);
  }
}
