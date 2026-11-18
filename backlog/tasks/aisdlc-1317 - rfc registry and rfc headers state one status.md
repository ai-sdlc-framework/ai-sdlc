---
id: AISDLC-1317
title: 'RFC registry and RFC headers state one status'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - rfc
dependencies: []
references:
  - spec/rfcs/README.md
  - scripts/check-rfc-registry.mjs
  - scripts/check-rfc-registry.test.mjs
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-lifecycle-transitions.mjs
  - .claude/rules/rfcs.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
assumes:
  - RFC-0009
  - RFC-0017
  - RFC-0035
priority: low
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: "file those docs tasks", after the planner''s audit of completed RFCs against the published documentation. Every disagreement below was read on `main` at b56cecaee on 2026-11-18 by comparing, for each of the 57 RFC files, the frontmatter `status` and `lifecycle`, the first `**Status:**` line of the body and the row of the Registry in `spec/rfcs/README.md`. `node scripts/check-rfc-registry.mjs` passes on that commit because it compares the Lifecycle cell only.'
---

## Description

**Gap.** An RFC states its position in four places: frontmatter `status`, frontmatter `lifecycle`, the `**Status:**` line of the body, and the Status and Lifecycle cells of its Registry row (which the website renders as the RFC registry). `spec/rfcs/README.md` line 160 makes the frontmatter the source of truth and the body line "informational only". `scripts/check-rfc-registry.mjs` (AISDLC-987) compares the Lifecycle cell with the frontmatter (lines 51 to 54) and nothing else, so the other places drifted. The completed task AISDLC-1223 (operator ruling of 2026-11-07) set `status: Implemented` on the RFCs it found shipped with no open question, and did not touch their body lines.

### Registry Status cell differs from frontmatter `status`

| RFC | README line | Status cell | Frontmatter `status` |
|---|---|---|---|
| RFC-0025 | 375 | Draft | Implemented |
| RFC-0041 | 391 | Draft | Implemented |
| RFC-0042 | 392 | Approved | Superseded |
| RFC-0059 | 410 | Signed Off | Approved |
| RFC-0061 | 412 | Signed Off | Implemented |

Correction to the audit: the row of RFC-0047 (line 397) says Draft because the frontmatter says `status: Draft`; the disagreement is inside the file (next table).

### Body `**Status:**` line differs from the frontmatter

| RFC | Body line | Body says | Frontmatter `status` / `lifecycle` |
|---|---|---|---|
| RFC-0009 | 28 | Ready for Review v3.4 | Implemented / Implemented |
| RFC-0010 | 30 | Draft v1, pending review | Implemented / Implemented |
| RFC-0016 | 39 | Ready for Product owner sign-off | Implemented / Implemented |
| RFC-0019 | 29 | Ready for Review v0.3 | Implemented / Implemented |
| RFC-0022 | 27 | Ready for Review v0.2 | Implemented / Implemented |
| RFC-0035 | 44 | Draft (v0.2) | Implemented / Implemented |
| RFC-0042 | 37 | Approved | Superseded / Superseded (line 35 already says superseded by RFC-0061) |
| RFC-0061 | 20 | Signed Off (v0.3) | Implemented / Implemented |
| RFC-0047 | 17 | Signed Off (2026-09-06) | Draft / Signed Off |
| RFC-0017 | 22 | Signed Off v0.4 | Draft / Ready for Review |

RFC-0035 and RFC-0017 were not in the audit's list; they were found by the same comparison.

### Registry notes and summary lists that contradict the row

- Notes cell of RFC-0024 (line 374): "lifecycle rolled back from `Implemented` to `Ready for Review` ... flips back to `Implemented` after Refit Phase 6 (AISDLC-278) ships". The row says Implemented, and `backlog/completed/` holds the AISDLC-278 task.
- Notes cell of RFC-0035 (line 385): "Lifecycle promoted Draft to Ready for Review; awaits per-owner sign-off". The row says Implemented.
- Notes cell of RFC-0025 (line 375): "AISDLC-270 / PR #481 paused ... audit pending"; of RFC-0009 (line 359): "Product v3.4 sign-off pending"; of RFC-0010 (line 360): "Legacy `status: Draft` retained". Each row says Implemented.
- Section "Open Questions Inventory", lines 510, 512 and 513: RFC-0009, RFC-0024 and RFC-0035 "Lifecycle: Ready for Review"; line 531: RFC-0023 "Lifecycle: Signed Off" (frontmatter: Implemented).
- Section "Critical-path status table", lines 605, 607, 608 and 610: the same four RFCs with the same stale lifecycles.

### Not settled by the evidence in the repository

- RFC-0017: the body claims all three sign-offs (2026-05-26, one conditional) while the frontmatter is Draft / Ready for Review.
- RFC-0023: `status: Approved` with `lifecycle: Implemented` (the mapping guide of README lines 84 to 90 pairs Implemented with `Implemented` or `Final`), and the TUI was retired by operator decision on 2026-10-13.
- RFC-0041: `lifecycle: Implemented`, while `docs/concepts/session-hierarchy.md` line 8 calls it "historical, superseded" by RFC-0051; the RFC file does not say so.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: are four places needed? The README keeps the body line for human readers and the Registry is the public view, so they stay; they must repeat the frontmatter, never state a position of their own. 2. Deleted: the stale clauses of the notes cells are removed, not kept beside a correction. 3. Simplified or optimised: the frontmatter is not re-decided here; where the frontmatter itself is in doubt the RFC goes to the operator. 4. Accelerated: `check-rfc-registry.mjs --write` already rewrites stale cells; it gains the Status cell. 5. Automated: the existing registry check, already part of `pnpm rfc:check`, fails on the two disagreements it does not compare today.

- **Rules that apply** (`.claude/rules/rfcs.md`, `spec/rfcs/README.md`): the lifecycle ladder is changed only through the lifecycle gate, so this task changes no `lifecycle:` value. No Open Question is resolved, no `**Resolution:**` or `RESOLVED:` marker is added, and no text inside an Open Questions section is edited.
- **Registry Status cells.** Set the five cells of the first table to the frontmatter value (by `--write` once the check below exists).
- **Body lines.** For RFC-0009, 0010, 0016, 0019, 0022, 0035 (evidence: the operator ruling of 2026-11-07 recorded in the completed task AISDLC-1223, which names each of them), RFC-0042 (evidence: line 35 of the file and RFC-0061) and RFC-0061 (evidence: its frontmatter with `runtimeEvidence`, and the completed task AISDLC-1173): the `**Status:**` line begins with the frontmatter `lifecycle` value, and the former text is kept on the same line after "Previously:". Nothing else in those files changes.
- **RFC-0047.** Set `status: Approved`, the value the mapping guide gives for `lifecycle: Signed Off` (evidence: the sign-off dated 2026-09-06 on line 17 and the `lifecycle` field). Run `node scripts/check-rfc-docs.mjs` afterwards: `Approved` is an enforced status and the RFC declares `requiresDocs: []`. Then regenerate its Registry row.
- **Notes and summary lists.** In the five notes cells remove or reword the clause that contradicts the row, citing the completing task where one is named. In the Open Questions Inventory and the critical-path table set the lifecycle of RFC-0009, 0023, 0024 and 0035 to the frontmatter value and drop the "awaiting" clause that no longer holds.
- **For the operator, not decided here.** RFC-0017, RFC-0023 and RFC-0041: change nothing in the files; list each in the PR body with the two statements that disagree and the evidence found. Any other RFC whose evidence does not settle its status when the work starts is listed the same way.
- **Check.** `scripts/check-rfc-registry.mjs`: (a) the Status cell (`cells(line)[3]`) must equal frontmatter `status`; `--write` fixes it as it fixes the Lifecycle cell; (b) the first line of the RFC body that starts with `**Status:**` must continue with the frontmatter `lifecycle` or `status` value; an RFC without such a line passes. RFCs left to the operator whose body line fails (b) go into an exported set `BODY_STATUS_KNOWN`, with the reason in a comment; an id in the set that passes (b) is an error, so the set only shrinks. Error lines name the RFC, the place and both values.
- **Tests.** `scripts/check-rfc-registry.test.mjs`: a stale Status cell fails and `--write` repairs it; a body line that disagrees fails; a body line that starts with the `status` value passes; an RFC with no body line passes; a `BODY_STATUS_KNOWN` entry that no longer fails is an error.
- **Stop rule.** If aligning a body line or a cell would require changing a `lifecycle:` value, or the completed tasks do not show the work an `Implemented` claim rests on, do not edit that RFC: list it for the operator.

Out of scope: any `lifecycle:` change; RFC text other than the `**Status:**` line and the `status:` field of RFC-0047; the lifecycle-transition gate; `requiresDocs`; whether `status` and `lifecycle` should become one field.

## Acceptance Criteria

- [ ] #1 `node scripts/check-rfc-registry.mjs` fails, naming the RFC and both values, when a Registry Status cell differs from frontmatter `status`; `--write` repairs the cell; tests assert both.
- [ ] #2 The same command fails when the first `**Status:**` body line of an RFC starts with neither its frontmatter `lifecycle` nor its `status` value, and passes for an RFC without such a line; tests assert the three cases.
- [ ] #3 `BODY_STATUS_KNOWN` contains only RFCs that the PR body lists for the operator, and an entry that no longer fails is an error; a test asserts it.
- [ ] #4 The Status cells of RFC-0025, 0041, 0042, 0059 and 0061 equal the frontmatter `status` of their files.
- [ ] #5 The `**Status:**` line of RFC-0009, 0010, 0016, 0019, 0022, 0035, 0042 and 0061 starts with the frontmatter `lifecycle` value and keeps the former text after "Previously:"; `git diff` shows no other changed line in those eight files.
- [ ] #6 RFC-0047 has `status: Approved` and no other changed line; its Registry row matches.
- [ ] #7 `git diff origin/main -- spec/rfcs | grep -E "^[+-]lifecycle:"` prints nothing, and the diff adds no line containing `**Resolution:**` or `RESOLVED:`.
- [ ] #8 In `spec/rfcs/README.md`, the notes cells of RFC-0009, 0010, 0024, 0025 and 0035, lines 510 to 513 and 531, and the critical-path table no longer state a lifecycle or a pending step that the row contradicts.
- [ ] #9 The PR body has one row per RFC touched (place corrected, old value, new value, evidence) and a list "for the operator" with RFC-0017, RFC-0023, RFC-0041 and any other RFC left unchanged, each with the two statements that disagree.
- [ ] #10 `pnpm rfc:check` and `pnpm rfc:test` pass; the diff has at most 15 files.
- [ ] #11 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
