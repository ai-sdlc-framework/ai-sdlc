import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'format-on-write.js');
const UGLY = 'const a   =   {b:1}\n';
const PRETTY = 'const a = { b: 1 };\n';

function prettierDir() {
  try {
    return dirname(createRequire(import.meta.url).resolve('prettier/package.json'));
  } catch {
    return null;
  }
}
const PRETTIER = prettierDir();

function project({ config = true, install = true, ignore = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fow-'));
  if (config) writeFileSync(join(dir, '.prettierrc.json'), '{"singleQuote":true}\n');
  if (ignore) writeFileSync(join(dir, '.prettierignore'), ignore);
  if (install && PRETTIER) {
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(PRETTIER, join(dir, 'node_modules', 'prettier'));
  }
  return dir;
}

function run(dir, payload, env = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ cwd: dir, ...payload }),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('formats a file written by Write', { skip: !PRETTIER }, () => {
  const dir = project();
  const f = join(dir, 'x.js');
  writeFileSync(f, UGLY);
  const r = run(dir, { tool_name: 'Write', tool_input: { file_path: f } });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(f, 'utf-8'), PRETTY);
  rmSync(dir, { recursive: true, force: true });
});

test('ignored file is left untouched', { skip: !PRETTIER }, () => {
  const dir = project({ ignore: 'x.js\n' });
  const f = join(dir, 'x.js');
  writeFileSync(f, UGLY);
  const r = run(dir, { tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(f, 'utf-8'), UGLY);
  rmSync(dir, { recursive: true, force: true });
});

test('missing config is a no-op', { skip: !PRETTIER }, () => {
  const dir = project({ config: false });
  const f = join(dir, 'x.js');
  writeFileSync(f, UGLY);
  const r = run(dir, { tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(f, 'utf-8'), UGLY);
  rmSync(dir, { recursive: true, force: true });
});

test('prettier not installed is a no-op', () => {
  const dir = project({ install: false });
  const f = join(dir, 'x.js');
  writeFileSync(f, UGLY);
  const r = run(dir, { tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  rmSync(dir, { recursive: true, force: true });
});

test('missing file is a no-op', () => {
  const dir = project();
  const r = run(dir, { tool_name: 'Write', tool_input: { file_path: join(dir, 'nope.js') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  rmSync(dir, { recursive: true, force: true });
});

test('prettier error logs to stderr and exits 0', { skip: !PRETTIER }, () => {
  const dir = project();
  const f = join(dir, 'bad.js');
  writeFileSync(f, 'const = = ;\n');
  const r = run(dir, { tool_name: 'Edit', tool_input: { file_path: f } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /\[format-on-write\]/);
  assert.equal(readFileSync(f, 'utf-8'), 'const = = ;\n');
  rmSync(dir, { recursive: true, force: true });
});

test('non Edit/Write tool and opt-out are no-ops', { skip: !PRETTIER }, () => {
  const dir = project();
  const f = join(dir, 'x.js');
  writeFileSync(f, UGLY);
  assert.equal(run(dir, { tool_name: 'Read', tool_input: { file_path: f } }).status, 0);
  assert.equal(readFileSync(f, 'utf-8'), UGLY);
  run(
    dir,
    { tool_name: 'Write', tool_input: { file_path: f } },
    { AI_SDLC_SKIP_FORMAT_ON_WRITE: '1' },
  );
  assert.equal(readFileSync(f, 'utf-8'), UGLY);
  rmSync(dir, { recursive: true, force: true });
});

test('garbage stdin exits 0', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf-8' });
  assert.equal(r.status, 0);
});
