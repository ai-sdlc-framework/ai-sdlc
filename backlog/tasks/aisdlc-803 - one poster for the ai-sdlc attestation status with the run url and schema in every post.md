---
id: AISDLC-803
title: >-
  One poster for the `ai-sdlc/attestation` commit status: every post carries the
  run URL and schema version, stale posts are overwritten by the verifier, and
  the gate reads the verifier's run, not the bare status
status: To Do
assignee: []
created_date: '2026-10-10'
updated_date: '2026-10-13 20:39'
labels:
  - attestation
  - ci
  - stability
  - root-cause
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/untrusted-pr-gate.yml
  - scripts/verify-attestation.mjs
priority: medium
drift_log:
  - date: '2026-10-13'
    type: ref-deleted
    detail: 'Referenced file no longer exists: .github/workflows/isolated-review.yml'
    resolution: flagged
drift_checked: '2026-10-13'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10, 20:27-20:37 UTC, PR #1330 / AISDLC-791).** The `AI-SDLC Verify Review Attestation` run on head f069e78e succeeded at 20:27, yet at 20:37 an `ai-sdlc/attestation: failure — contentHashV4 mismatch` status was posted on the same head with the PR page as its target URL, so neither dispatch nor the planner could tell which workflow posted it. `Attestation gate (code PRs)` reads the bare status and went red; the task was resumed for a full re-sign on a guess. Five workflows can post this context (`verify-attestation`, `ai-sdlc-gate`, `ai-sdlc-review`, `untrusted-pr-gate`, `isolated-review`) and the legacy v4 verifier path still posts the v4 reason.

**Root cause.** Several posters share one status context with no ordering, no provenance in the post, and no rule that the newest verifier result wins.

**Five-step review (requirements first).** The deletion IS the fix: five posters of one status context become one, and the `Attestation gate (code PRs)` job stops reading a commit status at all; it depends on the verify job's result inside the same rollup. With that, items 2 and 3 shrink to "the verify job's single post carries its run URL" and the status becomes informational for humans only. Do not add a resolution algorithm for stale statuses; delete the indirection.

**Fix.**
1. Exactly one workflow posts `ai-sdlc/attestation` for a head: `verify-attestation.yml`. Every other workflow that posts it today either stops (if its post is redundant) or posts under its own context (`ai-sdlc/attestation-review`, `ai-sdlc/attestation-untrusted`); list each poster and its disposition in the PR body. The `merge_group` docs-only short-circuit post stays until AISDLC-388 AC-4 removes it.
2. Every post sets `target_url` to the posting run's URL and a `description` of the form `<status> | v<schema> | <reason> | run <id>`; the verifier script exposes the schema version it judged.
3. `Attestation gate (code PRs)` resolves the newest `verify-attestation` run for the head and uses its conclusion; it treats a status whose `target_url` is not a workflow run as unknown (re-dispatch the verifier) rather than failure.
4. Hermetic workflow tests: only one workflow contains a post to the `ai-sdlc/attestation` context on `pull_request`; the gate's resolution logic is unit-tested with stubbed API responses.

**Velocity impact.** Positive: a red attestation status becomes self-explaining and cannot be a stale or foreign post; no change to what the verifier accepts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] A workflow test asserts that exactly one workflow posts the `ai-sdlc/attestation` context on `pull_request` events; the other posters are removed or renamed as documented in the PR body.
- [ ] Every post carries the posting run's URL as `target_url` and the schema version and reason in `description`.
- [ ] The attestation gate job reads the newest verifier run's conclusion and treats a non-run-targeted status as unknown; unit-tested with stubs.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 7 of the 2026-10-10 root-cause set. First hit: AISDLC-791 (#1330).
