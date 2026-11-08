/**
 * AISDLC-1161 — the decisions CLI `--file` flag from the Pattern-C parent (no active task):
 * the event reaches a cli-file branch on origin and nothing lands in the parent's store.
 * Hermetic: a local bare repo is origin; no --pr so `gh` is never called.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDecisionsCli } from './decisions.js';
import { makeDecisionOpenedEvent, appendDecisionEvent } from '../decisions/event-log.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const T = 60_000;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

const EVENTS = '.ai-sdlc/_decisions/events';
let root: string;
let origin: string;
let parent: string;
let saved: Record<string, string | undefined>;
let savedArgv: string[];
let savedOut: typeof process.stdout.write;
let savedErr: typeof process.stderr.write;
let savedExit: typeof process.exit;
let errs: string[];

const ids = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const remoteBranch = (prefix: string): string => {
  const found = git(
    parent,
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/remotes/origin/${prefix}*`,
  )
    .split('\n')
    .filter(Boolean);
  expect(found).toHaveLength(1);
  return found[0].replace(/^origin\//, '');
};
const remoteFiles = (branch: string) =>
  git(parent, 'ls-tree', '--name-only', `origin/${branch}:${EVENTS}`).split('\n').filter(Boolean);

beforeEach(() => {
  saved = {
    flag: process.env.AI_SDLC_DECISION_CATALOG,
    task: process.env.AI_SDLC_ACTIVE_TASK_ID,
    nr: process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST,
  };
  process.env.AI_SDLC_DECISION_CATALOG = 'experimental';
  process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST = '1';
  delete process.env.AI_SDLC_ACTIVE_TASK_ID;
  root = mkdtempSync(join(tmpdir(), 'cli-dec-file-'));
  origin = join(root, 'origin.git');
  parent = join(root, 'parent');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, parent);
  git(parent, 'config', 'user.email', 't@t.invalid');
  git(parent, 'config', 'user.name', 't');
  writeFileSync(join(parent, 'README.md'), 'x');
  git(parent, 'add', '.');
  git(parent, 'commit', '-m', 'init');
  git(parent, 'push', '-u', 'origin', 'HEAD:main');
  mkdirSync(join(parent, '.worktrees'), { recursive: true });
  errs = [];
  savedArgv = process.argv;
  savedOut = process.stdout.write.bind(process.stdout);
  savedErr = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    errs.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
}, T);

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedOut;
  process.stderr.write = savedErr;
  process.exit = savedExit;
  for (const [k, v] of [
    ['AI_SDLC_DECISION_CATALOG', saved.flag],
    ['AI_SDLC_ACTIVE_TASK_ID', saved.task],
    ['AI_SDLC_DECISIONS_NO_REMOTE_PERSIST', saved.nr],
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
  's',
  '--scope',
  'workspace',
  '--option',
  'opt-a:A',
  '--option',
  'opt-b:B',
];

describe('decisions CLI --file from the Pattern-C parent (AISDLC-1161)', () => {
  it(
    'AC-3: add without --file is refused and the message names --file',
    async () => {
      await expect(run(...ADD)).rejects.toThrow('process.exit(1)');
      expect(errs.join('')).toMatch(/--file/);
      expect(ids(join(parent, EVENTS))).toEqual([]);
    },
    T,
  );

  it(
    'AC-1: add --file files the event on a cli-file branch, parent store unchanged',
    async () => {
      await run(...ADD, '--file');
      expect(ids(join(parent, EVENTS))).toEqual([]);
      git(parent, 'fetch', 'origin');
      expect(remoteFiles(remoteBranch('ai-sdlc/file-dec-0001-add-')).join('\n')).toContain(
        'decision-opened',
      );
    },
    T,
  );

  it(
    'AC-2: answer --file works when decision-opened is only on origin/main',
    async () => {
      const other = join(root, 'other');
      git(root, 'clone', origin, other);
      git(other, 'config', 'user.email', 't@t.invalid');
      git(other, 'config', 'user.name', 't');
      appendDecisionEvent(
        makeDecisionOpenedEvent({
          decisionId: 'DEC-0001',
          source: 'ad-hoc',
          scope: 'workspace',
          summary: 's',
          options: [
            { id: 'opt-a', description: 'a' },
            { id: 'opt-b', description: 'b' },
          ],
        } as Parameters<typeof makeDecisionOpenedEvent>[0]),
        { workDir: other },
      );
      git(other, 'add', '.');
      git(other, 'commit', '-m', 'open');
      git(other, 'push', 'origin', 'HEAD:main');

      await expect(run('answer', 'DEC-0001', 'nope', '--file')).rejects.toThrow(
        /process.exit|not an option/,
      );
      await run('answer', 'DEC-0001', 'opt-b', '--file');
      expect(ids(join(parent, EVENTS))).toEqual([]);
      git(parent, 'fetch', 'origin');
      expect(remoteFiles(remoteBranch('ai-sdlc/file-dec-0001-answer-')).join('\n')).toContain(
        'operator-answered',
      );
    },
    T,
  );

  it(
    'AISDLC-1165: supersede --file routes through cli-file like answer --file',
    async () => {
      for (const decisionId of ['DEC-0001', 'DEC-0002']) {
        appendDecisionEvent(
          makeDecisionOpenedEvent({
            decisionId,
            source: 'ad-hoc',
            scope: 'workspace',
            summary: 's',
            options: [
              { id: 'opt-a', description: 'a' },
              { id: 'opt-b', description: 'b' },
            ],
          } as Parameters<typeof makeDecisionOpenedEvent>[0]),
          { workDir: parent },
        );
      }
      git(parent, 'add', '.');
      git(parent, 'commit', '-m', 'open');
      git(parent, 'push', 'origin', 'HEAD:main');
      const before = ids(join(parent, EVENTS)).length;
      await run('supersede', 'DEC-0001', '--by', 'DEC-0002', '--reason', 'overruled', '--file');
      expect(ids(join(parent, EVENTS)).length).toBe(before);
      git(parent, 'fetch', 'origin');
      expect(remoteFiles(remoteBranch('ai-sdlc/file-dec-0001-superseded-')).join('\n')).toContain(
        'superseded',
      );
    },
    T,
  );

  it(
    'answer without --file on a decision absent locally still fails',
    async () => {
      await expect(run('answer', 'DEC-0001', 'opt-a')).rejects.toThrow('process.exit(1)');
    },
    T,
  );
});
