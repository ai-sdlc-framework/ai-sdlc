import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvEscape } from './csv.js';

function parseCsvCell(cell: string): string {
  return cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
}

describe('csvEscape', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd'])('neutralises a leading formula char in %s', (v) => {
    const out = csvEscape(v);
    expect(out.startsWith("'")).toBe(true);
    expect(parseCsvCell(out)).toBe(`'${v}`);
  });

  it('round-trips ordinary cells unchanged', () => {
    for (const v of ['plain', 'a,b', 'say "hi"', 'x\ny', '1.25', 'a=b', '']) {
      expect(parseCsvCell(csvEscape(v))).toBe(v);
    }
  });

  it('prefixes before quoting a cell that also needs quotes', () => {
    expect(csvEscape('=a,b')).toBe(`"'=a,b"`);
  });
});

describe('README usage event list', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const emitted = new Set<string>();
  for (const f of readdirSync(here)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    for (const m of readFileSync(join(here, f), 'utf8').matchAll(/type: '([A-Z][A-Za-z]+)'/g)) {
      emitted.add(m[1]!);
    }
  }

  it('matches the events the usage code emits', () => {
    const readme = readFileSync(join(here, '..', '..', 'README.md'), 'utf8');
    const para = readme.split('\n').find((l) => l.startsWith('**Calibration.**')) ?? '';
    const documented = new Set(
      [...para.matchAll(/`([A-Z][a-z]+(?:[A-Z][a-z]+)+)`/g)].map((m) => m[1]!),
    );
    expect([...documented].sort()).toEqual([...emitted].sort());
    expect(emitted.size).toBeGreaterThan(0);
  });
});
