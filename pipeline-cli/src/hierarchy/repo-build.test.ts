import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REBUILD_COMMAND, ensureFreshRepoBuild } from './up.js';
import type { HierarchyDeps } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'repo-build-'));
});
afterEach(() => removeFixtureDir(tmp));

function setup(checkResults: number[], buildStatus = 0) {
  mkdirSync(path.join(tmp, 'ai-sdlc-plugin', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'ai-sdlc-plugin', 'scripts', 'resolve-pipeline-cli.sh'), '');
  const calls: string[] = [];
  const logs: string[] = [];
  const deps = {
    cwd: tmp,
    log: (l: string) => logs.push(l),
    run: (f: string, a: readonly string[]) => {
      calls.push(`${f} ${a.join(' ')}`);
      if (f === 'bash') return { status: checkResults.shift() ?? 0, stdout: '', stderr: '' };
      return { status: buildStatus, stdout: '', stderr: 'boom' };
    },
  } as unknown as HierarchyDeps;
  return { deps, calls, logs };
}

describe('ensureFreshRepoBuild (AISDLC-988)', () => {
  it('passes on a fresh build without building', () => {
    const { deps, calls } = setup([0]);
    ensureFreshRepoBuild(deps, false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--strict');
  });

  it('refuses a stale build and names the rebuild command', () => {
    const { deps, calls } = setup([1]);
    expect(() => ensureFreshRepoBuild(deps, false)).toThrow(REBUILD_COMMAND);
    expect(calls.some((c) => c.startsWith('pnpm'))).toBe(false);
  });

  it('rebuilds with --rebuild then passes', () => {
    const { deps, calls } = setup([1, 0]);
    ensureFreshRepoBuild(deps, true);
    expect(calls.filter((c) => c.startsWith('pnpm'))).toEqual([
      'pnpm --filter @ai-sdlc/pipeline-cli build',
    ]);
  });

  it('fails when the rebuild fails', () => {
    const { deps } = setup([1], 1);
    expect(() => ensureFreshRepoBuild(deps, true)).toThrow(/--rebuild failed/);
  });

  it('skips repos without the resolve script', () => {
    const { deps, calls } = setup([1]);
    removeFixtureDir(path.join(tmp, 'ai-sdlc-plugin'));
    ensureFreshRepoBuild(deps, false);
    expect(calls).toEqual([]);
  });
});
