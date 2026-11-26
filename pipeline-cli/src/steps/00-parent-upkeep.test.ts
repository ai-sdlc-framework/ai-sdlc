import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertParentClean,
  changedPathsOf,
  parentDirtyMessage,
  PARENT_DIRTY_CAUSE,
  parentUpkeepMode,
  runParentUpkeep,
} from './00-parent-upkeep.js';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';

describe('parentUpkeepMode (AISDLC-981)', () => {
  it('runs inline standalone, asserts under a hierarchy session', () => {
    expect(parentUpkeepMode({})).toBe('inline');
    expect(parentUpkeepMode({ AI_SDLC_HIERARCHY_SESSION: 'alpha' })).toBe('assert');
  });
  it('the flag overrides either way', () => {
    expect(
      parentUpkeepMode({ AI_SDLC_HIERARCHY_SESSION: 'a', AI_SDLC_PARENT_UPKEEP: 'inline' }),
    ).toBe('inline');
    expect(parentUpkeepMode({ AI_SDLC_PARENT_UPKEEP: 'assert' })).toBe('assert');
  });
});

describe('usage ledger is ignored (AISDLC-1166)', () => {
  it('developer-honesty.jsonl is git-ignored so Step 0.5 never sees it as untracked', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const out = execFileSync('git', ['check-ignore', '.ai-sdlc/usage/developer-honesty.jsonl'], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(out.trim()).toBe('.ai-sdlc/usage/developer-honesty.jsonl');
  });
});

describe('runParentUpkeep worktree sweep (AISDLC-1108)', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'upkeep-'));
    mkdirSync(join(dir, '.worktrees', 'gone-1'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git worktree list --porcelain/, ok(`worktree ${join(dir, '.worktrees', 'gone-1')}\n`))
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/gone-1\n'))
      .on(/^git -C .+ rev-parse HEAD/, ok('sha\n'))
      .on(/^git -C .+ status/, ok(''))
      .on(/^git worktree remove/, ok())
      .on(/^gh pr list/, ok(JSON.stringify([{ number: 1, state: 'CLOSED', mergedAt: null }])))
      .on(/^git .*(status|diff|ls-files)/, ok(''))
      .on(/./, ok(''));
    return { dir, fake };
  };
  const run = (dir: string, fake: FakeRunner, skipSweep: boolean) =>
    runParentUpkeep({
      workDir: dir,
      runner: fake.toRunner(),
      pluginScriptsDir: dir,
      exists: () => false,
      skipSweep,
    });

  it('sweeps a closed worktree, logging the disposition', async () => {
    const { dir, fake } = setup();
    try {
      const r = await run(dir, fake, false);
      expect(r.swept).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skipSweep leaves the worktrees alone', async () => {
    const { dir, fake } = setup();
    try {
      const r = await run(dir, fake, true);
      expect(r.swept).toBe(0);
      expect(fake.calls.some((c) => c.args.join(' ').startsWith('worktree remove'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertParentClean with a tracked change (AISDLC-1346)', () => {
  const runnerFor = (status: string) => {
    const r = new FakeRunner();
    r.on(/rev-parse --abbrev-ref/, ok('main\n'));
    r.on(/status --porcelain/, ok(status));
    r.on(/merge-base/, ok(''));
    return r;
  };

  for (const file of ['.ai-sdlc/agent-role.yaml', 'src/a b.ts']) {
    it(`refuses a dirty ${file}, names it, advises a pull request and carries the cause`, async () => {
      const res = await assertParentClean('/p', runnerFor(` M ${file}\n`).toRunner());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toContain(file);
      expect(res.reason).toContain('pull request');
      expect(res.cause).toBe(PARENT_DIRTY_CAUSE);
      expect(PARENT_DIRTY_CAUSE).toBe('parent-dirty');
    });
  }

  it('accepts a clean parent', async () => {
    expect((await assertParentClean('/p', runnerFor('').toRunner())).ok).toBe(true);
  });

  it('parses renames and truncates long lists', () => {
    expect(changedPathsOf('R  a.ts -> b.ts\n M c.ts\n')).toEqual(['b.ts', 'c.ts']);
    const many = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(parentDirtyMessage(many)).toContain('and 2 more');
    expect(parentDirtyMessage([])).toContain('unknown');
  });
});
