/**
 * AISDLC-1326 — every command resolves the plugin root with one identical
 * preamble that never falls back to a folder that does not exist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BLOCK_RE = /^# >>> plugin-root preamble[^\n]*\n[\s\S]*?^# <<< plugin-root preamble$/gm;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, body: readFileSync(join(DIR, f), 'utf8') }))
  .filter((f) => f.body.includes('PLUGIN_SCRIPTS_DIR='));

const blocksOf = (body) => body.match(BLOCK_RE) ?? [];
const preamble = blocksOf(files.find((f) => f.name === 'execute.md').body)[0];

function tmp() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'preamble-')));
}

function run(file, { cwd, home, env = {} }) {
  const script = `${blocksOf(file.body)[0]}\necho "RESOLVED=$PLUGIN_SCRIPTS_DIR"`;
  const e = { PATH: process.env.PATH, HOME: home, ...env };
  return spawnSync('bash', ['-c', script], { cwd, env: e, encoding: 'utf8' });
}

function registry(home, entries) {
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'ai-sdlc@market': entries } }),
  );
}

describe('AISDLC-1326 plugin-root preamble', () => {
  it('covers all ten commands that set PLUGIN_SCRIPTS_DIR', () => {
    assert.ok(files.length >= 10);
    for (const f of files) assert.ok(blocksOf(f.body).length >= 1, f.name);
  });

  it('is identical in every command and block', () => {
    for (const f of files) for (const b of blocksOf(f.body)) assert.equal(b, preamble, f.name);
  });

  it('never uses $(pwd)/ai-sdlc-plugin without an existence test', () => {
    for (const f of files) {
      const outside = f.body.replace(BLOCK_RE, '');
      assert.doesNotMatch(outside, /\$\(pwd\)\/ai-sdlc-plugin/, f.name);
    }
    assert.match(preamble, /\[ -n "\$_c" \] && \[ -d "\$_c" \]/);
  });

  it('exits non-zero naming both variables and the registry file when nothing resolves', () => {
    const cwd = tmp();
    const home = tmp();
    registry(home, [{ scope: 'project', projectPath: '/elsewhere', installPath: '/nope' }]);
    for (const f of files) {
      const r = run(f, { cwd, home });
      assert.notEqual(r.status, 0, f.name);
      const out = r.stdout + r.stderr;
      assert.match(out, /CLAUDE_PLUGIN_DIR/);
      assert.match(out, /CLAUDE_PLUGIN_ROOT/);
      assert.match(out, /installed_plugins\.json/);
      assert.doesNotMatch(out, /RESOLVED=/);
    }
  });

  it('prefers the project entry of an ancestor over the user entry and skips missing paths', () => {
    const root = tmp();
    const cwd = join(root, 'a/b');
    mkdirSync(cwd, { recursive: true });
    const proj = join(tmp(), 'proj-plugin');
    const user = join(tmp(), 'user-plugin');
    mkdirSync(proj);
    mkdirSync(user);
    const home = tmp();
    const missing = { scope: 'project', projectPath: cwd, installPath: join(root, 'gone') };
    registry(home, [
      { scope: 'user', installPath: user },
      missing,
      { scope: 'project', projectPath: root, installPath: proj },
    ]);
    const f = files[0];
    assert.match(run(f, { cwd, home }).stdout, new RegExp(`RESOLVED=${proj}/scripts`));
    registry(home, [{ scope: 'user', installPath: user }, missing]);
    assert.match(run(f, { cwd, home }).stdout, new RegExp(`RESOLVED=${user}/scripts`));
  });

  it('resolves ./ai-sdlc-plugin in the monorepo case', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, 'ai-sdlc-plugin/scripts'), { recursive: true });
    const r = run(files[0], { cwd, home: tmp() });
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`RESOLVED=${cwd}/ai-sdlc-plugin/scripts`));
  });

  it('CLAUDE_PLUGIN_DIR wins in every command, including init and doctor', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, 'ai-sdlc-plugin/scripts'), { recursive: true });
    const win = tmp();
    const other = tmp();
    for (const f of files) {
      const r = run(f, {
        cwd,
        home: tmp(),
        env: { CLAUDE_PLUGIN_DIR: win, CLAUDE_PLUGIN_ROOT: other },
      });
      assert.match(r.stdout, new RegExp(`RESOLVED=${win}/scripts`), f.name);
    }
    assert.ok(files.some((f) => f.name === 'init.md') && files.some((f) => f.name === 'doctor.md'));
  });
});
