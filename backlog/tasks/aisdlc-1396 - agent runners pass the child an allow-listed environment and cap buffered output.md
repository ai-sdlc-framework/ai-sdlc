---
id: AISDLC-1396
title: 'Agent runners pass the child an allow-listed environment and cap buffered output'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - security
  - orchestrator
  - runners
dependencies: []
references:
  - orchestrator/src/runners/cursor.ts
  - orchestrator/src/runners/codex.ts
  - orchestrator/src/runners/copilot.ts
  - orchestrator/src/runners/claude-code.ts
  - orchestrator/src/runners/runner-registry.ts
  - docs/operations/adapter-authoring.md
  - https://github.com/ai-sdlc-framework/ai-sdlc/pull/2634
priority: medium
---

## Description

**Gap.** Every CLI agent runner spawns its child with the whole parent environment (`env: { ...process.env }` at `cursor.ts:118`, `codex.ts:116`, `copilot.ts:85`, `claude-code.ts:391`), so a third-party agent CLI receives every token in the orchestrator's environment (GitHub tokens, other providers' API keys). Each runner also buffers all of the child's stdout in memory without a cap (`chunks.push` at `cursor.ts:125`, `codex.ts:123`, `copilot.ts:92`).

**Source.** Operator ruling 2026-11-23 (decision rubric, planner session) on fork PR #2634 (Kiro CLI runner, GitHub issue #870): accept the Kiro runner as written, and fix the environment exposure for every runner at once rather than hold one contributor to a rule the existing runners do not meet. The Kiro runner from PR 2634 copies the Cursor runner's shape; if it is on main when this task runs, it is in scope too (`orchestrator/src/runners/kiro.ts`).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a runner's child needs its own provider credential, PATH/HOME/locale and git identity; it does not need the orchestrator's other secrets. 2. Deleted: the blanket environment copy. 3. Simplified: one shared helper builds the child environment from a base allow-list plus the runner's own keys. 4. Accelerated: none. 5. Automated: tests below.

- Add `childEnv(runnerKeys: string[])` beside `cleanGitEnv` (`orchestrator/src/runners/git-utils.ts`): a base allow-list (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, proxy and CA variables, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`) plus the runner's declared keys (Cursor: `CURSOR_API_KEY`; Codex: `OPENAI_API_KEY`; Copilot: its token; Claude Code: `ANTHROPIC_*`/`CLAUDE_*`; Kiro: `KIRO_*`). An operator override `AI_SDLC_RUNNER_ENV_PASSTHROUGH` (comma-separated names) adds names; it never removes the base.
- Every runner uses it. Cap buffered stdout at a shared limit (default 10 MiB, overridable); past the cap keep the tail and record that output was truncated.
- Document the allow-list and override in `docs/operations/adapter-authoring.md`.

## Acceptance Criteria

- [ ] #1 A test per runner: a secret-looking variable not on the allow-list (for example `GITHUB_TOKEN`) is absent from the child environment, and the runner's own credential is present.
- [ ] #2 A test: `AI_SDLC_RUNNER_ENV_PASSTHROUGH=FOO` passes `FOO` through.
- [ ] #3 A test: output past the cap is truncated to the tail and the result says so; memory use stays bounded.
- [ ] #4 `docs/operations/adapter-authoring.md` documents the allow-list, the override and the cap.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
