/**
 * AISDLC-546 — CLI-level pins: add / escalate / answer invoke remote persistence, and an
 * explicit --id already consumed on origin is refused. Hermetic: a local bare repo is origin.
 * `gh` is absent/unauthenticated in this path, so only the branch push is exercised.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDecisionsCli } from './decisions.js';
import { DECISIONS_SYNC_BRANCH } from '../decisions/remote-persist.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

// Every case runs real git (bare origin, clone, pushes, fetches); under machine load that
// exceeds vitest's 5 s default (AISDLC-1057). Explicit budget, assertions unchanged.
const LOAD_TIMEOUT_MS = 60_000;

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
  const ref = `origin/${DECISIONS_SYNC_BRANCH}`;
  const names = git(parent, 'ls-tree', '-r', '--name-only', ref, '--', '.ai-sdlc/_decisions/events')
    .split('\n')
    .filter(Boolean);
  return names.map((n) => git(parent, 'show', `${ref}:${n}`)).join('\n');
};

beforeEach(() => {
  savedEnv = {
    flag: process.env.AI_SDLC_DECISION_CATALOG,
    off: process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST,
    u: process.env.AI_SDLC_UNTRUSTED_RUN,
    g: process.env.GITHUB_ACTIONS,
  };
  delete process.env.AI_SDLC_UNTRUSTED_RUN;
  delete process.env.GITHUB_ACTIONS;
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
}, LOAD_TIMEOUT_MS);

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (savedEnv.flag === undefined) delete process.env.AI_SDLC_DECISION_CATALOG;
  else process.env.AI_SDLC_DECISION_CATALOG = savedEnv.flag;
  if (savedEnv.off !== undefined) process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST = savedEnv.off;
  for (const [k, v] of [
    ['AI_SDLC_UNTRUSTED_RUN', savedEnv.u],
    ['GITHUB_ACTIONS', savedEnv.g],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeFixtureDir(root);
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
  it(
    'add, escalate and answer each persist to origin',
    async () => {
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
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'refuses an explicit --id already consumed on origin',
    async () => {
      await run(...ADD);
      // simulate a parent reset wiping the local append; origin still holds DEC-0001
      removeFixtureDir(join(parent, '.ai-sdlc', '_decisions', 'events'));
      const errs: string[] = [];
      process.stderr.write = ((c: string | Uint8Array) => {
        errs.push(String(c));
        return true;
      }) as typeof process.stderr.write;
      await expect(run(...ADD, '--id', 'DEC-0001')).rejects.toThrow('process.exit(1)');
      expect(errs.join('')).toMatch(/refusing to reuse a consumed decision number/);
    },
    LOAD_TIMEOUT_MS,
  );
});
