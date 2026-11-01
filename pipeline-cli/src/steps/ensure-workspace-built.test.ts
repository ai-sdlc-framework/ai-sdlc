import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import {
  ensureWorkspaceBuilt,
  LAST_BUILD_SHA_FILE,
  REQUIRED_DIST_ENTRY_POINTS,
} from './ensure-workspace-built.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let wt: string;
beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), 'ewb-'));
});
afterEach(() => removeFixtureDir(wt));

const seedDist = () => {
  for (const p of REQUIRED_DIST_ENTRY_POINTS) {
    mkdirSync(dirname(join(wt, p)), { recursive: true });
    writeFileSync(join(wt, p), '');
  }
};
const recordSha = (sha: string) => {
  mkdirSync(join(wt, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(wt, LAST_BUILD_SHA_FILE), `${sha}\n`);
};
const builds = (f: FakeRunner) => f.calls.filter((c) => c.command === 'pnpm');

describe('ensureWorkspaceBuilt (AISDLC-1111)', () => {
  it('builds when a dist entry point is missing even though HEAD did not move', async () => {
    recordSha('aaa');
    const fake = new FakeRunner().on(/rev-parse HEAD/, ok('aaa\n'));
    const r = await ensureWorkspaceBuilt(wt, { runner: fake.toRunner(), changedSince: 'aaa' });
    expect(r).toEqual({ ok: true, built: true });
    expect(builds(fake)[0]?.args).toEqual(['build']);
    expect(readFileSync(join(wt, LAST_BUILD_SHA_FILE), 'utf8').trim()).toBe('aaa');
  });

  it('does not build when HEAD is unmoved and the dist is present', async () => {
    seedDist();
    const fake = new FakeRunner().on(/rev-parse HEAD/, ok('aaa\n'));
    const r = await ensureWorkspaceBuilt(wt, { runner: fake.toRunner(), changedSince: 'aaa' });
    expect(r.built).toBe(false);
    expect(builds(fake)).toHaveLength(0);
  });

  it('builds when HEAD moved since changedSince and records the new sha', async () => {
    seedDist();
    recordSha('old');
    const fake = new FakeRunner().on(/rev-parse HEAD/, ok('bbb\n'));
    const r = await ensureWorkspaceBuilt(wt, { runner: fake.toRunner(), changedSince: 'aaa' });
    expect(r.built).toBe(true);
    expect(readFileSync(join(wt, LAST_BUILD_SHA_FILE), 'utf8').trim()).toBe('bbb');
  });

  it('defaults changedSince to the recorded build sha', async () => {
    seedDist();
    recordSha('bbb');
    const same = await ensureWorkspaceBuilt(wt, {
      runner: new FakeRunner().toRunner(),
      head: 'bbb',
    });
    expect(same.built).toBe(false);
    const moved = await ensureWorkspaceBuilt(wt, {
      runner: new FakeRunner().toRunner(),
      head: 'ccc',
    });
    expect(moved.built).toBe(true);
  });

  it('skips a rebuild when the recorded build already matches HEAD', async () => {
    seedDist();
    recordSha('bbb');
    const fake = new FakeRunner();
    const r = await ensureWorkspaceBuilt(wt, {
      runner: fake.toRunner(),
      head: 'bbb',
      changedSince: 'aaa',
    });
    expect(r.built).toBe(false);
  });

  it('reports a failed build and does not record the sha', async () => {
    const fake = new FakeRunner().on(/^pnpm build/, fail('TS2305 boom'));
    const r = await ensureWorkspaceBuilt(wt, { runner: fake.toRunner(), head: 'ddd' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('TS2305');
    expect(() => readFileSync(join(wt, LAST_BUILD_SHA_FILE))).toThrow();
  });
});
