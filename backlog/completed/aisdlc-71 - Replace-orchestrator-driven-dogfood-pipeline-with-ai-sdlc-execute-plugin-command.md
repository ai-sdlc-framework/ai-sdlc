---
id: AISDLC-71
title: >-
  Replace orchestrator-driven dogfood pipeline with /ai-sdlc execute plugin
  command
status: In Progress
assignee: []
created_date: '2026-04-27 21:57'
updated_date: '2026-04-27 21:58'
labels:
  - plugin
  - dogfood
  - architecture
  - refactor
dependencies: []
references:
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - .ai-sdlc/pipeline-backlog.yaml
  - .ai-sdlc/agent-role.yaml
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/commands/triage.md
  - ai-sdlc-plugin/commands/review.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.sh
  - ai-sdlc-plugin/plugin.json
  - scripts/check-task-moved.sh
  - CLAUDE.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The current dogfood pipeline runs the orchestrator (TypeScript Node service) as a subprocess from inside a Claude Code session. The orchestrator re-implements session/auth/cwd/tool-gating that Claude Code already provides natively. The past 24h shipped 5 PRs (#69-74) patching surface bugs in this layer (untracked-file sweep, branch-side-effects, validate-output guardrail blindness, cross-repo wandering, branch template propagation, unicode pathspec, staged-diff invisibility). Each layer of duplication produces the same class of bug at a different surface.

This task replaces the dogfood path with a Claude Code plugin command (`/ai-sdlc execute <task-id>`) that drives subagents per stage. The orchestrator stays in the repo for the GitHub-issue / programmatic / CI path — just isn't called for backlog tasks anymore.

## Architecture (locked-in design — see plan in commit history / chat transcript)

- **`/ai-sdlc execute <task-id>`**: slash command, one task per invocation. Composes with `/loop` for batch.
- **Hybrid orchestration**: command body drives stages; developer runs as subagent (context isolation); reviewers run as 3 parallel `Agent` calls in main thread.
- **Worktree isolation**: `git worktree add .worktrees/<task-id>/` per run; auto-removed on next `/ai-sdlc execute` invocation if the branch's PR has merged; standalone `/ai-sdlc cleanup` companion command for ad-hoc.
- **Cross-repo writes**: `permittedExternalPaths` field in task frontmatter explicitly allowlists sibling-repo write targets; PreToolUse hook enforces. After main PR opens, command auto-creates parallel branches/PRs in any dirty sibling repos.
- **Validation guardrails**: extended PreToolUse hook on Write/Edit (not just Bash) that blocks writes to `.ai-sdlc/**`, `.github/workflows/**` per `agent-role.yaml`, honoring `permittedExternalPaths` for the active task.
- **Governance for subagents**: SubagentStart hook in plugin.json (NOT SessionStart — confirmed via claude-code source: SessionStart does not fire for subagents) injects governance context.
- **Task lifecycle**: command flips status to `In Progress` at start. After reviews approve, before PR push, command flips status to `Done` + runs `task_complete` (file moves `tasks/` → `completed/`) + commits the move as `chore: mark <id> complete`. The whole task lifecycle lands in the same PR.
- **Review iteration**: cap at 2 dev iterations on review failure. After cap, auto-open PR with `[needs-human-attention]` flag and full review verdicts in body.
- **Reviewer harness fallback**: when Codex unavailable, fall back to claude-code with a visible `INDEPENDENCE NOT ENFORCED` warning per verdict (per RFC-0010 §13.13 v13).
- **Progress visibility**: developer agent emits `[ai-sdlc-progress] <stage>: <one-line status>` per major stage; main session surfaces these as they appear.
- **Cost**: subscription-only; no shadow-cost tracking.

## Files to create / modify

**New**
- `ai-sdlc-plugin/commands/execute.md` — the slash command body (orchestrates the full flow per the design)
- `ai-sdlc-plugin/commands/cleanup.md` — companion command for ad-hoc worktree cleanup
- `ai-sdlc-plugin/agents/developer.md` — dev subagent definition (frontmatter + system prompt; mirrors reviewer agent shape)
- `ai-sdlc-plugin/hooks/subagent-start.sh` — governance injector for subagents
- `ai-sdlc-plugin/commands/execute.test.mjs`, `cleanup.test.mjs`, `agents/developer.test.mjs` row in `agents.test.mjs`
- `ai-sdlc-plugin/hooks/subagent-start.test.mjs`

**Modify**
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.{sh,js}` — extend matcher from Bash-only to also handle Write and Edit tool inputs against blocked-paths from `agent-role.yaml`; honor `permittedExternalPaths` from active task frontmatter via `AI_SDLC_ACTIVE_TASK_ID` env var
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs` — add cases for Write/Edit blocked-path enforcement and external-path allowlist
- `ai-sdlc-plugin/plugin.json` — register SubagentStart hook + extend PreToolUse matcher to `Bash|Write|Edit`
- `CLAUDE.md` — add "Backlog dogfood loop" section documenting `/ai-sdlc execute <task-id>` as canonical local path; clarify Done = "reviews-approved-and-PR-opened"; document `permittedExternalPaths` task frontmatter convention; note `cli-watch` remains for unattended/CI use
- `.github/workflows/backlog-task-complete.yml` — make it idempotent (no-op when task file already in `completed/`) so it stays useful as fallback for non-`/ai-sdlc execute` PRs
- `backlog/tasks/aisdlc-68 - *.md` (or its successor) — add `permittedExternalPaths: ['../ai-sdlc-io/']` as the dogfood test case

**No edits to** `orchestrator/src/`. The command is fully decoupled at runtime.

## Dogfood verification

The acceptance criterion isn't "tests pass" — it's "we used `/ai-sdlc execute AISDLC-68` (or successor) and it shipped a clean PR end-to-end." Until that happens, this task isn't done.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `/ai-sdlc execute <task-id>` slash command exists, validates task shape (status, ACs), creates `.worktrees/<task-id>/`, flips task to `In Progress`, invokes developer subagent, runs 3 parallel reviewer subagents, gates on findings (auto-open if approved, AskUserQuestion if critical/major after 2 iterations), marks task Done + commits the file move, opens PR via `gh pr create`
- [ ] #2 Developer subagent (`ai-sdlc-plugin/agents/developer.md`) defined with proper frontmatter (allowed-tools, disallowed-tools), embedded hard rules (never merge, never force-push, never edit blocked paths), and emits `[ai-sdlc-progress]` lines per major stage
- [ ] #3 PreToolUse hook extended to fire on Write and Edit (not only Bash); blocks writes to paths matching `agent-role.yaml` blockedPaths unless path falls under `permittedExternalPaths` in the active task's frontmatter; covered by tests for both block and allowlist paths
- [ ] #4 SubagentStart hook in `plugin.json` injects governance context for any spawned subagent (verified by reading claude-code source: SessionStart does not fire for subagents)
- [ ] #5 Cross-repo PR creation: after main PR opens, command iterates sibling git repos under `permittedExternalPaths`, creates a parallel branch + PR per dirty sibling with linked title (`<task-title> — sibling for <id>`), prints both PR URLs at end
- [ ] #6 Worktree cleanup: at `/ai-sdlc execute` start, sweeps `.worktrees/` and removes any whose branch's PR has merged on `main`; standalone `/ai-sdlc cleanup [<task-id>]` command exists for explicit cleanup
- [ ] #7 Reviewer harness fallback: when Codex unavailable, reviews fall back to claude-code with visible `INDEPENDENCE NOT ENFORCED (codex unavailable)` warning per verdict; aggregated review summary surfaces the warning prominently
- [ ] #8 Review iteration cap: dev runs at most 2 iterations on review failure; after cap, command auto-opens PR with `[needs-human-attention]` in body and all review verdicts (collapsed) without aborting the work
- [ ] #9 Done-on-PR-open lifecycle: command runs `mcp__backlog__task_edit Done + acceptanceCriteriaCheck + finalSummary` and `mcp__backlog__task_complete` (file moves to `completed/`), commits the move as `chore: mark <id> complete`, then pushes — all in the same PR
- [ ] #10 `.github/workflows/backlog-task-complete.yml` made idempotent (no-op when file already in `completed/`)
- [ ] #11 CLAUDE.md updated: documents `/ai-sdlc execute` as canonical local execution path, defines Done as `reviews-approved-and-PR-opened`, documents `permittedExternalPaths` frontmatter convention, retains `cli-watch` reference for unattended/CI path
- [ ] #12 Dogfood verification: `/ai-sdlc execute AISDLC-68` (or replacement task) successfully ships an end-to-end PR with no manual intervention beyond review-gate decisions; cite the PR URL in finalSummary
- [ ] #13 No imports of `@ai-sdlc/orchestrator` from any new plugin file; command is fully decoupled at runtime
- [ ] #14 All new code: 80%+ patch coverage, `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
