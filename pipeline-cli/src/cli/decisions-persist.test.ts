/**
 * AISDLC-546 — CLI-level pins: add / escalate / answer invoke remote persistence, and an
 * explicit --id already consumed on origin is refused. Hermetic: a local bare repo is origin.
 * `gh` is absent/unauthenticated in this path, so only the branch push is exercised.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDecisionsCli } from './decisions.js';
import { DECISIONS_SYNC_BRANCH } from '../decisions/remote-persist.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

let root: string;
let parent: string;
let savedArgv: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedEnv: Record<string, string | undefined>;

const remoteLedger = (): string => {
  git(parent, 'fetch', '--quiet', 'origin', DECISIONS_SYNC_BRANCH);
  return git(parent, 'show', `origin/${DECISIONS_SYNC_BRANCH}:.ai-sdlc/_decisions/events.jsonl`);
};

beforeEach(() => {
  savedEnv = {
    flag: process.env.AI_SDLC_DECISION_CATALOG,
    off: process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST,
  };
  process.env.AI_SDLC_DECISION_CATALOG = 'experimental';
  delete process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST;
  root = mkdtempSync(join(tmpdir(), 'cli-dec-persist-'));
  const origin = join(root, 'origin.git');
  parent = join(root, 'parent');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, parent);
  git(parent, 'config', 'user.email', 't@t.invalid');
  git(parent, 'config', 'user.name', 't');
  mkdirSync(join(parent, '.ai-sdlc', '_decisions'), { recursive: true });
  writeFileSync(join(parent, 'README.md'), 'x');
  git(parent, 'add', '.');
  git(parent, 'commit', '-m', 'init');
  git(parent, 'push', '-u', 'origin', 'HEAD:main');

  savedArgv = process.argv;
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (savedEnv.flag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = savedEnv.flag;
  if (savedEnv.off !== undefined) process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST = savedEnv.off;
  rmSync(root, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  process.argv = ['node', 'cli-decisions', '--work-dir', parent, ...args];
  await buildDecisionsCli().parseAsync();
}

const ADD = [
  'add',
  '--summary',
  'persist me',
  '--scope',
  'workspace',
  '--option',
  'opt-a:A',
  '--option',
  'opt-b:B',
  '--format',
  'json',
];

describe('cli-decisions remote persistence (AISDLC-546)', () => {
  it('add, escalate and answer each persist to origin', async () => {
    await run(...ADD);
    expect(remoteLedger()).toContain('DEC-0001');

    await run(
      'escalate',
      '--task-id',
      'AISDLC-546',
      '--source-worktree',
      parent,
      '--summary',
      'blocked',
      '--option',
      'x:X',
      '--option',
      'y:Y',
      '--format',
      'json',
    );
    expect(remoteLedger()).toContain('DEC-0002');

    await run('answer', 'DEC-0001', 'opt-b', '--by', 'op@test', '--format', 'json');
    expect(remoteLedger()).toContain('operator-answered');
  });

  it('refuses an explicit --id already consumed on origin', async () => {
    await run(...ADD);
    // simulate a parent reset wiping the local append; origin still holds DEC-0001
    rmSync(join(parent, '.ai-sdlc', '_decisions', 'events.jsonl'), { force: true });
    await expect(run(...ADD, '--id', 'DEC-0001')).rejects.toThrow('process.exit(1)');
  });
});
