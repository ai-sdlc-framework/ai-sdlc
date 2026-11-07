/**
 * AISDLC-731: a session rooted in a worktree runs the governance hook from the main
 * checkout (or plugin root), never the worktree copy. Uses the real settings.json command
 * and the real wrapper against a main checkout and a worktree whose copies differ.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const settings = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf-8'));
const command = settings.hooks.PreToolUse[0].hooks[0].command;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

describe('hook resolution from a worktree session (AISDLC-731)', () => {
  let root, main, wt;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'hook-res-'));
    main = join(root, 'main');
    mkdirSync(join(main, 'ai-sdlc-plugin', 'hooks'), { recursive: true });
    copyFileSync(
      join(here, 'enforce-blocked-actions.sh'),
      join(main, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.sh'),
    );
    writeFileSync(
      join(main, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.js'),
      `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, 'main');`,
    );
    git(main, 'init', '-q');
    git(main, 'config', 'user.email', 't@t');
    git(main, 'config', 'user.name', 't');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    wt = join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'task', wt);
    // deliberately modified worktree copies (wrapper and script)
    writeFileSync(
      join(wt, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.js'),
      `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, 'worktree');`,
    );
    writeFileSync(
      join(wt, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.sh'),
      `#!/bin/bash\nnode "$(dirname "$0")/enforce-blocked-actions.js"\n`,
    );
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the registered command runs the main checkout copy, not the worktree copy', () => {
    const r = spawnSync('bash', ['-c', command], {
      cwd: wt,
      env: { ...process.env, CLAUDE_PROJECT_DIR: wt, CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(root, 'ran'), 'utf-8'), 'main');
  });

  it('the wrapper prefers CLAUDE_PLUGIN_ROOT over the main checkout', () => {
    const plugin = join(root, 'plugin');
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(
      join(plugin, 'hooks', 'enforce-blocked-actions.js'),
      `require('fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, 'plugin');`,
    );
    rmSync(join(root, 'ran'), { force: true });
    const r = spawnSync(
      'bash',
      [join(main, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.sh')],
      {
        cwd: wt,
        env: { ...process.env, CLAUDE_PROJECT_DIR: wt, CLAUDE_PLUGIN_ROOT: plugin },
        encoding: 'utf-8',
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(root, 'ran')));
    assert.equal(readFileSync(join(root, 'ran'), 'utf-8'), 'plugin');
  });
});
