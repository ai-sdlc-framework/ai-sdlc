import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderBriefBlock } from './brief-format.js';
import { briefStatus, formatBriefStatus } from './brief-status.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function board(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'brief-status-'));
  dirs.push(d);
  mkdirSync(path.join(d, 'briefs'), { recursive: true });
  mkdirSync(path.join(d, 'done'), { recursive: true });
  return d;
}

describe('briefStatus', () => {
  it('returns nothing and prints the empty line without a briefs directory', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'brief-status-'));
    dirs.push(d);
    expect(briefStatus(d)).toEqual([]);
    expect(formatBriefStatus([])).toEqual(['No briefs yet.']);
  });

  it('counts tasks with a done verdict', () => {
    const d = board();
    const block = renderBriefBlock([
      { task: 'AISDLC-1', after: [], wave: 1 },
      { task: 'AISDLC-2', after: [], wave: 1 },
    ]);
    writeFileSync(path.join(d, 'briefs', 'a.md'), `# a\n\n${block}\n`);
    writeFileSync(path.join(d, 'briefs', 'note.txt'), 'ignored');
    writeFileSync(path.join(d, 'done', 'AISDLC-1.verdict.json'), '{}');
    const rows = briefStatus(d);
    expect(rows).toEqual([{ file: 'a.md', done: 1, total: 2 }]);
    expect(formatBriefStatus(rows)).toEqual(['a.md: 1 of 2 task(s) done']);
  });

  it('reports an unreadable brief instead of throwing', () => {
    const d = board();
    writeFileSync(path.join(d, 'briefs', 'bad.md'), 'no block here');
    const rows = briefStatus(d);
    expect(rows[0]?.error).toMatch(/dispatchBrief/);
    expect(formatBriefStatus(rows)[0]).toMatch(/^bad\.md: unreadable/);
  });
});
