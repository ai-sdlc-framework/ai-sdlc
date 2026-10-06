import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, hasTaskFile, titleTaskIds, touchesBacklogTask } from './issue-link-decision.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'issue-link-decision.mjs');
const BASE = [
  'backlog/tasks/aisdlc-100 - some task.md',
  'backlog/completed/aisdlc-9 - done task.md',
];

describe('decide: linked issue and bypass (unchanged behaviour)', () => {
  it('Closes #N passes naming the issue rule', () => {
    const r = decide({ title: 'fix', body: 'Closes #5' });
    assert.deepEqual([r.state, r.rule], ['success', 'issue']);
    assert.match(r.description, /linked issue/);
  });
  it('References AISDLC-N in the body passes', () => {
    assert.equal(decide({ title: 'fix', body: 'References AISDLC-477' }).rule, 'issue');
  });
  it('bypass label passes and wins over everything else', () => {
    const r = decide({ title: 'x', body: 'Closes #1', labels: ['CI:No-Issue-Required'] });
    assert.deepEqual([r.state, r.rule], ['success', 'bypass']);
    assert.match(r.description, /bypass/);
  });
});

describe('decide: backlog task by diff', () => {
  it('a PR that only adds a file under backlog/tasks/ passes naming the backlog-task rule', () => {
    const r = decide({ title: 'docs: file task', changedFiles: ['backlog/tasks/aisdlc-5 - x.md'] });
    assert.deepEqual([r.state, r.rule], ['success', 'backlog-task']);
    assert.match(r.description, /backlog task/);
  });
  it('a file moved to backlog/completed/ passes', () => {
    const r = decide({
      title: 'feat: y',
      changedFiles: ['src/a.ts', 'backlog/completed/aisdlc-5 - x.md'],
    });
    assert.equal(r.rule, 'backlog-task');
  });
  it('a directory-only look-alike path does not count', () => {
    assert.equal(touchesBacklogTask(['backlog/tasks/']), false);
    assert.equal(touchesBacklogTask(['docs/backlog/tasks/x.md', 'backlog/config.yml']), false);
  });
});

describe('decide: backlog task by title id', () => {
  it('title carrying an existing task id (base ref) passes', () => {
    const r = decide({ title: 'fix: thing (AISDLC-100)', baseTaskFiles: BASE });
    assert.deepEqual([r.state, r.rule], ['success', 'backlog-task']);
    assert.match(r.description, /AISDLC-100/);
  });
  it('title id matching a task file added in the PR passes (head ref)', () => {
    const r = decide({
      title: 'fix: thing (AISDLC-7.2)',
      changedFiles: ['backlog/tasks/aisdlc-7.2 - sub.md'],
    });
    assert.equal(r.state, 'success');
  });
  it('title carrying an id with no task file fails', () => {
    const r = decide({ title: 'fix: thing (AISDLC-99999)', baseTaskFiles: BASE });
    assert.equal(r.state, 'failure');
  });
  it('an id that is only a prefix of another does not match', () => {
    assert.equal(hasTaskFile(BASE, 'AISDLC-10'), false);
    assert.equal(hasTaskFile(BASE, 'AISDLC-100'), true);
  });
  it('an id outside parentheses is not the commit-convention form', () => {
    assert.deepEqual(titleTaskIds('fix AISDLC-100 thing'), []);
    assert.deepEqual(titleTaskIds('a (AISDLC-1) b (LT-22.3)'), ['AISDLC-1', 'LT-22.3']);
    assert.equal(decide({ title: 'fix AISDLC-100 thing', baseTaskFiles: BASE }).state, 'failure');
  });
});

describe('decide: none of the rules', () => {
  it('fails with the existing pointer', () => {
    const r = decide({
      title: 'fix',
      body: 'Related to #123',
      labels: ['bug'],
      changedFiles: ['src/a.ts'],
    });
    assert.deepEqual([r.state, r.rule], ['failure', 'none']);
    assert.match(r.description, /Closes\/Fixes\/Resolves #N/);
  });
});

describe('CLI: PR text is data, never shell', () => {
  const run = (env, root) =>
    JSON.parse(
      execFileSync('node', [SCRIPT], {
        env: { PATH: process.env.PATH, BASE_ROOT: root, ...env },
        encoding: 'utf8',
      }),
    );

  it('title and body full of shell metacharacters pass through unexecuted', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-link-'));
    try {
      const marker = join(root, 'pwned');
      mkdirSync(join(root, 'backlog/tasks'), { recursive: true });
      writeFileSync(join(root, 'backlog/tasks/aisdlc-100 - t.md'), '');
      const evil = `$(touch ${marker}) \`touch ${marker}\` ; rm -rf / " ' (AISDLC-100) \${IFS}`;
      const r = run({ PR_TITLE: evil, PR_BODY: evil, PR_LABELS: '[]', PR_FILES: '' }, root);
      assert.deepEqual([r.state, r.rule], ['success', 'backlog-task']);
      assert.throws(() => execFileSync('test', ['-e', marker]), 'metacharacters must not execute');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('metacharacters with no task anywhere still fail, with the contributing URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-link-'));
    try {
      const r = run(
        {
          PR_TITLE: '"; echo hi #',
          PR_BODY: '$(id)',
          PR_LABELS: '["bug"]',
          PR_FILES: 'src/a.ts\n',
        },
        root,
      );
      assert.equal(r.state, 'failure');
      assert.match(r.targetUrl, /CONTRIBUTING\.md#issue-first-workflow/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('newline-separated PR_FILES with a backlog path passes', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue-link-'));
    try {
      const r = run(
        {
          PR_TITLE: 't',
          PR_BODY: '',
          PR_LABELS: '[]',
          PR_FILES: 'a.ts\nbacklog/tasks/aisdlc-1 - x.md\n',
        },
        root,
      );
      assert.equal(r.rule, 'backlog-task');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
