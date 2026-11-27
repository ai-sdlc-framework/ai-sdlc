/**
 * AISDLC-1161 — the decisions CLI `--file` flag from the Pattern-C parent (no active task):
 * the event reaches a cli-file branch on origin and nothing lands in the parent's store.
 * Hermetic: a local bare repo is origin; a fake `gh` on PATH records the PRs it "opens"
 * and lists them as open (AISDLC-1388).
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDecisionsCli } from './decisions.js';
import { makeDecisionOpenedEvent, appendDecisionEvent } from '../decisions/event-log.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { withEvidence } from '../__test-helpers/evidence-ledger-fixture.js';

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

// Fake gh: `pr create --head <b>` records an open PR and prints its URL; `pr list` prints them.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const db = process.env.FAKE_GH_DB;
const prs = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : [];
const a = process.argv.slice(2);
fs.appendFileSync(db + '.calls', a.slice(0, 2).join(' ') + '\\n');
if (a[0] === 'pr' && a[1] === 'create') {
  const n = prs.length + 1;
  const url = 'https://github.com/o/r/pull/' + n;
  prs.push({ number: n, url, headRefName: a[a.indexOf('--head') + 1] });
  fs.writeFileSync(db, JSON.stringify(prs));
  console.log(url);
} else if (a[0] === 'pr' && a[1] === 'list') {
  console.log(JSON.stringify(prs));
}
`;
let ghDb: string;
const ghCalls = (): string[] =>
  existsSync(`${ghDb}.calls`)
    ? readFileSync(`${ghDb}.calls`, 'utf8').split('\n').filter(Boolean)
    : [];

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
    path: process.env.PATH,
    db: process.env.FAKE_GH_DB,
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
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  ghDb = join(root, 'gh-prs.json');
  process.env.FAKE_GH_DB = ghDb;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
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
    ['PATH', saved.path],
    ['FAKE_GH_DB', saved.db],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeFixtureDir(root);
});

async function run(...args: string[]): Promise<void> {
  process.argv = ['node', 'cli-decisions', '--work-dir', parent, ...withEvidence(parent, args)];
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
    'AISDLC-1388 AC-1: add --file without --pr is refused and nothing is published',
    async () => {
      await expect(run(...ADD, '--file')).rejects.toThrow('process.exit(1)');
      expect(errs.join('')).toContain(
        'add --file needs --pr: a filing branch without a PR never lands',
      );
      git(parent, 'fetch', 'origin');
      expect(
        git(parent, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/ai-sdlc/'),
      ).toBe('');
      expect(ghCalls()).toEqual([]);
    },
    T,
  );

  it(
    'AC-1: add --file --pr files the event on a cli-file branch and opens its PR, parent store unchanged',
    async () => {
      await run(...ADD, '--file', '--pr');
      expect(ids(join(parent, EVENTS))).toEqual([]);
      git(parent, 'fetch', 'origin');
      expect(remoteFiles(remoteBranch('ai-sdlc/file-dec-0001-add-')).join('\n')).toContain(
        'decision-opened',
      );
      expect(ghCalls()).toEqual(['pr create']);
    },
    T,
  );

  it(
    'AISDLC-1388 AC-2: answer --file while the add PR is open appends to the add branch',
    async () => {
      await run(...ADD, '--file', '--pr');
      git(parent, 'fetch', 'origin');
      const addBranch = remoteBranch('ai-sdlc/file-dec-0001-add-');
      await run('answer', 'DEC-0001', 'opt-b', '--by', 'op@test', '--rationale', 'r', '--file');
      expect(ids(join(parent, EVENTS))).toEqual([]);
      git(parent, 'fetch', 'origin');
      const files = remoteFiles(addBranch).join('\n');
      expect(files).toContain('decision-opened');
      expect(files).toContain('operator-answered');
      expect(
        git(
          parent,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/remotes/origin/ai-sdlc/file-dec-0001-answer-*',
        ),
      ).toBe('');
      // one PR only: the answer rides the open add PR
      expect(ghCalls()).toEqual(['pr create', 'pr list']);
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

      await expect(
        run('answer', 'DEC-0001', 'nope', '--by', 'op@test', '--rationale', 'r', '--file'),
      ).rejects.toThrow(/process.exit|not an option/);
      await run('answer', 'DEC-0001', 'opt-b', '--by', 'op@test', '--rationale', 'r', '--file');
      expect(ids(join(parent, EVENTS))).toEqual([]);
      git(parent, 'fetch', 'origin');
      expect(remoteFiles(remoteBranch('ai-sdlc/file-dec-0001-answer-')).join('\n')).toContain(
        'operator-answered',
      );
      // AISDLC-1388 AC-3: a decision on main never looks for an open filing PR
      expect(ghCalls()).toEqual([]);
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
      await expect(
        run('answer', 'DEC-0001', 'opt-a', '--by', 'op@test', '--rationale', 'r'),
      ).rejects.toThrow('process.exit(1)');
    },
    T,
  );
});
