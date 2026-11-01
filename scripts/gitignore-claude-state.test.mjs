/**
 * AISDLC-1136: the regenerated .claude state and the project .mcp.json are ignored,
 * and the .mcp.json.example template is tracked.
 * Run with: node --test scripts/gitignore-claude-state.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];

const samples = [
  '.claude/memory/project_planner_handoff_2026_10_31.md',
  '.claude/memory/project_planner_handoff_2026_10_31_archive.md',
  '.claude/memory/handoff_ledger_planner.jsonl',
  '.claude/settings.local.json',
  '.claude/transcripts/session.jsonl',
  '.mcp.json',
];

describe('AISDLC-1136 ignore rules', () => {
  for (const p of samples) {
    it(`ignores ${p}`, () => {
      const r = spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: root, env });
      assert.equal(r.status, 0, `${p} is not ignored`);
    });
  }

  it('does not ignore durable memory notes', () => {
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', '.claude/memory/MEMORY.md'], {
      cwd: root,
      env,
    });
    assert.equal(r.status, 1);
  });

  it('tracks .mcp.json.example', () => {
    const out = execFileSync('git', ['ls-files', '--', '.mcp.json.example'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.equal(out.trim(), '.mcp.json.example');
  });
});
