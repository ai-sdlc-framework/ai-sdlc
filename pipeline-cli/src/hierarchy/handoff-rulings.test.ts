import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeManifest } from '../dispatch/board.js';
import { setRuling } from '../dispatch/ruling.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { readHandoff, writeHandoff } from './handoff.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let repo: string;
let board: string;
const NOW = () => new Date('2026-10-09T12:00:00.000Z');

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'handoff-rulings-'));
  board = path.join(repo, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  const m: DispatchManifest = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-1',
    branch: 'ai-sdlc/aisdlc-1',
    worktree: '.worktrees/aisdlc-1',
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-10-09T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
  };
  writeManifest(board, m);
});
afterEach(() => removeFixtureDir(repo));

describe('Rulings in force (AISDLC-903)', () => {
  it('renders an empty section, then every ruling; read regenerates on a new ruling', () => {
    const opts = {
      role: 'operator-dispatch' as const,
      name: 'p-dispatch',
      boardDir: board,
      now: NOW,
    };
    expect(writeHandoff(opts).content).toMatch(/## Rulings in force\n- \(none\)/);
    setRuling(board, 'AISDLC-1', {
      text: 'hold for AISDLC-9',
      until: 'AISDLC-9',
      by: 'planner',
      now: NOW,
    });
    const r = readHandoff(opts);
    expect(r.regenerated).toBe(true);
    expect(r.content).toContain(
      '- AISDLC-1: hold for AISDLC-9 (until: AISDLC-9; by: planner; at: 2026-10-09T12:00:00.000Z)',
    );
  });
});
