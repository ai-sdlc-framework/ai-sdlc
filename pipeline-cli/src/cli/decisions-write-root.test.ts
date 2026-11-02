import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// AISDLC-1161: every subcommand that appends a decision event must resolve its write root
// through resolveWriteRoot (via the writeRoot helper), so AISDLC-874 holds for every writer.
describe('decision writers use the write root (AISDLC-1161)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'decisions.ts'), 'utf8');
  const commands = [...src.matchAll(/^ {4}\.command\(\n {6}'([^']+)'/gm)].map((m) => ({
    name: m[1],
    index: m.index,
  }));
  const body = (i: number) =>
    src.slice(commands[i].index, i + 1 < commands.length ? commands[i + 1].index : undefined);

  const writers = commands
    .map((c, i) => ({ name: c.name, text: body(i) }))
    .filter((c) => /recordEvents\(/.test(c.text));

  it('finds the known writing subcommands', () => {
    expect(writers.map((w) => w.name.split(' ')[0]).sort()).toEqual(
      [
        'add',
        'answer',
        'auto-expire',
        'escalate',
        'extend',
        'override',
        'resolve',
        'score-a',
        'score-c',
      ].sort(),
    );
  });

  it.each(writers.map((w) => [w.name, w.text]))('%s resolves workDir via writeRoot', (_n, text) => {
    expect(text).toMatch(/const workDir = writeRoot\(Boolean\(argv\.file\)\);/);
    expect(text).not.toMatch(/appendDecisionEvent\(/);
  });

  it('read-only operator-digest does not route through the write root', () => {
    const digest = commands.findIndex((c) => c.name.startsWith('operator-digest'));
    expect(digest).toBeGreaterThanOrEqual(0);
    expect(body(digest)).not.toMatch(/writeRoot\(/);
    expect(body(digest)).toMatch(/String\(argv\['work-dir'\]\)/);
  });

  it('recordEvents is the only direct appendDecisionEvent caller', () => {
    expect(src.match(/appendDecisionEvent\(/g)).toHaveLength(1);
  });
});
