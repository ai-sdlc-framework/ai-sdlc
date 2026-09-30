---
id: AISDLC-660
title: >-
  opencode v2: repo governance port, in-tree dispatch runner, harness
  adapter, ops runbook, contrib runner
status: In Progress
assignee: []
created_date: '2026-09-30 10:57'
labels:
  - opencode
  - orchestrator
  - harness
  - runner
  - governance
  - docs
dependencies: []
references: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The framework's agent engine was hardwired to the Claude Code CLI. This
task lands opencode v2 (installed binary v2.0.18; runner floor
`>=2.0.0` — v1 is unusable for the v2 plugin/permission shapes) as a
first-class engine so issues can be dispatched against local LM Studio
models (default `http://127.0.0.1:1234/v1`, e.g. `qwen/qwen3.8-27b`).
Every v2 contract claim was verified against the installed binary
(strings + live runs), not the dev-branch GitHub source, because the
config area drifts between the two.

## Deliverables (5 paths)

1. **Repo governance** — `opencode.json` (deny-only `permission` policy
   mirroring `.ai-sdlc/agent-role.yaml`, `mcp.ai-sdlc` pointing at the
   relative plugin MCP server, `autoupdate: false`, `share: disabled`) +
   `.opencode/agents/developer.md` +
   `.opencode/plugins/ai-sdlc-governance.js` (v2 plugin contract:
   `permission.evaluate`, `tool.execute.after`, `session.context`).
   Governance semantics preserved: blocked actions/paths enforced,
   fail-open on plugin errors, AISDLC-529 (env-discovered runners never
   auto-win over the claude-code default).
2. **In-tree dispatch runner** — `orchestrator/src/runners/opencode.ts`:
   per-dispatch `OPENCODE_CONFIG_CONTENT` injection (merge semantics
   proven empirically: the env doc merges last, per-key; omitted keys
   survive from the project config), MCP table re-anchored at the
   main-clone root for linked worktrees (entries whose re-anchored
   script is missing are dropped, fail-soft), retry + `--session`
   resume, `--standalone` on every programmatic invocation.
3. **Harness adapter** — `orchestrator/src/harness/adapters/opencode.ts`
   (Path C): delegates `invoke` to the runner; ISO-8601 timeout (5 min
   default); exit0+streamError+empty-stdout treated as failure.
4. **Operator runbook** — `docs/operations/opencode-harness.md` + nav
   entry; `adapter-authoring.md` updated; RFC-0010 v23 row, non-goals,
   §13.2/§13.3.
5. **Contrib runner** — `contrib/runners/opencode/` (`runner.mjs` +
   README + metadata.yaml), mirroring the `contrib/adapters/`
   convention.

## Validation

- Full suite: 4846 pass / 0 fail (209 files, 2 skipped);
  `tsc --noEmit` clean; eslint clean; `pnpm build` green.
- Runner tests 40/40 (incl. dispatch-config helpers); adapter tests
  16/16.
- Contrib runner E2E in a scratch repo's linked worktree: success path
  (JSON result, sessionID, filesChanged, commitSha, token export),
  fail-fast, retry-on-failure (`attempts: 2`, exit 1) — main clone
  untouched in all cases.
- Live in-repo smoke on `qwen/qwen3.8-27b` (LM Studio): exact expected
  reply, session export `idle/succeeded`, zero git side effects.

## Follow-ups (flagged, non-blocking)

- [ ] Engine rewiring to consume opencode telemetry JSONL (the engine
  currently reads Claude-shaped telemetry only).
- [ ] force-with-lease carve-out: the opencode plugin skips
  `--force-with-lease*` (the DoD requires lease pushes) while the legacy
  Claude hook denies even lease pushes — reconcile the two semantics.
- [ ] External-path allowance depends on the dispatcher/runner setting
  `AI_SDLC_ACTIVE_TASK_ID`.
- [ ] Worktree dispatch MCP depends on `pnpm build` having run in the
  MAIN clone (AISDLC-385); otherwise re-anchored MCP entries are
  dropped fail-soft.

## Acceptance criteria

- [x] All 5 deliverables land in one PR.
- [x] Full suite green, clean tsc/eslint/build.
- [x] Live local-model dispatch works end to end.
- [x] Repo `opencode.json` / `.opencode/` give dogfood parity for
  interactive in-repo opencode sessions.
<!-- SECTION:DESCRIPTION:END -->
