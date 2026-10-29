import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRosterSessionRoles } from './roster-roles.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-roles-'));
  mkdirSync(join(dir, 'board'));
  mkdirSync(join(dir, 'reg'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(name: string, role: string, pid: number) {
  return {
    role,
    name,
    tmuxSession: 'h',
    tmuxWindow: name,
    paneId: '%1',
    pid,
    model: 'opus',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
  };
}

function reg(file: string, pid: number, name: string, sessionId?: string) {
  writeFileSync(join(dir, 'reg', file), JSON.stringify({ pid, name, sessionId }));
}

describe('loadRosterSessionRoles', () => {
  it('maps registry session ids to roster roles by pid, then by name', () => {
    writeFileSync(
      join(dir, 'board', 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [entry('planner', 'planner', 10), entry('exec-a', 'executor', 11)],
      }),
    );
    reg('a.json', 10, 'renamed', 'sid-planner');
    reg('b.json', 99, 'exec-a', 'sid-exec');
    reg('c.json', 12, 'nobody', 'sid-other');
    reg('d.json', 13, 'no-id');
    const roles = loadRosterSessionRoles(join(dir, 'board'), join(dir, 'reg'));
    expect(Object.fromEntries(roles)).toEqual({ 'sid-planner': 'planner', 'sid-exec': 'executor' });
  });

  it('is empty for a missing, empty or invalid roster', () => {
    expect(loadRosterSessionRoles(join(dir, 'board'), join(dir, 'reg')).size).toBe(0);
    writeFileSync(join(dir, 'board', 'hierarchy.json'), 'not json');
    expect(loadRosterSessionRoles(join(dir, 'board'), join(dir, 'reg')).size).toBe(0);
  });
});
