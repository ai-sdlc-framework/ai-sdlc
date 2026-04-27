/**
 * Tests for the /ai-sdlc execute slash command definition.
 *
 * Verifies frontmatter shape (allowed-tools include the orchestration tools)
 * and that the body documents the contract the orchestrating model needs to
 * follow (worktree creation, developer subagent invocation, governance rules).
 *
 * Run with: node --test ai-sdlc-plugin/commands/execute.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'execute.md');

let frontmatter;
let body;

before(() => {
  const content = readFileSync(cmdFile, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in execute.md');

  frontmatter = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  body = match[2];
});

describe('/ai-sdlc execute frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'execute');
  });

  it('declares an argument hint', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
    assert.match(frontmatter['argument-hint'], /task-id/, 'should reference task-id');
  });

  it('inherits the model from the orchestrating session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });

  it('allows the Task tool (for spawning developer + reviewers as subagents)', () => {
    assert.match(frontmatter['allowed-tools'], /\bTask\b/);
  });

  it('allows Bash (worktree management, git operations, gh)', () => {
    assert.match(frontmatter['allowed-tools'], /\bBash\b/);
  });

  it('allows the backlog task_edit MCP tool (for status flips)', () => {
    assert.match(frontmatter['allowed-tools'], /mcp__backlog__task_edit/);
  });

  it('allows the backlog task_complete MCP tool (file move on Done)', () => {
    assert.match(frontmatter['allowed-tools'], /mcp__backlog__task_complete/);
  });

  it('allows AskUserQuestion (for review-gate decisions)', () => {
    assert.match(frontmatter['allowed-tools'], /AskUserQuestion/);
  });
});

describe('/ai-sdlc execute body contract', () => {
  it('walks through worktree creation', () => {
    assert.match(body, /git worktree add/);
    assert.match(body, /\.worktrees\//);
  });

  it('invokes the developer subagent', () => {
    assert.match(body, /subagent_type:\s*developer/i);
  });

  it('exports AI_SDLC_ACTIVE_TASK_ID for the developer (PreToolUse hook reads it)', () => {
    assert.match(body, /AI_SDLC_ACTIVE_TASK_ID/);
  });

  it('runs all three reviewers in parallel (code, test, security)', () => {
    assert.match(body, /code-reviewer/);
    assert.match(body, /test-reviewer/);
    assert.match(body, /security-reviewer/);
    assert.match(body, /three subagents in parallel/i);
  });

  it('detects Codex availability and emits visible fallback warning', () => {
    assert.match(body, /which codex/);
    assert.match(body, /INDEPENDENCE NOT ENFORCED/);
  });

  it('caps developer iterations at 2 on review failure', () => {
    assert.match(body, /max 2 dev iterations/i);
    assert.match(body, /iteration_count\s*<\s*2/);
  });

  it('escalates instead of aborting after the iteration cap', () => {
    assert.match(body, /\[needs-human-attention\]/);
    assert.match(body, /do NOT abort/);
  });

  it('feeds reviewer findings back into the developer on iteration', () => {
    assert.match(body, /Reviewer feedback \(round N\)/);
  });

  it('marks task Done + runs task_complete BEFORE pushing the PR', () => {
    // The Done flip and file move must land in the same PR as the work,
    // sequenced after reviews approve and before push.
    assert.match(body, /mark task Done.*BEFORE push/i);
    assert.match(body, /mcp__backlog__task_complete/);
  });

  it('skips the Done flip when iteration cap was exceeded', () => {
    assert.match(body, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('commits the file move as a separate chore commit', () => {
    assert.match(body, /chore: mark.*complete/);
  });

  it('builds finalSummary per CLAUDE.md template', () => {
    assert.match(body, /finalSummary/);
    assert.match(body, /## Summary/);
    assert.match(body, /## Verification/);
  });

  it('creates parallel sibling PRs from filesChangedExternal', () => {
    assert.match(body, /filesChangedExternal/);
    assert.match(body, /sibling for \$TASK_ID/);
    assert.match(body, /git -C "\$SIBLING"/);
  });

  it('skips siblings cleanly when gh auth is unavailable for that repo', () => {
    assert.match(body, /gh auth not configured for that repo/);
  });

  it('does NOT roll back the main PR if a sibling PR creation fails', () => {
    assert.match(body, /do NOT roll back the main PR/);
  });

  it('cross-links sibling PRs back into the main PR body', () => {
    assert.match(body, /Sibling PRs/);
    assert.match(body, /gh pr edit/);
  });

  it('opens a PR via gh pr create', () => {
    assert.match(body, /gh pr create/);
  });

  it('uses References (not Closes) per backlog convention', () => {
    assert.match(body, /References/);
  });

  it('explicitly forbids gh pr merge', () => {
    assert.match(body, /Never runs `gh pr merge`/i);
  });

  it('explicitly forbids git push --force', () => {
    assert.match(body, /Never runs `git push --force`/i);
  });

  it('rolls back task status on developer failure', () => {
    assert.match(body, /revert.*task.*To Do/i);
  });

  it('preserves worktree for inspection on failure', () => {
    assert.match(body, /Worktree preserved/);
  });
});
