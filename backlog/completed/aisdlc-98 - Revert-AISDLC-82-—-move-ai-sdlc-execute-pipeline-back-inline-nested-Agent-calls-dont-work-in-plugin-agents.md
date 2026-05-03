---
id: AISDLC-98
title: >-
  Revert AISDLC-82 — move /ai-sdlc execute pipeline back inline; nested Agent
  calls don't work in plugin agents
status: Done
assignee: []
created_date: '2026-04-30 22:14'
labels:
  - plugin
  - architecture
  - revert
  - execute-pipeline
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/execute.test.mjs
  - ai-sdlc-plugin/agents/agents.test.mjs
  - >-
    backlog/completed/aisdlc-82 -
    Refactor-ai-sdlc-execute-to-a-self-contained-orchestrator-subagent-so-parallel-runs-are-first-class.md
  - >-
    backlog/completed/aisdlc-90 -
    Fix-execute-orchestrator-agent-frontmatter-Task-Agent-rename-MCP-namespace.md
  - CLAUDE.md
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/agents/execute-orchestrator.md
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Trigger:** First real test of execute-orchestrator parallel execution (after AISDLC-90's frontmatter fixes shipped) revealed that the entire AISDLC-82 architecture is unimplementable on the current Claude Code harness. Two parallel `Agent(execute-orchestrator)` calls were fired from the main session against AISDLC-69.1 and AISDLC-69.2. Both aborted — but AISDLC-69.2's abort exposed the architectural problem:

> **`Agent` tool returned: "No such tool available: Agent. Agent is not available inside subagents."**

The plugin agent's frontmatter declares `tools: [Agent(developer, code-reviewer, test-reviewer, security-reviewer), ...]`. The orchestrator's system prompt explicitly says "You are the ONE agent in this plugin that may use the Agent tool." But the Claude Code harness silently filters the Agent tool from any subagent invocation, regardless of plugin frontmatter declarations. **Nested Agent calls (Agent → Agent → ...) are blocked one level deep for plugin agents**, period. There's no plugin-side workaround.

This is one level deeper than AISDLC-91 documented (which scoped to Grep/Glob/AskUserQuestion filtering). The actual blocker is that the orchestrator can't spawn its own developer/reviewer subagents — its core purpose.

**Implication:** The AISDLC-82 design ("main session fires N execute-orchestrator subagents in parallel, each spawns its own developer + reviewers") cannot work. The execute-orchestrator-as-subagent pattern has to be retired.

## What changes

Move the Step 0-13 pipeline body BACK from `ai-sdlc-plugin/agents/execute-orchestrator.md` into `ai-sdlc-plugin/commands/execute.md` (where it lived pre-AISDLC-82). The slash command body runs in the main Claude Code session, which DOES have the Agent tool — so it can spawn `developer` and the 3 reviewers directly without an orchestrator middleman.

**Parallelism story changes:**

- Old (AISDLC-82, doesn't work): main session fires N parallel `Agent(execute-orchestrator)` calls, each orchestrator spawns its own dev + reviewers
- New (this task): the slash command body itself is the "pipeline runner". For parallel runs, the operator manually fires N parallel `/ai-sdlc execute <task-id>` invocations from `/loop`, OR the operator (in a single Claude Code session) instructs the main session to fire N parallel developer + reviewer subagents directly against N pre-allocated worktrees. The main session orchestrates without an intermediate subagent.

This loses some ergonomics (the operator drives parallelism explicitly rather than getting it for free from a single command) but matches what the harness allows.

## Specific reverts + new structure

### Revert
- Move Step 0-13 prose from `ai-sdlc-plugin/agents/execute-orchestrator.md` → `ai-sdlc-plugin/commands/execute.md` body
- Delete `ai-sdlc-plugin/agents/execute-orchestrator.md` entirely
- Remove the `Agent(execute-orchestrator)` tool grant from `ai-sdlc-plugin/commands/execute.md`'s frontmatter — the slash command body needs `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` instead, since IT will spawn those directly
- Delete `agents.test.mjs` assertions about execute-orchestrator (currently 4-5 tests reference it)
- Update `commands/execute.test.mjs` to assert the new body shape (Step 0-13 inline, no execute-orchestrator reference)

### Reframe
- Update `CLAUDE.md` `Parallel runs are first-class` section: explain the new model — main session runs the pipeline directly; parallelism is per-Claude-Code-session, not per-orchestrator-subagent
- Update `commands/execute.md` body to reference "main session" not "orchestrator subagent" throughout
- Document the harness limitation in CLAUDE.md `Plugin agent gotchas` section (new, or extend existing): "plugin agents cannot spawn other agents — Agent tool is filtered at runtime regardless of frontmatter declaration. Pipeline orchestration must run in the main Claude Code session (slash command body), not in a plugin subagent."

### Test corpus update
- `agents.test.mjs`: drop tests for execute-orchestrator (~4-5 assertions)
- `commands/execute.test.mjs`: add tests for the inline Step 0-13 pipeline shape
- Manual end-to-end test: run `/ai-sdlc execute AISDLC-69.2` (or another safe task) from a fresh Claude Code session, confirm it completes Steps 0-13

## Why this is the right call

1. **The AISDLC-82 architecture was based on incorrect assumption** about nested Agent calls being allowed. The first parallel test exposed this empirically. No plugin-side fix is possible.
2. **The slash command body pattern is what we've actually been using all session** to drive PR #101 (AISDLC-90), #102 (AISDLC-93), #103 (release-please). It works.
3. **Parallelism still works** — operator fires multiple `/ai-sdlc execute` invocations across Claude Code sessions, OR has the main session fire multiple developer+reviewer fan-outs directly. Just not via an orchestrator middleman.
4. **Out-of-process orchestration still works** — `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` is unaffected (it's a separate process, not a Claude Code subagent).
5. **Simplifies the mental model** — slash command IS the pipeline body. No middleman to confuse with.

## What this DOESN'T change

- AISDLC-81 (per-worktree active-task sentinels) — still useful for cross-repo writes; just sourced from main session's pwd instead of orchestrator's pwd
- AISDLC-90 (the frontmatter fixes that this task partially undoes) — the MCP namespace fix and AskUserQuestion removal still apply to the slash command's `allowed-tools`. The Task→Agent rename also stays.
- All review/attestation infrastructure (AISDLC-74/84/85/87/93) — unaffected
- Out-of-process orchestrator (TypeScript) — separate code path, unaffected

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Move Step 0-13 prose from `ai-sdlc-plugin/agents/execute-orchestrator.md` to `ai-sdlc-plugin/commands/execute.md` body
2. Delete `ai-sdlc-plugin/agents/execute-orchestrator.md` and any agents.test.mjs assertions referencing it
3. Update `commands/execute.md` frontmatter `allowed-tools` to grant `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` (the subagents the body needs to spawn) plus the existing tool set
4. Update CLAUDE.md's `Parallel runs are first-class` section to describe the main-session-runs-pipeline model; document the harness limitation in a new `Plugin agent gotchas` section
5. Update `commands/execute.test.mjs` to assert the new inline-body shape
6. End-to-end manual verification: from a fresh Claude Code session, run `/ai-sdlc execute <safe-task-id>` and confirm it completes Steps 0-13 successfully (developer spawn, 3 parallel reviewers, attestation, PR open)
7. Bump plugin version (release-please will pick this up as a feat: or fix: per conventional commit type)
8. All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
9. Mark AISDLC-82 as superseded in its task file footer (or add a "Superseded by AISDLC-98" note)

## References

- AISDLC-82 — the original execute-orchestrator subagent task being reverted
- AISDLC-90 — the frontmatter fixes that proved the orchestrator was loadable but not functional
- AISDLC-91 — the (now-superseded-by-this-finding) async-tool-filter task. Will be updated with the deeper finding instead of closed.
- First parallel test (this session) — empirical proof: AISDLC-69.2's orchestrator returned "No such tool available: Agent. Agent is not available inside subagents."
- `ai-sdlc-plugin/agents/execute-orchestrator.md` (file to delete)
- `ai-sdlc-plugin/commands/execute.md` (file to extend with Step 0-13 body)
- `ai-sdlc-plugin/agents/agents.test.mjs` (drop orchestrator tests)
- `ai-sdlc-plugin/commands/execute.test.mjs` (extend with new body assertions)
- CLAUDE.md (update parallel-runs section + add plugin-agent-gotchas section)
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 Move Step 0-13 prose from `ai-sdlc-plugin/agents/execute-orchestrator.md` to `ai-sdlc-plugin/commands/execute.md` body
- [ ] #2 Delete `ai-sdlc-plugin/agents/execute-orchestrator.md` and remove any agents.test.mjs assertions referencing it
- [ ] #3 Update `commands/execute.md` frontmatter `allowed-tools` to grant `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` plus existing tools
- [ ] #4 Update CLAUDE.md `Parallel runs are first-class` section to describe main-session-runs-pipeline model; add `Plugin agent gotchas` section documenting the nested-Agent harness limitation
- [ ] #5 Update `commands/execute.test.mjs` to assert the new inline-body shape (Step 0-13 markers, no execute-orchestrator reference)
- [ ] #6 End-to-end manual verification: from fresh Claude Code session, run `/ai-sdlc execute <safe-task-id>` and confirm Steps 0-13 complete (developer + 3 reviewers + attestation + PR)
- [ ] #7 Mark AISDLC-82 as superseded — add a `## Superseded by AISDLC-98` note to its completed task file
- [ ] #8 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Reverted AISDLC-82. Moved the Step 0-13 pipeline body from the (now-deleted) `ai-sdlc-plugin/agents/execute-orchestrator.md` subagent back into the `ai-sdlc-plugin/commands/execute.md` slash command body, where it can use the `Agent` tool. The execute-orchestrator-as-subagent design is structurally unimplementable on the current Claude Code harness — `Agent` is filtered out of every plugin subagent's tool grant one level deep, regardless of the frontmatter declaration form. AISDLC-69.2's parallel-execution test returned `"No such tool available: Agent. Agent is not available inside subagents."` This PR closes that loop by restoring the pre-AISDLC-82 design under the new constraint understanding.

## Changes

- `ai-sdlc-plugin/commands/execute.md` — Step 0-13 prose moved back inline; frontmatter tool grants updated to `Agent(developer, code-reviewer, test-reviewer, security-reviewer)` (was `Agent(execute-orchestrator)`)
- `ai-sdlc-plugin/agents/execute-orchestrator.md` — DELETED
- `ai-sdlc-plugin/commands/execute.test.mjs` — 57 tests asserting the new inline body shape: Step 0-13 markers, AISDLC-74 attestation contract, AISDLC-102 Step 10.5 rebase contract, frontmatter tool grant, plus `existsSync` regression guard against re-introducing the orchestrator file
- `ai-sdlc-plugin/agents/agents.test.mjs` — removed orchestrator-specific assertions; added per-agent `disallowedTools: AgentTool` assertion that locks in "no recursive subagent spawning" for all 4 spawnable subagents
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` — single-line docstring update redirecting from the deleted orchestrator file path to the new `commands/execute.md` location
- `CLAUDE.md` — `Parallel runs are first-class` section reframed: per-Claude-Code-session parallelism (one `/loop /ai-sdlc execute` tick at a time, or N terminals firing the slash command in parallel) replaces the AISDLC-82 "main session fans out N orchestrator subagents" model. Documents the harness limitation that motivated the revert.

## AC status

- ✓ All 7 ACs met (per dev's `acceptanceCriteriaMet: [1, 2, 3, 4, 5, 6, 7]`)

## Design decisions

- **Preserve AISDLC-102 content verbatim**: Step 3 fresh-base fetch, Step 10.5 rebase + contentHash oracle + 3-attempt cap + conflict abort all ported into the new home byte-equivalent
- **`existsSync` regression guard**: explicit assertion in `execute.test.mjs` that `agents/execute-orchestrator.md` does NOT exist — prevents accidental re-introduction
- **Per-agent `AgentTool` disallowed**: every spawnable subagent (developer + 3 reviewers) carries `disallowedTools: [..., AgentTool]` so even if Claude Code ever permits nested Agent at the harness level, plugin subagents still can't recursively spawn

## Verification

- `pnpm build` — clean
- `node --test ai-sdlc-plugin/agents/agents.test.mjs` — 15/15
- `node --test ai-sdlc-plugin/commands/execute.test.mjs` — 57/57 (total 72 with agents.test.mjs)
- `pnpm test` (full workspace) — clean
- `pnpm lint`, `pnpm format:check` — clean
- 3 parallel reviews approved (code-reviewer 0c/0M/2m/1s; test-reviewer 0c/0M/2m/0s; security-reviewer 0c/0M/0m/0s); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Coordination follow-up

- **PR #115 (AISDLC-88)** is still open and modifies the now-deleted `execute-orchestrator.md` (Hard Rule 8 + Step 10 sed sanitization for `[skip ci]`-family tokens). Whichever PR merges second must rebase to port AISDLC-88's content into the new `commands/execute.md` location. Without that port, the CI-skip-token defenses silently disappear on the merge that lands second. **Code reviewer + security reviewer both flagged this in their findings — operator must handle the rebase carefully.**

## Follow-up

- AISDLC-91 may be closeable as superseded-by-AISDLC-98 once this lands (the upstream-Claude-Code-harness path it documented is no longer load-bearing for our architecture)
- RFC-0012 (AISDLC-100.X) is the long-term replacement architecture; this revert restores correctness in the meantime
- Section ordering in `commands/execute.md` has Step 10.5 before Step 10 (preserved verbatim from the deleted orchestrator) — minor doc-readability issue, fine to fix in a follow-up doc PR
<!-- SECTION:FINAL_SUMMARY:END -->
