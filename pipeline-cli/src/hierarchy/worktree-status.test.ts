import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SWEEP_STATUS_FILE } from '../steps/00-sweep.js';
import { formatStatus, formatWorktrees, worktreeStatus, type StatusResult } from './status.js';
import type { HierarchyDeps } from './types.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const mk = () => {
  dir = mkdtempSync(join(tmpdir(), 'wt-status-'));
  return { cwd: dir } as HierarchyDeps;
};

describe('worktree status (AISDLC-1108)', () => {
  it('counts directories and reads the last sweep removable count', () => {
    const deps = mk();
    for (const n of ['a', 'b', 'c']) mkdirSync(join(dir, '.worktrees', n), { recursive: true });
    writeFileSync(join(dir, '.worktrees', 'file'), 'x');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(
      join(dir, SWEEP_STATUS_FILE),
      JSON.stringify({ at: 'now', count: 3, removable: 2 }),
    );
    expect(worktreeStatus(deps)).toEqual({ count: 3, removable: 2, ceiling: 40 });
  });

  it('reports zero without a .worktrees directory or with a corrupt record', () => {
    const deps = mk();
    expect(worktreeStatus(deps)).toEqual({ count: 0, removable: 0, ceiling: 40 });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, SWEEP_STATUS_FILE), '{nope');
    expect(worktreeStatus(deps).removable).toBe(0);
  });

  it('prints the count line, and an alarm only above the ceiling', () => {
    expect(formatWorktrees({ count: 40, removable: 1, ceiling: 40 })).toEqual([
      'worktrees: 40 (1 removable)',
    ]);
    const over = formatWorktrees({ count: 41, removable: 5, ceiling: 40 });
    expect(over[0]).toBe('worktrees: 41 (5 removable)');
    expect(over[1]).toContain('ALARM');
    expect(formatWorktrees(undefined)).toEqual([]);
  });

  it('formatStatus includes the line', () => {
    const lines = formatStatus({
      rows: [],
      board: { queued: 0, inflight: 0, done: 0, failed: 0 },
      webhook: { state: 'off', reason: 'no secret' },
      scheduler: { state: 'off' },
      worktrees: { count: 264, removable: 260, ceiling: 40 },
    } as StatusResult);
    expect(lines).toContain('worktrees: 264 (260 removable)');
    expect(lines.some((l) => l.startsWith('ALARM'))).toBe(true);
  });
});
