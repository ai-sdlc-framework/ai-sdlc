import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatherFacts, landingPath, readLanding } from './reconcile.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'closed-'));
});
afterEach(() => removeFixtureDir(board));

describe('closed-unlanded landing records', () => {
  it('confirms a closed PR once, then stops re-checking it', () => {
    mkdirSync(path.join(board, 'landing'), { recursive: true });
    writeFileSync(
      landingPath(board, 7),
      JSON.stringify({
        pr: 7,
        kind: 'task',
        owner: 'x',
        state: 'red',
        action: 'none',
        history: [],
      }),
    );
    const views: string[][] = [];
    const run: CommandRunner = (_f, args) => {
      if (args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: 'me\n', stderr: '' };
      views.push([...args]);
      return { status: 0, stdout: '{"state":"CLOSED"}', stderr: '' };
    };
    gatherFacts(run, board, board);
    gatherFacts(run, board, board);
    expect(views).toHaveLength(1);
    expect(readLanding(board, 7)?.closedUnlanded).toBeTruthy();
  });
});
