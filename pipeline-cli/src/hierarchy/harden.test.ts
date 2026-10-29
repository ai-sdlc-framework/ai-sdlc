import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateHierarchyRoster } from '@ai-sdlc/reference';
import { describe, expect, it } from 'vitest';

import { managedSettingsFile } from './preflight.js';
import { reconcileStartingEntries } from './registry.js';
import { readRosterChecked } from './roster.js';
import type { RosterEntry } from './types.js';

const entry = (over: Record<string, unknown> = {}): RosterEntry =>
  ({
    role: 'planner',
    project: 'p',
    name: 'p-planner',
    tmuxSession: 'p-planner',
    tmuxWindow: 'p-planner',
    paneId: '%1',
    pid: 10,
    model: 'opus',
    permissionMode: 'bypassPermissions',
    startedAt: new Date(1000).toISOString(),
    status: 'starting',
    ...over,
  }) as RosterEntry;

describe('roster name pattern (AISDLC-664.5)', () => {
  const doc = (name: string) => ({ schemaVersion: 'v1', sessions: [entry({ name })] });

  it('accepts a session name with an optional numeric suffix', () => {
    for (const n of ['p-planner', 'p-planner-2', 'planner']) {
      expect(validateHierarchyRoster(doc(n)).valid).toBe(true);
    }
  });

  it('rejects names outside the pattern in the schema', () => {
    for (const n of ['', 'P-Planner', 'p planner', 'p\u001b[31m', '-x', 'a;rm', 'a'.repeat(60)]) {
      expect(validateHierarchyRoster(doc(n)).valid).toBe(false);
    }
  });

  it('rejects such a name on read', () => {
    const board = mkdtempSync(path.join(tmpdir(), 'roster-name-'));
    writeFileSync(path.join(board, 'hierarchy.json'), JSON.stringify(doc('Bad Name')));
    const { roster, rejected } = readRosterChecked(board);
    expect(roster.sessions).toHaveLength(0);
    expect(rejected[0]).toMatch(/roster schema/);
  });
});

describe('reconcileStartingEntries', () => {
  it('moves a starting entry to its registry name, pid and running', () => {
    const reg = [{ pid: 77, name: 'p-planner-2', startedAt: 2000, status: 'idle' }];
    const r = reconcileStartingEntries([entry(), entry({ name: 'x', status: 'running' })], reg);
    expect(r.changed).toBe(1);
    expect(r.entries[0]).toMatchObject({ name: 'p-planner-2', pid: 77, status: 'running' });
    expect(r.entries[1]?.name).toBe('x');
  });

  it('leaves an entry alone when the registry does not list it', () => {
    const r = reconcileStartingEntries([entry()], []);
    expect(r.changed).toBe(0);
    expect(r.entries[0]?.status).toBe('starting');
  });

  it('treats an unparseable startedAt as 0', () => {
    const reg = [{ pid: 5, name: 'p-planner', startedAt: 1, status: 'idle' }];
    expect(reconcileStartingEntries([entry({ startedAt: 'nope' })], reg).changed).toBe(1);
  });
});

describe('managedSettingsFile', () => {
  it('names the platform managed settings path', () => {
    expect(managedSettingsFile('darwin')).toContain('/Library/Application Support/ClaudeCode');
    expect(managedSettingsFile('linux')).toBe('/etc/claude-code/managed-settings.json');
    expect(managedSettingsFile('win32')).toContain('managed-settings.json');
    expect(managedSettingsFile()).toContain('managed-settings.json');
  });
});
