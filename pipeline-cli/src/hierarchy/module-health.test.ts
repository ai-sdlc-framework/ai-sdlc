import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertDispatchModuleLoaded,
  formatModuleHealth,
  moduleHealthPath,
  readModuleHealth,
} from './module-health.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

const dirs: string[] = [];
function board(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'module-health-'));
  dirs.push(d);
  mkdirSync(path.join(d, 'handoff'));
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date('2026-10-23T12:00:00Z');
const dispatch = { name: 'p-dispatch', role: 'operator-dispatch' } as RosterEntry;
const executor = { name: 'p-exec', role: 'executor' } as RosterEntry;

function write(dir: string, name: string, body: unknown): void {
  writeFileSync(moduleHealthPath(dir, name), JSON.stringify(body));
}

describe('readModuleHealth', () => {
  it('is absent without a file or with an unreadable one', () => {
    const dir = board();
    expect(readModuleHealth(dir, executor, NOW)).toEqual({ state: 'absent' });
    writeFileSync(moduleHealthPath(dir, executor.name), 'not json');
    expect(readModuleHealth(dir, executor, NOW).state).toBe('absent');
    write(dir, executor.name, { state: 'weird' });
    expect(readModuleHealth(dir, executor, NOW).state).toBe('absent');
  });

  it('reports refused with its reason', () => {
    const dir = board();
    write(dir, executor.name, { state: 'refused', reason: 'primitive x is missing', at: NOW });
    const h = readModuleHealth(dir, executor, NOW);
    expect(formatModuleHealth(h)).toBe('refused: primitive x is missing');
  });

  it('reports loaded, and stale for a dispatch heartbeat older than two minutes', () => {
    const dir = board();
    write(dir, executor.name, { state: 'loaded', version: '2.1.0', at: '2026-01-01T00:00:00Z' });
    expect(formatModuleHealth(readModuleHealth(dir, executor, NOW))).toBe('loaded');
    write(dir, dispatch.name, { state: 'loaded', at: NOW.toISOString() });
    expect(readModuleHealth(dir, dispatch, NOW).state).toBe('loaded');
    write(dir, dispatch.name, { state: 'loaded', at: '2026-10-23T11:00:00Z' });
    expect(formatModuleHealth(readModuleHealth(dir, dispatch, NOW))).toMatch(
      /^stale: no heartbeat/,
    );
    write(dir, dispatch.name, { state: 'loaded' });
    expect(readModuleHealth(dir, dispatch, NOW).state).toBe('stale');
  });
});

describe('assertDispatchModuleLoaded', () => {
  const depsFor = (dir: string, sleep = async () => {}): HierarchyDeps =>
    ({ boardDir: dir, now: () => NOW, sleep }) as unknown as HierarchyDeps;

  it('passes when the host is loaded', async () => {
    const dir = board();
    write(dir, dispatch.name, { state: 'loaded', at: NOW.toISOString() });
    await expect(assertDispatchModuleLoaded(depsFor(dir), [dispatch])).resolves.toBeUndefined();
  });

  it('throws naming the refusal and the fix when the host never loads', async () => {
    const dir = board();
    write(dir, dispatch.name, { state: 'refused', reason: 'validator refused' });
    let sleeps = 0;
    await expect(
      assertDispatchModuleLoaded(
        depsFor(dir, async () => void sleeps++),
        [dispatch],
      ),
    ).rejects.toThrow(/p-dispatch MODULE refused: validator refused.*cli-hierarchy down/s);
    expect(sleeps).toBe(12);
  });

  it('treats a missing file as absent', async () => {
    await expect(assertDispatchModuleLoaded(depsFor(board()), [dispatch])).rejects.toThrow(
      /MODULE absent/,
    );
  });

  it('succeeds when the module loads while waiting', async () => {
    const dir = board();
    await expect(
      assertDispatchModuleLoaded(
        depsFor(dir, async () => write(dir, dispatch.name, { state: 'loaded', at: NOW })),
        [dispatch],
      ),
    ).resolves.toBeUndefined();
  });
});

describe('plugin store fallback (AISDLC-1082)', () => {
  it('reads the mirrored store key when the board file is absent, and prefers the board file', () => {
    const b = board();
    const store = board();
    const rec = { state: 'loaded', at: NOW.toISOString() };
    writeFileSync(path.join(store, 'a.json'), 'not json');
    writeFileSync(path.join(store, 'b.json'), JSON.stringify({ 'hierarchy/health/p-exec': rec }));
    writeFileSync(
      path.join(store, 'c.json'),
      JSON.stringify({ store: { 'hierarchy/health/p-dispatch': rec } }),
    );
    expect(readModuleHealth(b, executor, NOW, [store]).state).toBe('loaded');
    expect(readModuleHealth(b, dispatch, NOW, [store]).state).toBe('loaded');
    expect(readModuleHealth(b, { name: 'other', role: 'executor' }, NOW, [store]).state).toBe(
      'absent',
    );
    expect(readModuleHealth(b, executor, NOW, ['/nonexistent-dir']).state).toBe('absent');
    write(b, 'p-exec', { state: 'refused', reason: 'x' });
    expect(readModuleHealth(b, executor, NOW, [store]).state).toBe('refused');
  });
});
