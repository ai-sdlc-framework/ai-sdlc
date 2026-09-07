---
id: AISDLC-603
title: >-
  Governance: deterministic merge-if-eligible CLI helper (green + CLEAN + trusted sourceKind gate)
status: Done
assignee: []
created_date: '2026-09-07'
labels:
  - plugin
  - governance
  - pipeline-cli
  - adopter
  - rfc-0048
  - phase-3
dependencies:
  - AISDLC-601
references:
  - spec/rfcs/RFC-0048-per-repo-configurable-governance.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**RFC-0048 Phase 3 (OQ-4 resolution).** The green+CLEAN merge gate lives in a
deterministic CLI helper, NOT in LLM-honored command-body prose (per the framework's
"anything mechanical → hook/workflow, never LLM" principle). This task builds that
helper; AISDLC-602 makes it the ONLY merge route (its reconciled hook blocks raw
`gh pr merge`).

## Scope
- Add a `merge-if-eligible <pr>` CLI helper (pipeline-cli or a plugin script — match
  the surrounding runtime conventions) that:
  - resolves the repo's governance policy (AISDLC-601 resolver) from trusted
    base-branch config;
  - if `allowMerge` is `never` (strict default) → refuse (non-zero), do not merge;
  - if `allowMerge: onGreenClean` → check ALL of: every required check green, PR
    `mergeStateStatus == CLEAN`, AND the work item's `sourceKind` is trusted
    (internal `backlog-task`, per OQ-2) — refuse (non-zero) if any fails; merge only
    when all hold.
  - NEVER merge external-sourced work (`gh-issue-N` / contributor PR) regardless of
    green state (OQ-2).
- The green+CLEAN check must query the repo's REAL required checks (verify-attestation,
  migration-mutation-gate, workflow-secret-scope-gate, ci, …) — not a hardcoded subset
  — so opting into agent-merge removes only the "human clicks merge" step, not any
  safety gate.
- Emit a clear, auditable reason on refusal (which condition failed).
- Never write CI-skip tokens; never edit `.ai-sdlc/**` config.

## Acceptance Criteria
- [x] `merge-if-eligible` refuses (non-zero, no merge) under strict `allowMerge: never`.
- [x] Under `allowMerge: onGreenClean` + trusted `sourceKind`: merges only when all
  required checks are green AND `mergeStateStatus == CLEAN`; refuses otherwise with an
  auditable reason.
- [x] External `sourceKind` (gh-issue / contributor PR) is NEVER merged, even green+CLEAN.
- [x] Required-checks set is the repo's real set (not a hardcoded subset).
- [x] Hermetic tests for: strict-refuse; green+CLEAN+trusted → merge; not-green → refuse;
  not-CLEAN → refuse; untrusted-source → refuse.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Phase 3 of RFC-0048. The frontmatter `dependencies` field is authoritative (this task
composes with AISDLC-601's governance resolver + `sourceKind` plumbing; AISDLC-602's
reconciled hook routes all merges through this helper).
