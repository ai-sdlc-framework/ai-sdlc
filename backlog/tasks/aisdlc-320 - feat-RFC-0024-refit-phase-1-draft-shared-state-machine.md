---
id: AISDLC-320
title: 'feat: RFC-0024 Refit Phase 1 — Draft → Shared state machine + tiered deletion'
status: To Do
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0024
  - emergent-capture
  - refit
  - phase-1
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - pipeline-cli/src/capture/capture-writer.ts
  - pipeline-cli/src/cli/capture.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0024 Refit Phase 1. Closes the gap between the 2026-05-13 first-pass resolution (team-shared direct write to `$ARTIFACTS_DIR/_captures/`) and the 2026-05-15 revised resolution (OQ-1 + OQ-7).

## Why a refit

AISDLC-269 shipped against the 2026-05-13 first-pass OQ resolutions. The 2026-05-15 walkthrough revised OQ-1 from "team-shared direct" to the Linear-style Draft → Shared state machine because team-visibility friction recreates the "half-formed thought" failure mode §2.2 explicitly names. The shipped capture-writer needs to be retrofitted; the existing surface is preserved as the "submit" path.

## Scope (OQ-1 + OQ-7)

- New draft location: `.ai-sdlc/captures-drafts/<id>.md` (operator-local, gitignored).
- New submitted location: `backlog/captures/<id>.md` (team-shared, git-tracked, replaces the existing `$ARTIFACTS_DIR/_captures/` path).
- `cli-capture submit <id>` transitions draft → submitted (writes new file, removes draft).
- `cli-capture submit-all` bulk transition.
- `cli-capture discard <id> --reason <text>` (OQ-7 tiered deletion — drafts only; submitted captures still go through `redact`).
- AI-agent captures honor draft/shared via OQ-2's threshold gate (high-confidence → auto-submit; low-confidence → draft).
- Backward-compat shim: existing captures in `$ARTIFACTS_DIR/_captures/` remain readable by `cli-capture list` for one minor version; migration tool `cli-capture migrate-legacy` moves them into `backlog/captures/`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-capture file` writes new captures to `.ai-sdlc/captures-drafts/<id>.md` by default
- [ ] #2 `.ai-sdlc/captures-drafts/` added to `.gitignore`
- [ ] #3 `cli-capture submit <id>` moves draft → `backlog/captures/<id>.md`
- [ ] #4 `cli-capture submit-all` bulk transition with summary output
- [ ] #5 `cli-capture discard <id> --reason <text>` hard-deletes drafts only (refuses on submitted captures with pointer to `redact`)
- [ ] #6 AI-agent capture path auto-submits when confidence ≥ threshold (OQ-2 gate; threshold from capture-config.yaml)
- [ ] #7 Backward-compat: legacy `$ARTIFACTS_DIR/_captures/` captures remain readable by `cli-capture list`
- [ ] #8 `cli-capture migrate-legacy` tool moves legacy captures to `backlog/captures/`
- [ ] #9 Existing tests pass with new paths; new tests cover draft/submit/discard/migrate flows
<!-- AC:END -->
