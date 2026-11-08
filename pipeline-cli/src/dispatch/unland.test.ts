import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retireBlockedManifest, retireFailedVerdict } from './retire-landed.js';
import { UNLAND_LOG, unlandTask } from './unland.js';

const runner =
  (prs: unknown[], status = 0) =>
  () => ({
    status,
    stdout: JSON.stringify(prs),
    stderr: 'boom',
  });

function board() {
  const dir = mkdtempSync(path.join(tmpdir(), 'unland-'));
  mkdirSync(path.join(dir, 'done'), { recursive: true });
  mkdirSync(path.join(dir, 'failed'), { recursive: true });
  return dir;
}

describe('unlandTask', () => {
  it('removes the markers and logs the reason when only a filing PR merged', () => {
    const dir = board();
    for (const n of ['completed', 'verdict', 'manifest'])
      writeFileSync(path.join(dir, 'done', `A-1.${n}.json`), '{}');
    const filing = [
      { number: 5, title: 'chore(docs): file backlog task A-1', headRefName: 'ai-sdlc/update-a-1' },
    ];
    const removed = unlandTask(dir, 'A-1', 'false landing', {
      run: runner(filing),
      cwd: dir,
      withManifest: true,
    });
    expect(removed).toHaveLength(3);
    expect(existsSync(path.join(dir, 'done', 'A-1.completed.json'))).toBe(false);
    expect(readFileSync(path.join(dir, UNLAND_LOG), 'utf-8')).toContain('false landing');
  });

  it('refuses while a merged code PR exists', () => {
    const dir = board();
    const code = [{ number: 9, title: 'feat: x (A-1)', headRefName: 'ai-sdlc/a-1-x' }];
    expect(() => unlandTask(dir, 'A-1', 'r', { run: runner(code), cwd: dir })).toThrow(
      /merged code PR/,
    );
  });

  it('rejects a malformed id and a failing gh', () => {
    const dir = board();
    expect(() => unlandTask(dir, '../x', 'r', { run: runner([]), cwd: dir })).toThrow(/malformed/);
    expect(() => unlandTask(dir, 'A-1', 'r', { run: runner([], 1), cwd: dir })).toThrow(/gh pr/);
  });
});

describe('update filing PR never retires a verdict (AISDLC-1235)', () => {
  it('writes no done/ verdict for a docs-kind update PR', () => {
    const dir = board();
    writeFileSync(
      path.join(dir, 'failed', 'A-1.verdict.json'),
      JSON.stringify({ taskId: 'A-1', outcome: 'failure' }),
    );
    writeFileSync(path.join(dir, 'failed', 'A-1.manifest.json'), '{}');
    mkdirSync(path.join(dir, 'blocked'), { recursive: true });
    writeFileSync(path.join(dir, 'blocked', 'A-1.dispatch.json'), '{}');
    const input = {
      taskId: 'A-1',
      kind: 'docs' as const,
      headBranch: 'ai-sdlc/update-a-1',
      landedAt: new Date().toISOString(),
    };
    expect(retireFailedVerdict(dir, input as never)).toBe(false);
    expect(retireBlockedManifest(dir, input as never)).toBe(false);
    expect(existsSync(path.join(dir, 'done', 'A-1.verdict.json'))).toBe(false);
  });
});
