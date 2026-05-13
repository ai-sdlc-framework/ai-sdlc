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
    // The body uses "3 parallel reviewer subagents" / "three reviewers in parallel"
    // (not the exact phrase "three subagents in parallel" — fixed pre-existing mismatch)
    assert.match(cmdBody, /three.*parallel|parallel.*reviewer|3 parallel reviewer/i);
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
    // edit drops one. Hard Rule 7 (CI-skip token rule, AISDLC-88) is
    // asserted by the dedicated AISDLC-88 tests below.
    assert.match(cmdBody, /Never merge any PR/i, 'must embed never-merge rule');
    assert.match(cmdBody, /Never force-push/i, 'must embed never-force-push rule');
    assert.match(cmdBody, /Never edit `\.ai-sdlc\/\*\*`/i, 'must embed never-edit-config rule');
  });

  // ── AISDLC-88: CI-skip marker hygiene ─────────────────────────────
  // The slash command body must enumerate the five GH Actions magic
  // tokens and document the paren-quoted escape (Hard Rule 7), AND
  // Step 10 must sed-sanitise those tokens out of the chore commit
  // body before `git commit -m` (defense-in-depth).

  it('body forbids GH Actions CI-skip magic tokens in commit messages (AISDLC-88)', () => {
    // Hard Rule 7 must enumerate all five tokens and document the
    // paren-quoted escape pattern.
    assert.ok(cmdBody.includes('AISDLC-88'), 'reference AISDLC-88 task ID');
    assert.match(cmdBody, /\[skip ci\]/, 'enumerate the [skip ci] token');
    assert.match(cmdBody, /\[ci skip\]/, 'enumerate the [ci skip] token');
    assert.match(cmdBody, /\[no ci\]/, 'enumerate the [no ci] token');
    assert.match(cmdBody, /\[skip actions\]/, 'enumerate the [skip actions] token');
    assert.match(cmdBody, /\[actions skip\]/, 'enumerate the [actions skip] token');
    assert.match(cmdBody, /\(skip ci marker\)/, 'show the paren-quoted example');
    assert.match(
      cmdBody,
      /backtick-wrapping.*does NOT defeat/i,
      'must explicitly debunk the backtick-wrapping myth',
    );
    // The CI-side attestor's chore commit is the documented exception —
    // call it out by author identity (production OR legacy fallback) AND
    // subject prefix so future readers know which one commit is exempt.
    assert.match(
      cmdBody,
      /(github-actions|ai-sdlc-ci-attestor)\[bot\]/,
      'name the bot-author exemption',
    );
    assert.match(cmdBody, /chore\(ci\): sign review attestation/, 'name the bot-subject exemption');
  });

  it('Step 10 sanitises CI-skip magic tokens out of the chore commit body (AISDLC-88)', () => {
    // The chore commit MUST fire verify-attestation.yml + ai-sdlc-review.yml.
    // Step 10 sanitises any leaked magic token before piping into git commit -m.
    // Sed pipeline must rewrite all five tokens. We don't pin the exact
    // sed flags, but the five replacement targets must all be present.
    assert.match(cmdBody, /\(skip ci marker\)/, 'replacement for [skip ci]');
    assert.match(cmdBody, /\(ci skip marker\)/, 'replacement for [ci skip]');
    assert.match(cmdBody, /\(no ci marker\)/, 'replacement for [no ci]');
    assert.match(cmdBody, /\(skip actions marker\)/, 'replacement for [skip actions]');
    assert.match(cmdBody, /\(actions skip marker\)/, 'replacement for [actions skip]');
    // Must wire through git commit -m with the sanitised body.
    assert.match(
      cmdBody,
      /git commit -m "\$CHORE_BODY"/,
      'commit must use the sanitised body, not the raw template',
    );
  });

  // ── AISDLC-74 / AISDLC-133: review attestation contract ─────────────────
  // AISDLC-133 moved signing from this step into the pre-push hook — the slash
  // command body now writes a per-worktree verdicts file which the hook reads at
  // push time to auto-sign + commit the DSSE envelope. Step 10 no longer calls
  // scripts/sign-attestation.mjs directly; that would double-sign and create two
  // attestation commits. The hook owns signing; Step 10 owns the verdicts file.

  it('Step 10: refuses to sign when ~/.ai-sdlc/signing-key.pem is missing', () => {
    assert.match(cmdBody, /\$HOME\/\.ai-sdlc\/signing-key\.pem/);
    assert.match(cmdBody, /\/ai-sdlc init-signing-key/);
  });

  it('Step 10: writes per-worktree verdicts file for pre-push hook (AISDLC-133)', () => {
    // AISDLC-133: Step 10 writes .ai-sdlc/verdicts/<task-id-lower>.json.
    // The pre-push hook reads it in Step 11 to auto-sign the DSSE envelope.
    // Signing (sign-attestation.mjs) is the hook's job, NOT Step 10's.
    assert.match(cmdBody, /AISDLC-133/);
    assert.match(cmdBody, /\.ai-sdlc\/verdicts\//);
    // The hook still invokes sign-attestation.mjs (referenced in the comment),
    // but Step 10 must NOT call it with --review-verdicts directly.
    assert.doesNotMatch(
      cmdBody,
      /node.*sign-attestation\.mjs.*--review-verdicts/s,
      'Step 10 must NOT call sign-attestation.mjs with --review-verdicts — hook owns signing (AISDLC-133)',
    );
  });

  it('Step 10: mentions AI_SDLC_ITERATION_COUNT and AI_SDLC_HARNESS_NOTE env exports for hook', () => {
    // The hook picks up iteration count + harness note from env vars.
    assert.match(cmdBody, /AI_SDLC_ITERATION_COUNT/);
    assert.match(cmdBody, /AI_SDLC_HARNESS_NOTE/);
  });

  it('Step 10: skips the signing step when iteration cap was exceeded', () => {
    assert.match(cmdBody, /If reviews approved cleanly:/);
    assert.match(cmdBody, /Skip this step entirely if the iteration cap was exceeded/i);
  });

  it('Step 10: stages backlog only (NOT .ai-sdlc/attestations — hook adds that)', () => {
    // AISDLC-133: the chore commit at Step 10 stages backlog/* only.
    // The attestation envelope is added by the pre-push hook on a SEPARATE
    // follow-up chore commit after Step 11 — it must NOT appear here.
    assert.match(cmdBody, /git add backlog\/tasks backlog\/completed/);
    // Ensure the old .ai-sdlc/attestations inclusion is absent from this line.
    const lines = cmdBody.split('\n');
    const addLine = lines.find((l) => /git add backlog\/tasks backlog\/completed/.test(l));
    assert.ok(addLine, 'must have git add backlog/... line');
    assert.doesNotMatch(
      addLine,
      /\.ai-sdlc\/attestations/,
      'Step 10 git add must NOT include .ai-sdlc/attestations — pre-push hook owns that commit (AISDLC-133)',
    );
  });

  it('Step 10: writes the envelope at .ai-sdlc/attestations/<head-sha>.dsse.json (via hook)', () => {
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

  // ── AISDLC-245.4: path resolution convention ──────────────────────────
  // All pipeline-cli and plugin-script invocations must use portable
  // variables ($PIPELINE_CLI_BIN, $PLUGIN_SCRIPTS_DIR), never bare relative
  // paths like `node pipeline-cli/bin/...` or `node ai-sdlc-plugin/scripts/...`.
  // This ensures the command works in adopter installs (CLAUDE_PLUGIN_DIR set)
  // and the dogfood monorepo (CLAUDE_PLUGIN_DIR unset, falls back to ./pipeline-cli/).

  it('AISDLC-245.4: establishes PIPELINE_CLI_BIN with CLAUDE_PLUGIN_DIR resolution', () => {
    assert.match(
      cmdBody,
      /PIPELINE_CLI_BIN/,
      'must define PIPELINE_CLI_BIN for portable CLI invocation',
    );
    assert.match(
      cmdBody,
      /CLAUDE_PLUGIN_DIR/,
      'must reference CLAUDE_PLUGIN_DIR for adopter-install layout',
    );
    assert.match(
      cmdBody,
      /pipeline-cli\/bin/,
      'must include pipeline-cli/bin path component (dogfood fallback)',
    );
  });

  it('AISDLC-245.4: all pipeline-cli CLI invocations use $PIPELINE_CLI_BIN (no bare relative paths)', () => {
    // Executable invocations in code blocks must use the variable.
    // The regex matches the START of a CLI invocation line — node <path>/<bin>.mjs
    // — and checks the path uses $PIPELINE_CLI_BIN, not a hardcoded relative path.
    const lines = cmdBody.split('\n');
    const violations = lines.filter((line) => {
      // Match lines that are actual node invocations (not prose/comments referencing
      // the old pattern as "don't do this" warnings or backtick-quoted examples).
      const trimmed = line.trimStart();
      // Skip prose paragraphs (shell comments) and markdown blockquotes
      if (trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('//'))
        return false;
      // Skip lines that only contain backtick-quoted references (prose warnings showing
      // old deprecated paths, not actual invocations). These are formatted as
      // `node ai-sdlc-plugin/scripts/sign-attestation.mjs` — inline code in prose.
      // We detect this by checking that the bare path does NOT appear outside backticks.
      // Strategy: strip all backtick-quoted spans, then recheck.
      const lineWithoutBackticks = line.replace(/`[^`]*`/g, '``');
      // Flag bare `node pipeline-cli/bin/` or `node ai-sdlc-plugin/scripts/` outside backticks
      return (
        /\bnode pipeline-cli\/bin\//.test(lineWithoutBackticks) ||
        /\bnode ai-sdlc-plugin\/scripts\//.test(lineWithoutBackticks)
      );
    });
    assert.equal(
      violations.length,
      0,
      `Found bare relative-path invocations (must use $PIPELINE_CLI_BIN or $PLUGIN_SCRIPTS_DIR):\n${violations.join('\n')}`,
    );
  });

  it('AISDLC-245.4: establishes PLUGIN_SCRIPTS_DIR for plugin-internal scripts', () => {
    assert.match(
      cmdBody,
      /PLUGIN_SCRIPTS_DIR/,
      'must define PLUGIN_SCRIPTS_DIR for portable plugin-script invocation',
    );
  });

  it('AISDLC-245.4: compute-slug.mjs invoked via $PLUGIN_SCRIPTS_DIR', () => {
    assert.match(
      cmdBody,
      /\$PLUGIN_SCRIPTS_DIR\/compute-slug\.mjs/,
      'compute-slug.mjs must use $PLUGIN_SCRIPTS_DIR, not bare ai-sdlc-plugin/scripts/',
    );
  });

  // ── AISDLC-272: portable execute across all install topologies ────────────
  // The original two-case CLAUDE_PLUGIN_DIR branch assumed either "env set +
  // bundled deps" (adopter) or "env unset" (dogfood). In practice the local
  // marketplace cache never runs npm install, so CLAUDE_PLUGIN_DIR can be set
  // but deps missing — the old logic blindly used a path that didn't exist.
  //
  // AISDLC-272 extends resolution to 5 topologies:
  //   1. CLAUDE_PLUGIN_DIR set + deps present → use it
  //   2. CLAUDE_PLUGIN_DIR set + deps missing → self-heal via install-runtime-deps.sh
  //   3. CLAUDE_PLUGIN_DIR unset + CLAUDE_PLUGIN_ROOT set → try CLAUDE_PLUGIN_ROOT
  //   4. CLAUDE_PLUGIN_DIR unset → probe ~/.claude/plugins/cache/
  //   5. All env vars unset → $(pwd)/pipeline-cli/bin (dogfood)

  it('AISDLC-272: PIPELINE_CLI_BIN resolution references CLAUDE_PLUGIN_ROOT as fallback', () => {
    assert.match(
      cmdBody,
      /CLAUDE_PLUGIN_ROOT/,
      'must reference CLAUDE_PLUGIN_ROOT for topology 3 (env set but CLAUDE_PLUGIN_DIR unset)',
    );
  });

  it('AISDLC-272: resolution delegates to resolve-pipeline-cli.sh', () => {
    assert.match(
      cmdBody,
      /resolve-pipeline-cli\.sh/,
      'must delegate to resolve-pipeline-cli.sh for multi-topology resolution',
    );
  });

  it('AISDLC-272: PIPELINE_CLI_BIN supports external override via env var', () => {
    // Operators can skip all resolution by pre-exporting PIPELINE_CLI_BIN.
    // The body must guard with [ -z "${PIPELINE_CLI_BIN:-}" ] or equivalent.
    assert.match(
      cmdBody,
      /PIPELINE_CLI_BIN:-/,
      'must allow PIPELINE_CLI_BIN override via environment variable',
    );
  });

  it('AISDLC-272: PLUGIN_SCRIPTS_DIR uses CLAUDE_PLUGIN_ROOT as secondary fallback', () => {
    // PLUGIN_SCRIPTS_DIR must fall back to CLAUDE_PLUGIN_ROOT when CLAUDE_PLUGIN_DIR
    // is unset — not just to $(pwd)/ai-sdlc-plugin. This handles topology 3.
    assert.match(
      cmdBody,
      /PLUGIN_SCRIPTS_DIR=.*CLAUDE_PLUGIN_ROOT/,
      'PLUGIN_SCRIPTS_DIR must include CLAUDE_PLUGIN_ROOT in its fallback chain',
    );
  });

  it('AISDLC-272: resolution exits with actionable error when all topologies fail', () => {
    // When resolve-pipeline-cli.sh exits 1, the command body must catch it
    // and emit a clear error message rather than silently continuing.
    assert.match(
      cmdBody,
      /cannot continue.*@ai-sdlc\/pipeline-cli not found|@ai-sdlc\/pipeline-cli not found.*cannot continue/i,
      'must emit actionable error when @ai-sdlc/pipeline-cli cannot be found in any topology',
    );
  });
});
