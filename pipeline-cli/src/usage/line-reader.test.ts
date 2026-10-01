import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_BYTES, readLines } from './line-reader.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'line-reader-'));
  file = join(dir, 't.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function collect(start = 0, extra: Record<string, unknown> = {}) {
  const lines: Array<[string, number, number]> = [];
  const res = readLines(file, {
    start,
    maxBytes: Number.MAX_SAFE_INTEGER,
    onLine: (l, s, e) => {
      lines.push([l, s, e]);
      return true;
    },
    ...extra,
  });
  return { lines, res };
}

describe('readLines', () => {
  it('returns offsets, skips blank lines and leaves a truncated tail unconsumed', () => {
    writeFileSync(file, 'ab\n\ncd\nef');
    const { lines, res } = collect();
    expect(lines).toEqual([
      ['ab', 0, 3],
      ['cd', 4, 7],
    ]);
    expect(res.consumed).toBe(7);
  });

  it('starts mid-file at an offset', () => {
    writeFileSync(file, 'ab\ncd\n');
    expect(collect(3).lines).toEqual([['cd', 3, 6]]);
  });

  it('handles lines spanning chunk boundaries and multibyte characters', () => {
    const a = 'é'.repeat(CHUNK_BYTES / 2 + 10); // crosses the first chunk boundary
    const b = 'z'.repeat(100);
    writeFileSync(file, `${a}\n${b}\n`);
    const { lines } = collect();
    expect(lines.map((l) => l[0])).toEqual([a, b]);
  });

  it('drops an oversize line spanning chunks and counts it once', () => {
    const big = 'x'.repeat(CHUNK_BYTES * 2 + 5);
    writeFileSync(file, `${big}\nok\n`);
    const { lines, res } = collect(0, { maxLineBytes: 1000 });
    expect(lines.map((l) => l[0])).toEqual(['ok']);
    expect(res.oversizeLines).toBe(1);
  });

  it('drops an oversize line that fits in one chunk', () => {
    writeFileSync(file, `${'y'.repeat(50)}\nok\n`);
    const { lines, res } = collect(0, { maxLineBytes: 10 });
    expect(lines.map((l) => l[0])).toEqual(['ok']);
    expect(res.oversizeLines).toBe(1);
  });

  it('stops when the callback returns false and when the byte cap is hit', () => {
    writeFileSync(file, 'a\nb\nc\n');
    const stopped = readLines(file, { start: 0, maxBytes: 1e9, onLine: (l) => l !== 'b' });
    expect(stopped.stoppedEarly).toBe(true);
    expect(stopped.consumed).toBe(4);
    const capped = readLines(file, { start: 0, maxBytes: 2, onLine: () => true });
    expect(capped.stoppedEarly).toBe(true);
  });
});
