import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTimingSpan } from './timing-span.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'timing-span-'));
  file = path.join(dir, 't.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pre-push gate recorder (AC 2)', () => {
  it('prints the clock in ms', () => {
    const out: string[] = [];
    expect(runTimingSpan(['now'], { now: () => 1234, write: (s) => out.push(s) })).toBe(0);
    expect(out).toEqual(['1234\n']);
  });

  it('appends one gate span with duration and exit code', () => {
    expect(runTimingSpan(['gate', 'typecheck', '1000', '1'], { now: () => 4000, file })).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      kind: 'gate',
      name: 'typecheck',
      durationMs: 3000,
      exitCode: 1,
    });
  });

  it('writes nothing and still exits 0 on bad arguments', () => {
    for (const argv of [
      [],
      ['gate'],
      ['gate', 'x', '0', '0'],
      ['gate', 'x', 'nan', '0'],
      ['what'],
    ]) {
      expect(runTimingSpan(argv, { file })).toBe(0);
    }
    expect(existsSync(file)).toBe(false);
    runTimingSpan(['gate', 'x', '5', 'junk'], { now: () => 10, file });
    expect(JSON.parse(readFileSync(file, 'utf8')).exitCode).toBeNull();
  });

  it('records to the default file (off under the test setup)', () => {
    expect(runTimingSpan(['gate', 'x', '5', '0'])).toBe(0);
  });
});
