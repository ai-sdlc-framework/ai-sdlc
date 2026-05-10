---
id: AISDLC-245
title: >-
  Plugin adoption gap — bundle pipeline-cli + scripts + scaffold for adopter
  repos
status: To Do
assignee: []
created_date: '2026-05-08 12:10'
labels:
  - bug
  - adoption
  - plugin
  - p0
  - dogfood
dependencies: []
priority: high
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/package.json
  - ai-sdlc-plugin/scripts/
  - ai-sdlc-adoption-gap.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The plugin's slash command body (`ai-sdlc-plugin/commands/execute.md` and
sibling commands) was written against the framework dev-repo's monorepo layout.
Adopters who install the plugin in another project get the slash commands but
NOT the supporting `pipeline-cli` package, scripts, or hooks the slash command
body invokes. Result: every `/ai-sdlc execute` step that reaches a missing
binary either errors out or fails open to a degraded path.

## Witnessed adoption attempt (2026-05-08)

Operator installed `ai-sdlc-plugin@0.8.1` in an adopter project (`arc-1`).
What worked:

- Subagents (developer, code-reviewer, test-reviewer, security-reviewer) — present via Agent tool
- `mcp__plugin_ai-sdlc_ai-sdlc__task_edit / task_complete` — wired
- Plugin's `sign-attestation.mjs` — at `~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.8.1/scripts/`
- `gh` and `git worktree` — environmental, available
- Backlog task file (`arc-1`) — present

What broke (8 surfaces):

| Step    | Missing surface                                | Behavior in adopter repo                                                       |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| 0       | `./scripts/check-orchestrator-state.sh`        | doesn't exist — Step 0 self-heal silently skips                                |
| 0.5     | `pipeline-cli/bin/ai-sdlc-pipeline.mjs`        | not vendored — execute umbrella never runs                                     |
| 1.5     | `pipeline-cli/bin/cli-deps.mjs preflight`      | not vendored — fails open per spec, no dependency safety                       |
| 2       | `ai-sdlc-plugin/scripts/compute-slug.mjs`      | relative path can't resolve from adopter cwd                                   |
| 7a      | `pipeline-cli/bin/cli-classify-pr.mjs`         | not vendored — falls open to all 3 reviewers                                   |
| 7a-bis  | `pipeline-cli/bin/cli-incremental-decide.mjs`  | not vendored — first push falls through to FULL review                         |
| 11a     | `husky` + `scripts/check-attestation-sign.sh`  | husky uninstalled, hook script absent — auto-sign won't fire                   |
| config  | `.ai-sdlc/pipeline-backlog.yaml`               | adopter has `.ai-sdlc/pipeline.yaml`, different schema — branch pattern source |

## Root cause

The plugin ships ONLY commands + scripts + agents. The pipeline-cli helpers
live in the framework monorepo (`pipeline-cli/` workspace package) and are
never published or shipped to adopters. The init wizard creates `.ai-sdlc/`
configs but doesn't address pipeline-cli reachability.

## Decision (operator, 2026-05-08)

**Distribution model: bundle `@ai-sdlc/pipeline-cli` as a plugin npm dep.**

The plugin's `package.json` declares `@ai-sdlc/pipeline-cli` as a runtime
dependency. The init scaffold runs the appropriate `npm install` /
`pnpm install` step in the adopter repo. CLI bins resolve via
`node_modules/.bin/cli-*` rather than relative monorepo paths.

Rejected alternatives (captured for context):

- **Vendor scripts via /ai-sdlc init** — self-contained but stale on plugin upgrade
- **npx-on-demand from registry** — slower first-call, requires network at runtime
- **RFC it first** — plugin-distribution choice is operator-decided, no semantic ambiguity worth deferring

## Phased implementation

This task is the parent. Five sub-tasks (AISDLC-245.1 through 245.5) cover
the work along orthogonal axes:

- **245.1** — Publish + bundle `@ai-sdlc/pipeline-cli` as plugin npm dep
- **245.2** — Vendor shell scripts (`scripts/check-orchestrator-state.sh`, `scripts/check-attestation-sign.sh`, etc.) via `/ai-sdlc init`
- **245.3** — Husky bootstrap in `/ai-sdlc init` (install husky, write `.husky/pre-push` hook chain)
- **245.4** — Path resolution: rewrite slash command body to use plugin-resolved paths (no relative `./scripts/` or `pipeline-cli/bin/` references)
- **245.5** — Schema reconciliation: `.ai-sdlc/pipeline-backlog.yaml` vs adopter's `.ai-sdlc/pipeline.yaml` — pick canonical, document migration, update all readers

## Acceptance Criteria

- [ ] #1 All 5 sub-tasks (AISDLC-245.1 through 245.5) reach Done
- [ ] #2 Fresh adopter repo install: `ai-sdlc-plugin install` + `/ai-sdlc init` + `/ai-sdlc execute <task-id>` runs end-to-end without ANY of the 8 missing-surface errors above
- [ ] #3 Adopter validation runbook at `docs/operations/adopter-onboarding.md` documents the install + first-task flow
- [ ] #4 Plugin's `package.json` declares the runtime dependency on the published `@ai-sdlc/pipeline-cli` version (pin to a specific version, not `*`)
- [ ] #5 The framework dev-repo continues to work (no regressions for self-dogfood — this PR's CI proves it)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 All 5 sub-tasks (AISDLC-245.1 through 245.5) reach Done
- [ ] #2 Fresh adopter repo: install + init + execute end-to-end works without missing-surface errors
- [ ] #3 Adopter onboarding runbook at docs/operations/adopter-onboarding.md
- [ ] #4 Plugin package.json declares pinned @ai-sdlc/pipeline-cli runtime dep
- [ ] #5 Framework dev-repo self-dogfood continues working — no regressions
<!-- SECTION:ACCEPTANCE:END -->
