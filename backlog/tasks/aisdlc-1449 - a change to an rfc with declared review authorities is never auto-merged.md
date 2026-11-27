---
id: AISDLC-1449
title: "A change to an RFC with declared review authorities is never auto-merged"
status: To Do
priority: high
labels:
  - governance
  - merge-gate
  - rfc-process
  - adopter-facing
dependencies: []
assumes:
  - RFC-0001
  - RFC-0018
  - RFC-0049
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/attestation-core/docs-only-paths.mjs
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - scripts/check-rfc-docs.mjs
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0001-template.md
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
---

## Description

**Five-step review (requirements first).**
1. Question: the planner's own RFC PRs auto-merge through the docs lane within minutes, before an outside authority that owns the area has reviewed them:
   - #2970 (RFC-0018 v0.4.1) merged 60s after it was opened, before Design Authority saw it;
   - #3088 (RFC-0049 amendment) merged 4 min after it was opened, before Product and Design saw it.

   Design Authority (Morgan) made it a condition of their RFC-0018 v0.4.1 sign-off that any later change to the accessibility or success-metric rules comes back to Design for review before it merges. The operator chose option b of DEC-0440 on 2026-11-26, through the full rubric. The other direction is already covered: authors `akillies` and `mohirt` are off the reconcile allow-list, so their own PRs wait for a hand merge. Checked: nothing in the merge path reads RFC lifecycle, sign-off rows or authorities today. `spec/rfcs/` is on the docs-lane allow-list (`docs-only-paths.mjs:15-16`, `merge-if-eligible.ts:384-395`), and no machine-readable map of authorities exists.
2. Delete: no blanket hold on every RFC past Draft (DEC-0440 option a). Over the last 30 days that would have meant about 30 hand merges a month, mostly Engineering-only edits. The "drafts land on main early" rule (`spec/rfcs/README.md:74`, AISDLC-118) stays as it is for RFCs that declare no authorities.
3. Simplify:
   - One opt-in frontmatter field, `reviewAuthorities`.
   - One refusal, inside `cli-merge-if-eligible`. Every auto path goes through it: the reconciler arming (`reconcile.ts:526-540`) and the lander (`land-eligible.ts:228-236`). Neither caller gets a separate copy of the check.
   - The operator merges a held PR by hand once the authorities have replied.
4. Accelerate: the refusal reaches the planner as a hold right away, not after repeated re-arm attempts.
5. Automate last: no automated "has the authority replied" detection. The operator's hand merge is the record that they replied.

## Acceptance Criteria
- [ ] #1 RFC frontmatter field `reviewAuthorities`:
  - an optional list of `{ role: <string>, login?: <GitHub login> }` (for example `{ role: design, login: mohirt }`);
  - documented in `spec/rfcs/README.md`, with one sentence saying it is the exception to "drafts land early", and in `RFC-0001-template.md` as a commented-out example;
  - validated by `scripts/check-rfc-docs.mjs`. A malformed entry fails CI. Tests cover a valid entry, a missing `role`, and a value that is not a list.
- [ ] #2 `cli-merge-if-eligible` refuses, for every source kind (docs, backlog and the rest), any PR that changes, renames or deletes a `spec/rfcs/RFC-*.md` file whose copy on the base branch declares a non-empty `reviewAuthorities`:
  - the copy is read from the base ref, not the PR head, so a PR cannot remove the declaration and then merge itself;
  - the refusal message names the RFC and each declared role and login, and ends "merge by hand after they reply (DEC-0440)";
  - it fails closed: if the base copy cannot be read or parsed, the change is refused with a message saying so;
  - a newly added RFC file (no base copy) is not refused;
  - tests cover a declared RFC changed, an undeclared RFC changed, a declaration removed in the PR (still refused), an unreadable base copy (refused), and a new RFC file (allowed).
- [ ] #3 Reconciler and lander:
  - a refusal from AC #2 makes the reconciler route the PR to the planner (`route-to-planner`, with the refusal text as the reason) instead of retrying the arm;
  - the lander records the refusal and does not re-attempt on an unchanged fingerprint (`land-eligible.ts:185-204`);
  - tests replay a docs-lane PR shaped like #3088 against a base declaring `reviewAuthorities`, and assert that the PR is never armed and that the planner is notified once.
- [ ] #4 Declarations on main, made in the same PR:
  - `RFC-0018`: design (`mohirt`) and product (`akillies`);
  - `RFC-0049`: product (`akillies`) and design (`mohirt`).

  These are frontmatter-only changes to undeclared base copies, so this PR is not held by its own gate.
- [ ] #5 `docs/operations/merge-without-queue.md` or the quality-gate reference states the hold, and states that the only release is the operator's hand merge.
- [ ] #6 The refusal works for adopters with no repo config: no `reviewAuthorities` means no change in behaviour.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Decision: DEC-0440 option b, chosen by the operator 2026-11-26. Provisional until Design Authority (Morgan) confirms it meets the RFC-0018 v0.4.1 sign-off condition, and Product (Kline) has replied.
- Interim until this lands: the planner opens normative RFC amendments as GitHub draft PRs. The lander skips drafts (`land-eligible.ts:157`).
- Out of scope: whether tasks may be dispatched against RFC text that is still under authority review (for example AISDLC-1445 to 1447 against the RFC-0049 amendment). That is a separate readiness-gate question.
