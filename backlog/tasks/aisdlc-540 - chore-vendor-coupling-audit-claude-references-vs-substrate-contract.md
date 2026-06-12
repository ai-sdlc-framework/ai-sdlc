---
id: AISDLC-540
title: >-
  chore(neutrality): vendor-coupling audit — inventory claude-specific
  references in core paths against the substrate contract and close the
  mechanical cases
status: To Do
assignee: []
labels:
  - adoption
  - architecture
  - substrate
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - spec/adapters.md
  - scripts/check-substrate-contract.mjs
  - docs/operations/copilot-spawner.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-06-12 repo review measured 596 case-insensitive `claude` references
across 103 non-test source files in `orchestrator/src` and `pipeline-cli/src`.
The project's positioning is vendor-neutral, and the substrate seam exists
(spawner kinds `codex`/`copilot`, the runner-registry seam from AISDLC-529, the
config-driven source-control adapter from AISDLC-530, and the substrate
contract enforced by `scripts/check-substrate-contract.mjs`) — but no inventory
distinguishes which of those 596 references are (a) legitimately inside the
Claude Code adapter/plugin layer, (b) default values that belong in config,
(c) hardwired into core orchestration paths that the substrate contract should
cover but does not yet.

Deliverable: classify the full inventory into those three buckets, fix bucket
(b) mechanically (move defaults into config/adapter modules), and produce a
file-level gap list for bucket (c) so the remaining neutrality work is
enumerable instead of folklore. Bucket (c) items are NOT to be fixed in this
task — they get listed with file/line evidence in the audit report committed
under `docs/audits/`, and any follow-up tasks are filed by the operator, not by
the implementing agent (scope-creep rule AISDLC-308).

Out of scope: `ai-sdlc-plugin/` (it IS the Claude Code pillar by definition),
test files, docs, and the spawner bridges that already isolate per-vendor
behavior behind env-var seams.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A committed audit report under `docs/audits/` classifies every `claude` reference in `orchestrator/src` and `pipeline-cli/src` (non-test) into adapter-layer / config-default / core-coupling buckets, with counts and file paths
- [ ] #2 Config-default bucket closed: vendor-specific defaults moved behind existing config or adapter seams; behavior unchanged when the configured substrate is Claude Code (existing tests stay green)
- [ ] #3 Core-coupling bucket enumerated as a gap list with file/line evidence and a one-line proposed seam per entry — no implementation, no new backlog tasks filed by the agent
- [ ] #4 `scripts/check-substrate-contract.mjs` (or its config) extended so at least the newly-cleaned config-default class cannot silently regress
- [ ] #5 Full verification passes: `pnpm build`, affected package tests, `pnpm lint`
<!-- AC:END -->
