/**
 * Tests for the /ai-sdlc execute slash command.
 *
 * AISDLC-98 reverted AISDLC-82: the Step 0-13 recipe used to live in this
 * command body, briefly moved into an `execute-orchestrator` subagent, and
 * has now moved BACK into the slash command body. The orchestrator design
 * is unimplementable on the current Claude Code harness — plugin subagents
 * cannot use the `Agent` tool (the harness filters it out one level deep
 * regardless of frontmatter). The slash command body, by contrast, runs in
 * the main Claude Code session which DOES have the `Agent` tool, so it
 * can spawn the developer + 3 reviewers directly without a middleman.
 *
 * Body-contract assertions therefore read from `execute.md` itself.
 *
 * Run with: node --test ai-sdlc-plugin/commands/execute.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmdFile = join(__dirname, 'execute.md');
const orchestratorFile = join(__dirname, '..', 'agents', 'execute-orchestrator.md');

let frontmatter;
let cmdBody;

before(() => {
  const cmdContent = readFileSync(cmdFile, 'utf-8');
  const cmdMatch = cmdContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!cmdMatch) throw new Error('No frontmatter in execute.md');

  // Frontmatter parser supports both scalar (`key: value`) and list
  // (`key:` followed by `  - item` lines) forms — the Step 0-13 frontmatter
  // declares `allowed-tools` as a list now that there are multiple grants.
  frontmatter = {};
  let currentKey = null;
  for (const line of cmdMatch[1].split('\n')) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = [];
      }
      frontmatter[currentKey].push(listMatch[1].trim());
      continue;
    }
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value) frontmatter[key] = value;
      currentKey = key;
    }
  }
  cmdBody = cmdMatch[2];
});

describe('AISDLC-98: execute-orchestrator subagent removed', () => {
  it('ai-sdlc-plugin/agents/execute-orchestrator.md no longer exists', () => {
    // The orchestrator file was deleted as part of reverting AISDLC-82.
    // The Step 0-13 recipe lives inline in commands/execute.md instead.
    assert.equal(
      existsSync(orchestratorFile),
      false,
      'execute-orchestrator.md must be deleted (reverted in AISDLC-98 because plugin subagents cannot use the Agent tool)',
    );
  });
});

describe('/ai-sdlc execute frontmatter', () => {
  it('declares the command name', () => {
    assert.equal(frontmatter.name, 'execute');
  });

  it('declares an argument hint', () => {
    assert.ok(frontmatter['argument-hint'], 'argument-hint should be present');
    assert.match(frontmatter['argument-hint'], /task-id/, 'should reference task-id');
  });

  it('inherits the model from the spawning session', () => {
    assert.equal(frontmatter.model, 'inherit');
  });

  it('declares Agent(<allowlist>) restricted to the four spawnable subagents (AISDLC-98)', () => {
    // The slash command body runs in the main session and spawns the
    // developer + 3 reviewer subagents directly — no orchestrator
    // middleman (AISDLC-82's design did not work because plugin subagents
    // cannot use the Agent tool). The allowlist form both grants the
    // tool and restricts which subagent types may be spawned.
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be a list');
    const agentDecl = tools.find((t) => t.startsWith('Agent('));
    assert.ok(
      agentDecl,
      'execute.md must declare Agent(<allowlist>) form to spawn developer + 3 reviewer subagents',
    );
    assert.match(agentDecl, /\bdeveloper\b/, 'allowlist must include developer');
    assert.match(agentDecl, /\bcode-reviewer\b/, 'allowlist must include code-reviewer');
    assert.match(agentDecl, /\btest-reviewer\b/, 'allowlist must include test-reviewer');
    assert.match(agentDecl, /\bsecurity-reviewer\b/, 'allowlist must include security-reviewer');
  });

  it('does NOT regress to Agent(execute-orchestrator) (the deleted middleman)', () => {
    // Negative regression guard: the AISDLC-82 design's `Agent(execute-orchestrator)`
    // grant cannot resurface — the orchestrator agent itself is gone.
    const tools = frontmatter['allowed-tools'];
    const flat = Array.isArray(tools) ? tools.join(' ') : tools;
    assert.doesNotMatch(
      flat,
      /Agent\(execute-orchestrator\)/,
      'must not declare the deleted execute-orchestrator subagent (AISDLC-98 revert)',
    );
  });

  it('does NOT declare the legacy bare Task tool (renamed to Agent in v2.1.63)', () => {
    const tools = frontmatter['allowed-tools'];
    const flat = Array.isArray(tools) ? tools.join(' ') : tools;
    assert.doesNotMatch(
      flat,
      /\bTask\b/,
      'must not regress to legacy bare Task entry — use Agent(<allowlist>) instead',
    );
  });

  it('declares the plugin task_edit + task_complete tools (AISDLC-83 namespace)', () => {
    // The pipeline calls these directly from the slash command body now
    // that there's no middleman. Plugin-supplied MCP tools use the
    // `mcp__plugin_<plugin>_<server>__<tool>` namespace.
    const tools = frontmatter['allowed-tools'];
    assert.ok(Array.isArray(tools), 'allowed-tools must be a list');
    assert.ok(
      tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_edit'),
      'execute.md needs the plugin variant of task_edit (preserves permittedExternalPaths — AISDLC-83)',
    );
    assert.ok(
      tools.includes('mcp__plugin_ai-sdlc_ai-sdlc__task_complete'),
      'execute.md needs the plugin variant of task_complete (preserves permittedExternalPaths — AISDLC-83)',
    );
  });

  it('does NOT declare the legacy mcp__ai-sdlc-plugin__* namespace', () => {
    // Negative assertion: the pre-AISDLC-90 namespace would silently
    // drop tool grants. Make sure it never resurfaces.
    const tools = frontmatter['allowed-tools'];
    const list = Array.isArray(tools) ? tools : [tools];
    for (const tool of list) {
      assert.ok(
        !tool.startsWith('mcp__ai-sdlc-plugin__'),
        `must NOT declare legacy mcp__ai-sdlc-plugin__* namespace; found '${tool}'`,
      );
    }
  });
});

describe('/ai-sdlc execute body — pipeline lives inline (AISDLC-98)', () => {
  it('explains why the pipeline is inline (plugin subagents cannot use Agent)', () => {
    // The body must teach future readers the harness limitation that
    // forced the AISDLC-82 revert — otherwise someone will try to
    // resurrect the orchestrator pattern.
    assert.match(cmdBody, /Plugin subagents cannot use the `Agent` tool/i);
    assert.match(cmdBody, /AISDLC-98/);
  });

  it('does NOT reference an execute-orchestrator subagent in the spawning logic', () => {
    // The body may mention the deleted orchestrator in the historical
    // rationale paragraph (it teaches readers why the revert happened),
    // but it MUST NOT contain an actual `subagent_type: execute-orchestrator`
    // call site — that would fail at runtime because the agent is gone.
    assert.doesNotMatch(
      cmdBody,
      /subagent_type:\s*execute-orchestrator/,
      'must not spawn the deleted execute-orchestrator subagent',
    );
  });

  it('passes $ARGUMENTS through (the task ID input)', () => {
    assert.match(cmdBody, /\$ARGUMENTS/);
  });

  it('documents `/loop` compatibility', () => {
    assert.match(cmdBody, /\/loop/);
  });

  it('explains the parallel-runs design rationale', () => {
    assert.match(cmdBody, /parallel/i);
  });

  // ── Step 0-13 body contract (the moved-back recipe) ──────────────────
  it('walks through worktree creation', () => {
    assert.match(cmdBody, /git worktree add/);
    assert.match(cmdBody, /\.worktrees\//);
  });

  it('invokes the developer subagent', () => {
    assert.match(cmdBody, /subagent_type:\s*developer/i);
  });

  it('PreToolUse hook resolves the active task via per-worktree .active-task sentinel', () => {
    assert.match(cmdBody, /\$WORKTREE_PATH\/\.active-task/);
  });

  it('runs all three reviewers in parallel (code, test, security)', () => {
    assert.match(cmdBody, /code-reviewer/);
    assert.match(cmdBody, /test-reviewer/);
    assert.match(cmdBody, /security-reviewer/);
    assert.match(cmdBody, /three subagents in parallel/i);
  });

  it('detects Codex availability and emits visible fallback warning', () => {
    assert.match(cmdBody, /which codex/);
    assert.match(cmdBody, /INDEPENDENCE NOT ENFORCED/);
  });

  it('caps developer iterations at 2 on review failure', () => {
    assert.match(cmdBody, /max 2 dev iterations/i);
    assert.match(cmdBody, /iteration_count\s*<\s*2/);
  });

  it('escalates instead of aborting after the iteration cap', () => {
    assert.match(cmdBody, /\[needs-human-attention\]/);
    assert.match(cmdBody, /do NOT abort/);
  });

  it('feeds reviewer findings back into the developer on iteration', () => {
    assert.match(cmdBody, /Reviewer feedback \(round N\)/);
  });

  it('marks task Done + runs task_complete BEFORE pushing the PR', () => {
    assert.match(cmdBody, /mark task Done.*BEFORE push/i);
    assert.match(cmdBody, /mcp__plugin_ai-sdlc_ai-sdlc__task_complete/);
  });

  it('uses the plugin task_edit (preserves permittedExternalPaths — AISDLC-83)', () => {
    assert.match(cmdBody, /mcp__plugin_ai-sdlc_ai-sdlc__task_edit/);
    assert.match(cmdBody, /mcp__plugin_ai-sdlc_ai-sdlc__task_complete/);

    // Strip backtick-quoted upstream-name explanations before the regression
    // check so the rationale paragraph doesn't trip the assertion.
    const stripped = cmdBody.replace(/`mcp__backlog__task_(edit|complete)`/g, '');
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
    assert.match(cmdBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('commits the file move as a separate chore commit', () => {
    assert.match(cmdBody, /chore: mark.*complete/);
  });

  it('builds finalSummary per CLAUDE.md template', () => {
    assert.match(cmdBody, /finalSummary/);
    assert.match(cmdBody, /## Summary/);
    assert.match(cmdBody, /## Verification/);
  });

  it('creates parallel sibling PRs from filesChangedExternal', () => {
    assert.match(cmdBody, /filesChangedExternal/);
    assert.match(cmdBody, /sibling for \$TASK_ID/);
    assert.match(cmdBody, /git -C "\$SIBLING"/);
  });

  it('skips siblings cleanly when gh auth is unavailable for that repo', () => {
    assert.match(cmdBody, /gh auth not configured for that repo/);
  });

  it('does NOT roll back the main PR if a sibling PR creation fails', () => {
    assert.match(cmdBody, /do NOT roll back the main PR/);
  });

  it('cross-links sibling PRs back into the main PR body', () => {
    assert.match(cmdBody, /Sibling PRs/);
    assert.match(cmdBody, /gh pr edit/);
  });

  it('writes the per-worktree .active-task sentinel at Step 4', () => {
    assert.match(cmdBody, /\$WORKTREE_PATH\/\.active-task/);
    assert.match(cmdBody, /echo "\$TASK_ID" > "\$WORKTREE_PATH\/\.active-task"/);
  });

  it('cleans up the per-worktree sentinel at end of run regardless of outcome', () => {
    assert.match(cmdBody, /rm -f "\$WORKTREE_PATH\/\.active-task"/);
    assert.match(cmdBody, /whether the run succeeded, failed, was rolled back, or escalated/i);
  });

  it('opens a PR via gh pr create', () => {
    assert.match(cmdBody, /gh pr create/);
  });

  it('uses References (not Closes) per backlog convention', () => {
    assert.match(cmdBody, /References/);
  });

  it('explicitly forbids gh pr merge', () => {
    assert.match(cmdBody, /Never (merge any PR|runs `gh pr merge`)/i);
  });

  it('explicitly forbids git push --force', () => {
    assert.match(cmdBody, /Never (force-push|runs `git push --force`)/i);
  });

  it('rolls back task status on developer failure', () => {
    assert.match(cmdBody, /revert.*task.*To Do/i);
  });

  it('preserves worktree for inspection on failure', () => {
    assert.match(cmdBody, /Worktree preserved/);
  });

  it('embeds the hard governance rules (defense-in-depth)', () => {
    // The slash command body now carries the same governance rules the
    // developer + reviewers also embed — belt-and-braces in case a future
    // edit drops one. Excludes Hard Rule 7 (recursive-orchestrator) which
    // became moot when the orchestrator was deleted.
    assert.match(cmdBody, /Never merge any PR/i, 'must embed never-merge rule');
    assert.match(cmdBody, /Never force-push/i, 'must embed never-force-push rule');
    assert.match(cmdBody, /Never edit `\.ai-sdlc\/\*\*`/i, 'must embed never-edit-config rule');
  });

  // ── AISDLC-74: review attestation contract ────────────────────────
  // Step 10 must build + sign + write a DSSE envelope BEFORE the chore
  // commit so CI's verify-attestation workflow can verify it on push.

  it('Step 10: refuses to sign when ~/.ai-sdlc/signing-key.pem is missing', () => {
    assert.match(cmdBody, /\$HOME\/\.ai-sdlc\/signing-key\.pem/);
    assert.match(cmdBody, /\/ai-sdlc init-signing-key/);
  });

  it('Step 10: invokes scripts/sign-attestation.mjs with verdicts + iteration + harness-note', () => {
    assert.match(cmdBody, /scripts\/sign-attestation\.mjs/);
    assert.match(cmdBody, /--review-verdicts/);
    assert.match(cmdBody, /--iteration-count/);
    assert.match(cmdBody, /--harness-note/);
  });

  it('Step 10: skips the signing step when iteration cap was exceeded', () => {
    assert.match(cmdBody, /If reviews approved cleanly:/);
    assert.match(cmdBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('Step 10: stages the .ai-sdlc/attestations/ file in the chore commit', () => {
    assert.match(cmdBody, /git add backlog\/tasks backlog\/completed \.ai-sdlc\/attestations/);
  });

  it('Step 10: writes the envelope at .ai-sdlc/attestations/<head-sha>.dsse.json', () => {
    assert.match(cmdBody, /\.ai-sdlc\/attestations\/<head-sha>\.dsse\.json/);
  });

  it('Step 10: chore commit message references AISDLC-74 + verify-attestation', () => {
    assert.match(cmdBody, /AISDLC-74/);
    assert.match(cmdBody, /verify-attestation/);
  });

  // ── AISDLC-102: pre-sign rebase + conditional re-review contract ────
  it('Step 10.5: declares purpose and AISDLC-102 attribution', () => {
    assert.match(cmdBody, /Step 10\.5.*Pre-sign rebase/);
    assert.match(cmdBody, /AISDLC-102/);
  });

  it('Step 10.5: fetches origin main with a bounded timeout', () => {
    assert.match(cmdBody, /timeout 30 git fetch origin main/);
    assert.match(cmdBody, /flaky network must NOT block signing/i);
  });

  it('Step 10.5: skips rebase when origin/main is already an ancestor', () => {
    assert.match(cmdBody, /git merge-base --is-ancestor origin\/main HEAD/);
    assert.match(cmdBody, /no rebase needed/);
  });

  it('Step 10.5: aborts on rebase conflict (no auto-resolve)', () => {
    assert.match(cmdBody, /git rebase --abort/);
    assert.match(cmdBody, /outcome: aborted \(rebase-conflict\)/);
    assert.match(cmdBody, /never auto-resolve/i);
  });

  it('Step 10.5: bounds rebase attempts at 3 to avoid infinite loops', () => {
    assert.match(cmdBody, /REBASE_ATTEMPTS.*3/);
    assert.match(cmdBody, /outcome: aborted \(rebase-loop\)/);
  });

  it('Step 10.5: reuses reviewers approval when post-rebase contentHash unchanged', () => {
    assert.match(cmdBody, /PRE_HASH.*POST_HASH/s);
    assert.match(cmdBody, /reviewers' approval reused/);
  });

  it('Step 10.5: re-spawns 3 reviewers in parallel when contentHash changed', () => {
    assert.match(cmdBody, /re-spawning 3 reviewers/);
    assert.match(cmdBody, /Spawn 3 reviewers in parallel/i);
  });

  it('Step 10.5: shares Step 9 iteration cap for re-review', () => {
    assert.match(cmdBody, /Step 9's iteration cap/);
    assert.match(cmdBody, /\[needs-human-attention\]/);
  });

  it('Step 10.5: skips entirely when iteration cap was exceeded', () => {
    assert.match(cmdBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('Step 10.5: notes coordination with AISDLC-101 (verifier-side defense)', () => {
    assert.match(cmdBody, /AISDLC-101/);
    assert.match(cmdBody, /defense in depth/i);
  });

  it('Step 3: also fetches origin main BEFORE worktree creation (fresh base)', () => {
    assert.match(cmdBody, /Step 3.*fresh base from latest main/);
    assert.match(cmdBody, /paired\s+defenses/i);
  });
});
