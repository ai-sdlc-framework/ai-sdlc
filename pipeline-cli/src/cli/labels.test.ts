import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLabelsCli } from './labels.js';

function setup(): { root: string; art: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'cli-labels-'));
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  mkdirSync(join(root, 'art', '_routing'), { recursive: true });
  writeFileSync(
    join(root, 'backlog', 'completed', 'T-1 - a.md'),
    '---\nid: T-1\nstatus: Done\nlabels:\n  - bug\n---\n',
  );
  const log = join(root, 'art', '_routing', 'assignments.jsonl');
  writeFileSync(
    log,
    JSON.stringify({ taskId: 'T-1', role: 'developer', taskClass: 'uncategorized' }) + '\n',
  );
  return { root, art: join(root, 'art'), log };
}

describe('cli-labels', () => {
  afterEach(() => vi.restoreAllMocks());

  it('extract prints a header and a row, or writes to --out', async () => {
    const { root } = setup();
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runLabelsCli(['extract', '--repo-root', root]);
    const text = w.mock.calls.map((c) => String(c[0])).join('');
    expect(text.trim().split('\n')).toHaveLength(2);
    const out = join(root, 'o.jsonl');
    await runLabelsCli(['extract', '--repo-root', root, '--out', out]);
    expect(readFileSync(out, 'utf8')).toContain('"taskId":"T-1"');
  });

  it('backfill-class rewrites and reports', async () => {
    const { root, art, log } = setup();
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runLabelsCli([
      'backfill-class',
      '--repo-root',
      root,
      '--artifacts-dir',
      art,
      '--dry-run',
    ]);
    expect(w.mock.calls.join('')).toContain('Would rewrite 1 of 1');
    await runLabelsCli(['backfill-class', '--repo-root', root, '--artifacts-dir', art]);
    expect(readFileSync(log, 'utf8')).toContain('"taskClass":"bug"');
    writeFileSync(log, JSON.stringify({ taskId: 'T-9', taskClass: 'uncategorized' }) + '\n');
    await runLabelsCli(['backfill-class', '--repo-root', root, '--artifacts-dir', art]);
    expect(w.mock.calls.join('')).toContain('task file not found');
  });
});
