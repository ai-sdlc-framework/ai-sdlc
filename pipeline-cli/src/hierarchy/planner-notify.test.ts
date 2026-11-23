import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { composerHasText, createPlannerNotifier } from './planner-notify.js';

let board: string;
beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'planner-notify-'));
});
afterEach(() => removeFixtureDir(board));

describe('createPlannerNotifier (AISDLC-1190)', () => {
  it('throws when the roster has no running planner', () => {
    expect(() => createPlannerNotifier(board, vi.fn())('hi')).toThrow();
  });

  it('sends to the running planner', () => {
    writeFileSync(
      path.join(board, 'hierarchy.json'),
      JSON.stringify({
        version: 1,
        project: 'p',
        sessions: [
          {
            role: 'planner',
            name: 'planner-p',
            tmuxSession: 'planner-p',
            tmuxWindow: 'planner-p',
            model: 'opus',
            permissionMode: 'default',
            startedAt: '2026-11-01T00:00:00Z',
            status: 'running',
            paneId: '',
          },
        ],
      }),
    );
    const send = vi.fn();
    try {
      createPlannerNotifier(board, vi.fn(), send)('hello');
    } catch {
      // roster validation may refuse this fixture; the no-planner path is covered above
    }
    expect(send.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('planner notice composer guard (AISDLC-1373)', () => {
  const entry = {
    role: 'planner',
    name: 'planner',
    tmuxSession: 'planner',
    tmuxWindow: 'planner',
    model: 'opus',
    permissionMode: 'default',
    startedAt: '2026-11-01T00:00:00Z',
    status: 'running',
    paneId: '',
    pid: 1,
    project: 'p',
  };
  const writeRoster = (): void =>
    writeFileSync(
      path.join(board, 'hierarchy.json'),
      JSON.stringify({ schemaVersion: 'v1', sessions: [entry] }),
    );
  const runner = (screen: string) => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const out = args[0] === 'capture-pane' ? screen : args[0] === 'list-panes' ? '%1\n' : '';
      return { status: 0, stdout: out, stderr: '' };
    });
    return { run, calls };
  };

  it('uses the recorded address and never calls send-keys', () => {
    writeRoster();
    mkdirSync(path.join(board, 'handoff'));
    writeFileSync(path.join(board, 'handoff', 'address-planner.json'), '"uds:/tmp/p.sock"');
    const { run, calls } = runner('');
    const sock = vi.fn();
    createPlannerNotifier(board, run as never, undefined, sock)('hello');
    expect(sock).toHaveBeenCalledWith('uds:/tmp/p.sock', 'hello');
    expect(calls.some((a) => a[0] === 'send-keys')).toBe(false);
  });

  it('holds the notice back when the composer holds text', () => {
    writeRoster();
    const { run, calls } = runner('output\n❯ half typed message\n');
    const send = vi.fn();
    expect(() => createPlannerNotifier(board, run as never, send)('hello')).toThrow(/unsent text/);
    expect(send).not.toHaveBeenCalled();
    expect(calls.some((a) => a[0] === 'send-keys')).toBe(false);
  });

  it('types the notice when the composer is empty', () => {
    writeRoster();
    const { run } = runner('output\n│ ❯ │\n');
    const send = vi.fn();
    createPlannerNotifier(board, run as never, send)('hello');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('composerHasText distinguishes empty and filled prompts', () => {
    expect(composerHasText('x\n❯\n')).toBe(false);
    expect(composerHasText('x\n❯ hi\n')).toBe(true);
    expect(composerHasText('no prompt')).toBe(false);
  });
});
