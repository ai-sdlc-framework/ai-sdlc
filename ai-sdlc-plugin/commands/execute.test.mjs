/**
 * Tests for the /ai-sdlc execute slash command + the execute-orchestrator
 * subagent it spawns.
 *
 * After AISDLC-82 the Step 0-13 recipe was moved from this command body into
 * the `execute-orchestrator` subagent so the main Claude Code session can fire
 * N orchestrators in parallel from a single message. The slash command is now
 * a thin wrapper that spawns one orchestrator via Task with $ARGUMENTS.
 *
 * Body-contract assertions therefore read from
 * `../agents/execute-orchestrator.md` rather than from `execute.md`. The
 * frontmatter assertions remain on `execute.md` since that is still the
 * user-facing slash command surface.
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
const orchestratorFile = join(__dirname, '..', 'agents', 'execute-orchestrator.md');

let frontmatter;
let cmdBody;
let orchestratorBody;

before(() => {
  const cmdContent = readFileSync(cmdFile, 'utf-8');
  const cmdMatch = cmdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!cmdMatch) throw new Error('No frontmatter in execute.md');

  frontmatter = {};
  for (const line of cmdMatch[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  cmdBody = cmdMatch[2];

  const orchestratorContent = readFileSync(orchestratorFile, 'utf-8');
  const orchestratorMatch = orchestratorContent.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (!orchestratorMatch) throw new Error('No frontmatter in execute-orchestrator.md');
  orchestratorBody = orchestratorMatch[1];
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

  it('allows the Task tool (only tool needed — orchestrator does the rest)', () => {
    assert.match(frontmatter['allowed-tools'], /\bTask\b/);
  });

  it('does NOT itself need backlog MCP tools (orchestrator declares those)', () => {
    // After AISDLC-82 the slash command does no MCP work itself — it just
    // spawns the orchestrator subagent which declares its own MCP tool needs.
    // Keeping the surface narrow makes the parallel-runs design obvious from
    // the frontmatter alone.
    assert.doesNotMatch(
      frontmatter['allowed-tools'],
      /mcp__backlog__task_edit/,
      'slash command should not need task_edit directly — orchestrator handles it',
    );
    assert.doesNotMatch(
      frontmatter['allowed-tools'],
      /mcp__backlog__task_complete/,
      'slash command should not need task_complete directly — orchestrator handles it',
    );
  });
});

describe('/ai-sdlc execute body (thin wrapper)', () => {
  it('mentions spawning the execute-orchestrator subagent', () => {
    assert.match(cmdBody, /execute-orchestrator/);
    assert.match(cmdBody, /subagent_type:\s*execute-orchestrator/);
  });

  it('passes $ARGUMENTS through to the orchestrator', () => {
    assert.match(cmdBody, /\$ARGUMENTS/);
  });

  it('explains the parallel-runs design rationale', () => {
    assert.match(cmdBody, /parallel/i);
    assert.match(cmdBody, /AgentTool/, 'should explain why Task is on the orchestrator only');
  });

  it('documents `/loop` compatibility', () => {
    assert.match(cmdBody, /\/loop/);
  });

  it('explicitly forbids gh pr merge (defense-in-depth)', () => {
    assert.match(cmdBody, /Never runs `gh pr merge`/i);
  });

  it('explicitly forbids git push --force', () => {
    assert.match(cmdBody, /Never runs `git push --force`/i);
  });
});

describe('execute-orchestrator body contract (the moved Step 0-13 recipe)', () => {
  it('walks through worktree creation', () => {
    assert.match(orchestratorBody, /git worktree add/);
    assert.match(orchestratorBody, /\.worktrees\//);
  });

  it('invokes the developer subagent', () => {
    assert.match(orchestratorBody, /subagent_type:\s*developer/i);
  });

  it('PreToolUse hook resolves the active task via per-worktree .active-task sentinel', () => {
    assert.match(orchestratorBody, /\$WORKTREE_PATH\/\.active-task/);
  });

  it('runs all three reviewers in parallel (code, test, security)', () => {
    assert.match(orchestratorBody, /code-reviewer/);
    assert.match(orchestratorBody, /test-reviewer/);
    assert.match(orchestratorBody, /security-reviewer/);
    assert.match(orchestratorBody, /three subagents in parallel/i);
  });

  it('detects Codex availability and emits visible fallback warning', () => {
    assert.match(orchestratorBody, /which codex/);
    assert.match(orchestratorBody, /INDEPENDENCE NOT ENFORCED/);
  });

  it('caps developer iterations at 2 on review failure', () => {
    assert.match(orchestratorBody, /max 2 dev iterations/i);
    assert.match(orchestratorBody, /iteration_count\s*<\s*2/);
  });

  it('escalates instead of aborting after the iteration cap', () => {
    assert.match(orchestratorBody, /\[needs-human-attention\]/);
    assert.match(orchestratorBody, /do NOT abort/);
  });

  it('feeds reviewer findings back into the developer on iteration', () => {
    assert.match(orchestratorBody, /Reviewer feedback \(round N\)/);
  });

  it('marks task Done + runs task_complete BEFORE pushing the PR', () => {
    // The Done flip and file move must land in the same PR as the work,
    // sequenced after reviews approve and before push.
    assert.match(orchestratorBody, /mark task Done.*BEFORE push/i);
    assert.match(orchestratorBody, /mcp__ai-sdlc-plugin__task_complete/);
  });

  it('uses the plugin task_edit (preserves permittedExternalPaths — AISDLC-83)', () => {
    // Upstream mcp__backlog__task_edit silently strips unknown frontmatter
    // keys including permittedExternalPaths. The plugin drop-in preserves
    // them. The orchestrator must call the plugin variants. The body may
    // mention the upstream names in explanatory text (e.g. "not upstream
    // mcp__backlog__task_edit") so we strip those backtick-quoted forms
    // before the negative assertion.
    assert.match(orchestratorBody, /mcp__ai-sdlc-plugin__task_edit/);
    assert.match(orchestratorBody, /mcp__ai-sdlc-plugin__task_complete/);

    // Strip backtick-quoted upstream-name explanations before the regression
    // check so the rationale paragraph doesn't trip the assertion.
    const stripped = orchestratorBody.replace(/`mcp__backlog__task_(edit|complete)`/g, '');
    assert.doesNotMatch(
      stripped,
      /mcp__backlog__task_edit/,
      'must invoke the plugin task_edit, not the upstream (AISDLC-83)',
    );
    assert.doesNotMatch(
      stripped,
      /mcp__backlog__task_complete/,
      'must invoke the plugin task_complete, not the upstream (AISDLC-83)',
    );
  });

  it('skips the Done flip when iteration cap was exceeded', () => {
    assert.match(orchestratorBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('commits the file move as a separate chore commit', () => {
    assert.match(orchestratorBody, /chore: mark.*complete/);
  });

  it('builds finalSummary per CLAUDE.md template', () => {
    assert.match(orchestratorBody, /finalSummary/);
    assert.match(orchestratorBody, /## Summary/);
    assert.match(orchestratorBody, /## Verification/);
  });

  it('creates parallel sibling PRs from filesChangedExternal', () => {
    assert.match(orchestratorBody, /filesChangedExternal/);
    assert.match(orchestratorBody, /sibling for \$TASK_ID/);
    assert.match(orchestratorBody, /git -C "\$SIBLING"/);
  });

  it('skips siblings cleanly when gh auth is unavailable for that repo', () => {
    assert.match(orchestratorBody, /gh auth not configured for that repo/);
  });

  it('does NOT roll back the main PR if a sibling PR creation fails', () => {
    assert.match(orchestratorBody, /do NOT roll back the main PR/);
  });

  it('cross-links sibling PRs back into the main PR body', () => {
    assert.match(orchestratorBody, /Sibling PRs/);
    assert.match(orchestratorBody, /gh pr edit/);
  });

  it('writes the per-worktree .active-task sentinel at Step 4', () => {
    // The PreToolUse hook walks up from the developer subagent's cwd to find
    // <worktree>/.active-task. Per-worktree sentinels are what make parallel
    // runs safe (AISDLC-81).
    assert.match(orchestratorBody, /\$WORKTREE_PATH\/\.active-task/);
    assert.match(orchestratorBody, /echo "\$TASK_ID" > "\$WORKTREE_PATH\/\.active-task"/);
  });

  it('cleans up the per-worktree sentinel at end of run regardless of outcome', () => {
    assert.match(orchestratorBody, /rm -f "\$WORKTREE_PATH\/\.active-task"/);
    assert.match(
      orchestratorBody,
      /whether the run succeeded, failed, was rolled back, or escalated/i,
    );
  });

  it('opens a PR via gh pr create', () => {
    assert.match(orchestratorBody, /gh pr create/);
  });

  it('uses References (not Closes) per backlog convention', () => {
    assert.match(orchestratorBody, /References/);
  });

  it('explicitly forbids gh pr merge', () => {
    assert.match(orchestratorBody, /Never (merge any PR|runs `gh pr merge`)/i);
  });

  it('explicitly forbids git push --force', () => {
    assert.match(orchestratorBody, /Never (force-push|runs `git push --force`)/i);
  });

  it('rolls back task status on developer failure', () => {
    assert.match(orchestratorBody, /revert.*task.*To Do/i);
  });

  it('preserves worktree for inspection on failure', () => {
    assert.match(orchestratorBody, /Worktree preserved/);
  });

  // ── AISDLC-74: review attestation contract ────────────────────────
  // Step 10 must build + sign + write a DSSE envelope BEFORE the chore
  // commit so CI's verify-attestation workflow can verify it on push.

  it('Step 10: refuses to sign when ~/.ai-sdlc/signing-key.pem is missing', () => {
    assert.match(orchestratorBody, /\$HOME\/\.ai-sdlc\/signing-key\.pem/);
    assert.match(orchestratorBody, /\/ai-sdlc init-signing-key/);
  });

  it('Step 10: invokes scripts/sign-attestation.mjs with verdicts + iteration + harness-note', () => {
    assert.match(orchestratorBody, /scripts\/sign-attestation\.mjs/);
    assert.match(orchestratorBody, /--review-verdicts/);
    assert.match(orchestratorBody, /--iteration-count/);
    assert.match(orchestratorBody, /--harness-note/);
  });

  it('Step 10: skips the signing step when iteration cap was exceeded', () => {
    // The chunk that handles attestation must be inside the "reviews approved"
    // branch — the iteration-cap branch does not sign (the PR is
    // [needs-human-attention] and the human owns the close-out).
    assert.match(orchestratorBody, /If reviews approved cleanly:/);
    assert.match(orchestratorBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('Step 10: stages the .ai-sdlc/attestations/ file in the chore commit', () => {
    assert.match(
      orchestratorBody,
      /git add backlog\/tasks backlog\/completed \.ai-sdlc\/attestations/,
    );
  });

  it('Step 10: writes the envelope at .ai-sdlc/attestations/<head-sha>.dsse.json', () => {
    assert.match(orchestratorBody, /\.ai-sdlc\/attestations\/<head-sha>\.dsse\.json/);
  });

  it('Step 10: chore commit message references AISDLC-74 + verify-attestation', () => {
    assert.match(orchestratorBody, /AISDLC-74/);
    assert.match(orchestratorBody, /verify-attestation/);
  });
});
