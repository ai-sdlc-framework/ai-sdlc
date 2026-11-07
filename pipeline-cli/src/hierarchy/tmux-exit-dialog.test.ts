import { describe, expect, it } from 'vitest';

import { stopSessionWindow } from './down.js';
import { confirmExitDialog } from './tmux.js';
import type { CommandRunner, HierarchyDeps, RosterEntry } from './types.js';

const DIALOG =
  'Background work is running\n 1. Exit and stop tasks\n 2. Move to background\n 3. Stay';

describe('confirmExitDialog (AISDLC-1225)', () => {
  it('chooses "Exit and stop tasks" when the dialog shows', () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_c, a) => {
      calls.push([...a]);
      return { status: 0, stdout: DIALOG, stderr: '' };
    };
    expect(confirmExitDialog(run, '%1')).toBe(true);
    expect(calls[1]).toEqual(['send-keys', '-t', '%1', '1', 'Enter']);
  });

  it('sends nothing when the pane shows no dialog or cannot be read', () => {
    const calls: string[][] = [];
    const quiet: CommandRunner = (_c, a) => {
      calls.push([...a]);
      return { status: 0, stdout: '> prompt', stderr: '' };
    };
    expect(confirmExitDialog(quiet, '%1')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(confirmExitDialog(() => ({ status: 1, stdout: DIALOG, stderr: '' }), '%1')).toBe(false);
  });
});

describe('stopSessionWindow with a live background agent (AISDLC-1225)', () => {
  it('answers the exit dialog before the pane is closed', async () => {
    let open = true;
    const sent: string[] = [];
    const run: CommandRunner = (_c, a) => {
      const v = a[0];
      if (v === 'list-windows') return { status: 0, stdout: open ? 'w\n' : '', stderr: '' };
      if (v === 'show-options') return { status: 0, stdout: '1\n', stderr: '' };
      if (v === 'display-message') return { status: 0, stdout: '%9\n', stderr: '' };
      if (v === 'capture-pane') return { status: 0, stdout: DIALOG, stderr: '' };
      if (v === 'send-keys') {
        sent.push(a.slice(3).join(' '));
        if (a[3] === '1') open = false;
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const entry = { name: 'e', tmuxSession: 's', tmuxWindow: 'w', paneId: '%9' } as RosterEntry;
    const deps = {
      run,
      pollAttempts: 3,
      pollIntervalMs: 0,
      sleep: async () => {},
    } as unknown as HierarchyDeps;
    expect(await stopSessionWindow(entry, deps)).toEqual({ forced: false });
    expect(sent).toEqual(['/exit Enter', '1 Enter']);
  });
});
