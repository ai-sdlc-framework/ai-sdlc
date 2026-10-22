---
id: AISDLC-973
title: 'Decision records for the AISDLC-484, 725 and 947 trust impacts, and the attestation reference documents the unverified post-sign backlog edits'
status: Done
assignee: []
created_date: '2026-10-17'
labels:
  - docs
  - governance
dependencies: []
references:
  - docs/operations/attestation-reference.md
  - docs/operations/decision-authority.md
  - pipeline-cli/attestation-core/verify-core.mjs
priority: medium
dispatchable: true
---

## Description

The 2026-10-17 attestation audit found three shipped changes to the trust chain with no decision record: the PR-side lane classifier (AISDLC-484, commit dd4940bb4), delta review leaves (AISDLC-725, commit 0080319f4) and the local-only anchor verification (AISDLC-947). It also found a by-design gap nowhere documented: `backlog/**` and `.ai-sdlc/reviews/**` are excluded from the patch-id and from the attestation-only-descendant diff (`pipeline-cli/attestation-core/verify-core.mjs` line 1806 allowlist), so a task file edited after signing (including `permittedExternalPaths` and `blocked.reason` frontmatter) leaves the envelope valid. Decision authority (DEC-0039, AISDLC-703) requires a record for a change that loosens a control; these were loosenings without one.

**Five-step review (requirements first).**
1. Requirement questioned: do we need records for changes already shipped? Yes: the catalog is the authority other sessions act on, and an audit that finds no record cannot tell a sanctioned loosening from a drift.
2. Delete: nothing.
3. Simplify: three `cli-decisions add` records, each `--governance-change weakening`, each naming the commit, the control weakened and the task that restores it (AISDLC-969, AISDLC-970), answered by the operator; one paragraph in `docs/operations/attestation-reference.md` under "What the envelope does not prove" listing the excluded paths and why.
4. Accelerate: nothing.
5. Automate: the governance-gate already refuses a weakening without a record for new PRs; nothing further.

## Acceptance Criteria

- [ ] Three decision records exist on main for AISDLC-484, AISDLC-725 and AISDLC-947, tagged as weakenings, each naming the restoring task.
- [x] `docs/operations/attestation-reference.md` documents that post-sign edits under `backlog/**` and `.ai-sdlc/reviews/**` are not covered by the envelope, and why.
- [x] `backlog-drift` and the DoR check pass.

## Final Summary

## Summary
Added three weakening decision records (DEC-0270 for AISDLC-484, DEC-0271 for AISDLC-725, DEC-0272 for AISDLC-947) and a 'What the envelope does not prove' section in attestation-reference.md. The section says edits under backlog/** and .ai-sdlc/reviews/** after signing are not covered by the envelope, and explains why. Draft PR opened.

## Changes
- docs/operations/attestation-reference.md
- .ai-sdlc/_decisions/events/2026-10-22T19-01-05.543Z__DEC-0270__decision-opened__c2567ec014df.json
- .ai-sdlc/_decisions/events/2026-10-22T19-01-44.735Z__DEC-0271__decision-opened__40b3222a007e.json
- .ai-sdlc/_decisions/events/2026-10-22T19-02-35.709Z__DEC-0272__decision-opened__83c0ff1fe254.json
- backlog/tasks/AISDLC-973 - decision records and reference doc for the attestation audit findings.md

## Design decisions
AC1 is only partly met. The three records exist but are still open. The developer role may not run `cli-decisions answer`, so dispatch or the operator must answer them. A weakening record also needs `--autonomous-fallback`, which the developer role is barred from using, so none carries a fallback. Each record names its restoring task: AISDLC-969 for DEC-0270, AISDLC-970 for DEC-0271 and DEC-0272. The task asked for a section under 'What the envelope does not prove', but the doc had no such heading, so I created it. I ran only `prettier --check` on the changed files, `backlog-drift check` (no errors) and the DoR check (warnings only). I skipped the full build, test and lint because the diff is docs plus decision event JSON. The pre-push hook passed. The pre-push task-move step found no `AISDLC-973` file in `backlog/tasks/` and skipped, so the task file was not moved to `backlog/completed/`.

## Verification
- `pnpm build` — skipped
- `pnpm test` — skipped
- `pnpm lint` — skipped
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

