---
id: AISDLC-973
title: 'Decision records for the AISDLC-484, 725 and 947 trust impacts, and the attestation reference documents the unverified post-sign backlog edits'
status: To Do
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
- [ ] `docs/operations/attestation-reference.md` documents that post-sign edits under `backlog/**` and `.ai-sdlc/reviews/**` are not covered by the envelope, and why.
- [ ] `backlog-drift` and the DoR check pass.
