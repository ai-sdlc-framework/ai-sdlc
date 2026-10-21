/**
 * Model-pin contract for every plugin command and agent (AISDLC-761).
 *
 * A command or agent with no `model:` (or `model: inherit`) runs at whatever
 * rate the invoking session uses, so a relay run from an Opus session pays the
 * Opus rate. Every file must pin a model, and the role pins are asserted here.
 *
 * Run with: node --test ai-sdlc-plugin/commands/model-pins.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns the pinned model of a markdown file's frontmatter, or null. */
export function readModel(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find((l) => /^model:/.test(l));
  if (!line) return null;
  return (
    line
      .replace(/^model:\s*/, '')
      .replace(/^["']|["']$/g, '')
      .trim() || null
  );
}

/** Returns a problem description, or null when the model is pinned. */
export function checkModelPin(content) {
  const model = readModel(content);
  if (model === null) return 'has no `model:` in its frontmatter';
  if (model === 'inherit') return 'carries `model: inherit`';
  return null;
}

/** Returns the value of a top-level frontmatter key, or null. */
export function readKey(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return (
    line
      .slice(key.length + 1)
      .replace(/^\s*["']|["']\s*$/g, '')
      .trim() || null
  );
}

/** Automation-ladder contract (AISDLC-884): returns a problem description, or null. */
export function checkRung(content) {
  const rung = readKey(content, 'rung');
  if (rung === null) return 'has no `rung:` in its frontmatter';
  if (!/^[0-4]$/.test(rung)) return `has invalid \`rung: ${rung}\` (expected 0 to 4)`;
  if (rung === '3' && readKey(content, 'bounds') === null) {
    return 'has `rung: 3` but no `bounds:` in its frontmatter';
  }
  return null;
}

function listFiles(dir) {
  return readdirSync(join(pluginDir, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ dir, name: f.replace(/\.md$/, ''), path: join(pluginDir, dir, f) }));
}

/** Role to wildcard-cell model from the routing table text. */
export function parseCells(text) {
  const cells = {};
  let role = null;
  let inCells = false;
  for (const line of text.split('\n')) {
    if (/^ {2}cells:/.test(line)) inCells = true;
    else if (inCells) {
      const r = line.match(/^ {4}([A-Za-z0-9_-]+):\s*$/);
      if (r) role = r[1];
      const m = line.match(/^ {6}'\*':\s*\{\s*model:\s*([A-Za-z0-9._-]+)/);
      if (m && role) cells[role] = m[1];
    }
  }
  return cells;
}

const files = [...listFiles('commands'), ...listFiles('agents')];
const modelOf = (dir, name) => readModel(readFileSync(join(pluginDir, dir, `${name}.md`), 'utf-8'));

describe('checkModelPin (self-test)', () => {
  it('rejects a file with no model', () => {
    assert.match(checkModelPin('---\nname: x\n---\nbody'), /no `model:`/);
  });
  it('rejects a file with no frontmatter', () => {
    assert.match(checkModelPin('body only'), /no `model:`/);
  });
  it('rejects model: inherit', () => {
    assert.match(checkModelPin('---\nname: x\nmodel: inherit\n---\n'), /inherit/);
  });
  it('accepts a pinned model', () => {
    assert.equal(checkModelPin('---\nname: x\nmodel: haiku\n---\n'), null);
  });
});

describe('checkRung (self-test)', () => {
  it('rejects a file with no rung', () => {
    assert.match(checkRung('---\nname: x\n---\n'), /no `rung:`/);
  });
  it('rejects rung 3 without bounds', () => {
    assert.match(checkRung('---\nrung: 3\n---\n'), /no `bounds:`/);
  });
  it('rejects an out-of-range rung', () => {
    assert.match(checkRung('---\nrung: 7\n---\n'), /invalid/);
  });
  it('accepts rung 3 with bounds and rung 4 alone', () => {
    assert.equal(checkRung('---\nrung: 3\nbounds: "x"\n---\n'), null);
    assert.equal(checkRung('---\nrung: 4\n---\n'), null);
  });
});

describe('every command and agent declares a rung', () => {
  for (const f of files) {
    it(`${f.dir}/${f.name}.md declares rung (and bounds for rung 3)`, () => {
      const problem = checkRung(readFileSync(f.path, 'utf-8'));
      assert.equal(problem, null, `${f.dir}/${f.name}.md ${problem}`);
    });
  }
});

describe('every command and agent pins a model', () => {
  it('finds commands and agents to check', () => {
    assert.ok(files.length > 20);
  });
  for (const f of files) {
    it(`${f.dir}/${f.name}.md pins a non-inherit model`, () => {
      const problem = checkModelPin(readFileSync(f.path, 'utf-8'));
      assert.equal(problem, null, `${f.dir}/${f.name}.md ${problem}`);
    });
  }
});

describe('role pins equal .ai-sdlc/model-routing.yaml (AISDLC-982)', () => {
  const tablePath = join(pluginDir, '..', '.ai-sdlc', 'model-routing.yaml');
  const cells = parseCells(readFileSync(tablePath, 'utf-8'));

  it('the table has cells', () => {
    assert.ok(Object.keys(cells).length > 20);
  });

  for (const f of files) {
    it(`${f.dir}/${f.name}.md pins the model of its cell`, () => {
      const cell = cells[f.name];
      assert.ok(cell, `${f.dir}/${f.name}.md has no cell in .ai-sdlc/model-routing.yaml`);
      assert.equal(modelOf(f.dir, f.name), cell);
    });
  }

  it('every cell names an existing agent or command', () => {
    const names = new Set(files.map((f) => f.name));
    const stray = Object.keys(cells).filter((n) => !names.has(n));
    assert.deepEqual(stray, [], 'remove cells with no agent or command file');
  });

  it('parseCells reads the wildcard cell of each role', () => {
    const text =
      "  cells:\n    a:\n      '*': { model: haiku }\n    b:\n      '*': { model: opus }\n";
    assert.deepEqual(parseCells(text), { a: 'haiku', b: 'opus' });
  });
});
