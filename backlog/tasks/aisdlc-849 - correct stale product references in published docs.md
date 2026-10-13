---
id: AISDLC-849
title: Correct stale product references in the published docs (tutorial 08, onboarding, tutorial 10, concepts, PRD, install instructions)
status: To Do
assignee: []
created_date: '2026-10-13'
labels: [docs]
dependencies: [AISDLC-847]
references: [docs/tutorials/08-claude-code-plugin.md, docs/getting-started/onboarding.md, docs/tutorials/10-spec-kit-bridge.md, docs/prd-claude-code-native-integration.md, docs/getting-started/README.md, README.md, ai-sdlc-plugin/CHANGELOG.md, ai-sdlc-plugin/plugin.json, docs/operations/cli-hierarchy.md]
priority: high
dispatchable: true
---

## Description

The 2026-10-13 docs-gap audit of ai-sdlc.io found 13 references in 6 published pages that describe retired or renamed product surfaces. Because the site now renders these files directly (DEC-0001 in `ai-sdlc-io`), the corrections are made here, once. The product facts to write against are in `ai-sdlc-plugin/plugin.json` (hooks, agents, commands, MCP tools), `ai-sdlc-plugin/CHANGELOG.md` (renames and removals) and `docs/operations/cli-hierarchy.md` (RFC-0051 replacement for the Conductor loop).

## Scope

1. `docs/tutorials/08-claude-code-plugin.md`: install step becomes the marketplace flow from `README.md` (`/plugin marketplace add ai-sdlc-framework/ai-sdlc`, `/plugin install ai-sdlc@ai-sdlc`, `/reload-plugins`), not `claude --plugin-dir`; the summary counts ("6 hooks, 5 slash commands, 3 review agents, MCP server with 5 governance tools") are replaced by the current numbers derived from `plugin.json` at the time of writing, stated as "at plugin 0.26.0"; the hooks table drops the removed agent-verification Stop hook and `deferred-coverage-check.js` and lists the current Stop hooks (`usage-ingest`, `context-auto-clear`, `context-warn`, `context-budget`); the blocked-actions row about forced pushes is rewritten to describe `governance.allowForcePush: leaseOnOwnBranch` (CHANGELOG 0.22.0 AISDLC-663, 0.23.0 AISDLC-710); `### /review` becomes `review-pr` (0.11.0 AISDLC-474) and `### /status` becomes `pipeline-status`; the `fix-pr` row notes it chains `cli-fix-ci` and `cli-fix-review`, which do not exist in `pipeline-cli/bin` today, so either the row is removed or `fix-pr` is marked as not shipped (check `ai-sdlc-plugin/commands/fix-pr.md` and decide in the PR).
2. `docs/getting-started/onboarding.md` lines 264, 276, 346, 417 and 608 to 611: replace `/ai-sdlc orchestrator-tick` and the Conductor narrative with the RFC-0051 session hierarchy (`cli-hierarchy up`, `tick`, the planner/dispatch/executor roles) per `docs/operations/cli-hierarchy.md`; state that since 0.19.0 (AISDLC-598) `/ai-sdlc execute` signs the v6 attestation itself rather than a Conductor.
3. `docs/tutorials/10-spec-kit-bridge.md` line 300: same `orchestrator-tick` replacement; line 458: `/ai-sdlc decisions list` becomes the real command `cli-decisions list` (from `@ai-sdlc/pipeline-cli`).
4. `docs/concepts/dor-gate.md` (moved by AISDLC-847): `/ai-sdlc dor-recheck <task-id>` does not exist; replace with the real recheck path (`ai-sdlc-pipeline dor-evaluate` or `cli-dor-check --task`).
5. `docs/concepts/two-tier-pipeline.md` (moved by AISDLC-847): the "open multiple terminals to fan out" paragraph points to the session hierarchy instead.
6. `docs/prd-claude-code-native-integration.md`: add a frontmatter `status: historical` and a one-line banner that it targeted v0.7.0 and the shipped design is documented in tutorial 08 and the concepts pages; do not rewrite its body.
7. `docs/getting-started/README.md`: the plugin install section shows the marketplace flow and states the current plugin version with a pointer to `/ai-sdlc version`.

Out of scope: `docs/operations/` runbooks; RFC frontmatter (AISDLC-850).

## Acceptance Criteria

- [ ] `grep -rn "orchestrator-tick\|Conductor" docs/getting-started docs/tutorials docs/concepts` returns only historical mentions that are explicitly labelled as such (or nothing).
- [ ] `grep -rn "dor-recheck\|/ai-sdlc decisions\|--plugin-dir\|claude plugin install ai-sdlc" docs` returns nothing outside `docs/prd-claude-code-native-integration.md`.
- [ ] Tutorial 08's hooks, commands and agents sections match `ai-sdlc-plugin/plugin.json` and `ai-sdlc-plugin/agents/` at the PR's base commit (reviewer checks by diffing the lists).
- [ ] The PRD carries `status: historical` frontmatter and the banner.
- [ ] Every edited page still passes the site's build (the PR description links a local `pnpm build` of `ai-sdlc-io` against the PR head sha, or the reviewer runs it).
