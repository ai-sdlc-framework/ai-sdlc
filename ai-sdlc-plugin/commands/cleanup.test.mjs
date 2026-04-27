/**
 * Tests for the /ai-sdlc cleanup slash command definition.
 *
 * Verifies frontmatter shape and the body's two-mode contract (sweep vs
 * force-remove) including the "never delete branches" guardrail.
 *
 * Run with: node --test ai-sdlc-plugin/commands/cleanup.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'cleanup.md');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(cmdFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in cleanup.md');

  frontmatter = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  body = match[2];
});

describe('/ai-sdlc cleanup frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'cleanup');
  });

  it('argument is optional (defaults to merged-PR sweep)', () => {
    assert.match(frontmatter['argument-hint'], /\[/);
  });

  it('only allows Bash + Read (no Task, no MCP — pure local cleanup)', () => {
    assert.equal(frontmatter['allowed-tools'], 'Bash, Read');
  });

  it('inherits model from session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });
});

describe('/ai-sdlc cleanup body contract', () => {
  it('mode 1 (no args): scans .worktrees/ and uses gh pr list', () => {
    assert.match(body, /\.worktrees\//);
    assert.match(body, /gh pr list --head/);
    assert.match(body, /merged/);
  });

  it('mode 1: only removes worktrees whose PR has merged', () => {
    assert.match(body, /git worktree remove --force/);
    assert.match(body, /MERGED_AT/);
  });

  it('mode 2 (with arg): force-removes a specific task worktree', () => {
    assert.match(body, /TASK_ID_LOWER/);
    assert.match(body, /WORKTREE_PATH=".worktrees\/\$TASK_ID_LOWER"/);
  });

  it('NEVER deletes branches automatically (CLAUDE.md governance)', () => {
    assert.match(body, /Never deletes branches/i);
    // Confirm the body suggests the deletion command but does NOT execute it.
    assert.match(body, /NOT done automatically/i);
  });

  it('handles missing .worktrees/ directory gracefully', () => {
    assert.match(body, /No \.worktrees\/ directory/);
  });

  it('removes the .active-task sentinel during sweep (defensive cleanup)', () => {
    assert.match(body, /rm -f \.worktrees\/\.active-task/);
  });
});
