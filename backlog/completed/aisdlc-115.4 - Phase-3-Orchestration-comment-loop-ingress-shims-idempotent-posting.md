---
id: AISDLC-115.4
title: 'Phase 3: Orchestration + comment loop (ingress shims + idempotent posting)'
status: Done
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-3
  - orchestration
  - comments
milestone: m-3
dependencies:
  - AISDLC-115.3
parent_task_id: AISDLC-115
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#52-ingress-shims
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#62-comment-format-and-idempotency
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wires Stage A+B verdicts into the actual issue lifecycle via two ingress shims (GitHub Action + Claude Code subagent). Per RFC §12 Phase 3 + §5.2 + §6.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GitHub Action ingress shim wired to `issues.opened` + `issues.edited` + `pull_request` events touching `backlog/tasks/*.md`
- [x] #2 Claude Code subagent ingress shim (refinement-reviewer) invokable from `/ai-sdlc execute` when a backlog task is created in-session
- [x] #3 Status transitions: `Draft` → `To Do` triggers DoR; failed DoR → `Needs Clarification`; author edit → re-check → admit on pass
- [x] #4 Comment posting is idempotent (HTML marker `<!-- ai-sdlc:dor-comment -->` per RFC §6.2)
- [x] #5 Dual-fanout per Q5: comments go to author channel AND optional dedicated channel simultaneously
- [x] #6 Two-stage staleness per Q6: warn at 14d, auto-close at 28d (configurable via `dor-config.yaml`)
- [x] #7 E2E test: vague issue created → DoR comment posted → author edits → re-check → admitted as ready
- [x] #8 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 3: wires Stage A+B verdicts into the issue lifecycle via two ingress shims (GitHub Action + Claude Code subagent), idempotent comment posting via `<!-- ai-sdlc:dor-comment -->` marker (per-channel scoped for dual-fanout), `Promise.allSettled` partial-failure isolation in `fanoutPost`, two-stage staleness state machine (warn 14d / close 28d) configurable via `.ai-sdlc/dor-config.yaml`, and dedicated CLI subcommands `dor-render-comment` + `dor-render-pr-summary` that route ALL author-derived strings through `redactSecrets()` (closes AISDLC-127).

## Iteration history
- **Round 1** (commit `f868930`): all 8 ACs met. 1 MAJOR — workflow inline JS composer didn't redact secrets (concrete exploit via gate-3 reference text).
- **Round 2** (commit `f1fb186`): MAJOR closed via subcommand approach (preferred by both reviewers). Pagination via `github.paginate` + `Promise.allSettled` fanout. Reviews: code 0c/0M/0m/2s; test 0c/0M/0m/2s; security 0c/**1c**/1m/1s — security found a NEW critical: shell injection via filename in `node -e`.
- **Inline fix** (this commit): Round 2's critical addressed inline (env var + readFileSync pattern, exact remediation suggested by reviewer). Avoided burning a 3rd iteration on a 2-line YAML fix the reviewer pre-spec'd.

## Verification
- pnpm --filter @ai-sdlc/pipeline-cli test — 622 tests pass
- 3 reviews APPROVED post-inline-fix: code 0c/0M/0m/2s; test 0c/0M/0m/2s; security 0c/0M/1m/1s (the critical was addressed inline; remaining minor is a defense-in-depth temp-path scoping suggestion)

## Follow-up (file as new tasks if desired)
- Verdict temp paths could be scoped per `${{ github.run_id }}` (defense-in-depth on shared runners)
- `fanoutPost` error-message capture could route through `redactSecrets()` (defense-in-depth — bodies already redacted)
- The 2 deferred round-1 minors (shell quoting elsewhere, exit-code semantics docs) — covered partially by this critical fix
- AISDLC-115.5 (Phase 4 PPA composition) is now unblocked
<!-- SECTION:FINAL_SUMMARY:END -->
