---
id: AISDLC-968
title: 'Attestation envelope and transcript-leaf growth is a measured row in the tooling-limitations register'
status: To Do
assignee: []
created_date: '2026-10-17'
labels:
  - docs
  - observability
dependencies:
  - AISDLC-964
references:
  - pipeline-cli/src/attestation/merkle.ts
  - scripts/verify-attestation.mjs
priority: medium
dispatchable: true
---

## Description

`.ai-sdlc/attestations/` (971 v6 DSSE envelopes) and `.ai-sdlc/transcript-leaves/` (650 files) are committed by design: the attestation gate verifies the envelope and the Merkle leaves from the committed copies, and `merkle.ts` documents the leaves as "committed, never pruned". At the current drain they grow by about 140 files a week (about 7 MB today). Nothing measures that growth or says at what size a clone, a `git status` in eighty worktrees, or the gate's checkout starts to pay for it. The register created by the task this one depends on is where that belongs.

**Five-step review (requirements first).**
1. Requirement questioned: is a pruning policy needed now? No: 7 MB is nothing. What is needed is the number and the floor, so the decision is taken from a measurement when the time comes, not from a stall.
2. Delete: nothing.
3. Simplify: one register row: file count and bytes under the two directories, growth per week from `git log --diff-filter=A`, the floor at which a pruning or archival RFC is opened.
4. Accelerate: `cli-hierarchy status` already prints headroom for instrumented ceilings; add this one by reading the two directories.
5. Automate: the register's consistency test covers the new row like any other.

## Acceptance Criteria

- [ ] `docs/operations/tooling-limitations.md` has a row for attestation and leaf growth with count, size, weekly growth and the floor.
- [ ] `cli-hierarchy status` prints the current count and size.
- [ ] The register test passes with the new row.
