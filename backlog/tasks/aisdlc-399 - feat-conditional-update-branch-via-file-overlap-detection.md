---
id: AISDLC-399
title: 'feat(ci): conditional update-branch — skip rebase + CI re-run when queued PRs are file-disjoint'
status: To Do
labels: [ci, merge-queue, throughput, operator-merge]
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - CLAUDE.md
priority: high
permittedExternalPaths: []
---

## Description

GitHub merge queue's `Update branches in merge queue` setting forces a full rebase + CI re-run before each merge (~10-15 min per PR), serializing throughput. Operator architectural review (2026-05-23) identified this as a major operator-merge choke point: 5 queued PRs = 50-75 min of pure CI wait time even after AISDLC-398's content-addressed envelopes eliminate v4-kick.

The fix: a GitHub Actions workflow that runs on `pull_request.synchronize` events (when the queue is about to update-branch), computes the touched-file set of the PR being processed AND of all currently-queued PRs, and:
- **Disjoint** (no overlap with queued PRs): post a status check that GH merge queue treats as "skip update-branch" via the `merge_group` event short-circuit. Merge proceeds in ~30 sec.
- **Overlapping** (any queued PR touches a shared file): let GH's normal update-branch flow run. ~10-15 min, but skew is correctly prevented.

Pragmatic approach matching Google's TAP design without requiring Bazel — files are the unit of overlap, not build targets.

## Acceptance criteria

- [ ] AC-1: New workflow `.github/workflows/merge-queue-skew-gate.yml` triggers on `merge_group` event, computes touched-file set of current PR via `git diff --name-only <base>..<head>`, queries other open PRs via GH API for their touched-file sets, computes overlap.
- [ ] AC-2: When no overlap: workflow short-circuits with `merge-queue-skew-gate: success` status check + a comment annotating the bypass. Configure GH merge queue rules to allow merge when this check is success even without a fresh CI re-run.
- [ ] AC-3: When overlap detected: workflow exits with `merge-queue-skew-gate: pending` (or skip), letting GH's default update-branch + CI re-run flow run. Posts a comment naming the overlapping PR(s) for transparency.
- [ ] AC-4: Excluded files: `.ai-sdlc/attestations/**`, `pnpm-lock.yaml`, `CHANGELOG.md`, `backlog/tasks/**`, `backlog/completed/**`, `.ai-sdlc/verdicts/**` are NOT counted as overlap (these are mechanical fixup files that don't represent real code conflicts).
- [ ] AC-5: Edge case: when the current PR is the ONLY one in queue, default to short-circuit (no overlap possible).
- [ ] AC-6: Edge case: when overlap detection itself fails (API error, malformed diff), default to full update-branch (fail-safe to safety).
- [ ] AC-7: Hermetic test at `.github/workflows/__tests__/merge-queue-skew-gate.test.mjs` validates the overlap algorithm with fixture file-set inputs (disjoint, single overlap, multi-overlap, exclusion patterns).
- [ ] AC-8: Operator runbook section in `docs/operations/merge-queue-skew-gate.md` documenting: when the gate fires, how to override (force update-branch via PR label), how to interpret the comment annotations.
- [ ] AC-9: CLAUDE.md update under "CI behavior" — note that update-branch is now conditional + reference the runbook.
- [ ] AC-10: Reference AISDLC-398 (content-addressed envelopes) as the prerequisite that made this safe (envelopes survive rebase, so even when overlap-driven rebase fires we don't v4-kick).

## Out of scope

- Replacing the GH merge queue with a custom queue (e.g. Bors). Defer.
- Per-file-line overlap detection. Files are the unit; finer is overkill.
- Adapting to GH ruleset changes that may require enterprise plan.

## References

- AISDLC-398 (content-addressed envelopes) — prerequisite
- PR #626 v4-kick incident
- Google TAP design (file-level overlap heuristic)

## Estimated effort

2-3 days.
