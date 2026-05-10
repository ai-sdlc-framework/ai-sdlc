---
id: AISDLC-248
title: Release readiness + project repositioning (beyond "governance")
status: To Do
assignee: []
created_date: '2026-05-09 19:30'
labels:
  - release
  - docs
  - positioning
  - p0
dependencies: []
priority: high
references:
  - README.md
  - CLAUDE.md
  - .github/workflows/release.yml
  - spec/rfcs/README.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Why

The project started as "AI-SDLC governance" (review attestations, hooks, gates, no-merge rules). Through the May 2026 sprint it has evolved into a full autonomous AI-SDLC framework that includes:

- **Autonomous orchestrator** (RFC-0015): `cli-orchestrator tick`, dependency-graph composition, dispatchability + blocked + already-in-flight + DoR filters, frontier composition, late-rebase Step 11, worktree mutex, dist-staleness auto-rebuild, recoverable-abort + checkpoint commits
- **Cross-harness review** (RFC-0010 §13 + AISDLC-247 + 202.x): Claude implements / Codex reviews and vice versa; harness-tagged DSSE envelopes; `requiresIndependentHarnessFrom: [implement]` independence enforcement
- **Decision Engine**: frontload questions → DoR → autonomous dispatch
- **Operator TUI** (RFC-0023): pipeline / PR / dep-graph / config / analytics panes
- **Pattern-C worktree isolation**: parent read-only contract, MCP routing for cross-repo writes, Pattern-C-aware `task_create`
- **Adopter framework** (AISDLC-245 family): `/ai-sdlc init` scaffolds the canonical pipeline into adopter repos

Operator (2026-05-09): "We have significantly modified this project. it's no longer just about governance we will have to reflect that change in the website messaging as well as the documentation."

This parent task tracks the release + docs + messaging refresh that must ship before the next public-facing release.

## Phased structure

- **AISDLC-248.1 — Release runbook + cut release** (operator-led npm publish + GitHub release notes; new version across publishable workspaces; release-please / changelog generation if not auto)
- **AISDLC-248.2 — Documentation refresh: README + CLAUDE.md + docs/operations** (rewrite project positioning; update getting-started flow; ensure all shipped capabilities are documented; archive obsolete sections)
- **AISDLC-248.3 — Website messaging update** (positioning copy beyond "governance"; surface autonomous orchestrator + cross-harness review as the headline capabilities; update homepage hero, feature cards, FAQ)

## Hard sequencing
This task GATES on the current backlog reaching zero open PRs. Don't dispatch sub-tasks until the in-flight 235/202.4/415 family + any successor work has merged.

## Acceptance Criteria
<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 All 3 sub-tasks (248.1 release, 248.2 docs, 248.3 website) reach Done
- [ ] #2 Released version ships on npm with all publishable workspace packages bumped consistently
- [ ] #3 README's first 3 paragraphs accurately position the project as an autonomous AI-SDLC framework (not just governance)
- [ ] #4 Operator confirms website messaging matches the new positioning before release announcement
<!-- SECTION:ACCEPTANCE:END -->
<!-- SECTION:DESCRIPTION:END -->
