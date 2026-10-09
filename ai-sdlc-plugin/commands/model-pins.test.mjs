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

function listFiles(dir) {
  return readdirSync(join(pluginDir, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ dir, name: f.replace(/\.md$/, ''), path: join(pluginDir, dir, f) }));
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

describe('role pins', () => {
  const haikuCommands = [
    'version',
    'doctor',
    'hierarchy',
    'cleanup',
    'pipeline-status',
    'triage',
    'import-spec',
    'rfc-init',
    'init-signing-key',
    'execute-parallel-status',
    'execute-parallel-cleanup',
  ];
  const sonnetCommands = [
    'execute',
    'orchestrator-tick',
    'dispatch-worker',
    'executor',
    'operator-dispatch',
    'planner',
    'execute-parallel',
    'fix-pr',
    'review-pr',
    'detect-patterns',
    'rebase',
    'resolve-conflicts',
  ];
  const haikuAgents = ['review-executor', 'review-executor-codex'];
  const sonnetAgents = [
    'developer',
    'code-reviewer',
    'test-reviewer',
    'correctness-reviewer',
    'rebase-resolver',
    'ci-conflict-resolver',
    'refinement-reviewer',
    'code-reviewer-codex',
    'test-reviewer-codex',
  ];

  for (const [dir, names, model] of [
    ['commands', haikuCommands, 'haiku'],
    ['commands', sonnetCommands, 'sonnet'],
    ['agents', haikuAgents, 'haiku'],
    ['agents', sonnetAgents, 'sonnet'],
    ['agents', ['security-reviewer'], 'opus'],
  ]) {
    for (const name of names) {
      it(`${dir}/${name}.md pins ${model}`, () => {
        assert.equal(modelOf(dir, name), model);
      });
    }
  }

  it('the role lists cover every command and agent file', () => {
    const covered = new Set([
      ...[...haikuCommands, ...sonnetCommands].map((n) => `commands/${n}`),
      ...[...haikuAgents, ...sonnetAgents, 'security-reviewer'].map((n) => `agents/${n}`),
    ]);
    const missing = files.filter((f) => !covered.has(`${f.dir}/${f.name}`));
    assert.deepEqual(
      missing.map((f) => `${f.dir}/${f.name}`),
      [],
      'add new files to a role list',
    );
  });
});
