---
id: AISDLC-1009
title: >-
  `--arm` reports ARMED on repositories without GitHub auto-merge, while the CLI has in fact landed the PR itself
status: Done
assignee: []
created_date: '2026-10-21'
labels:
  - governance
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/governance/merge-if-eligible.test.ts
  - docs/operations/merge-without-queue.md
  - docs/operations/tooling-limitations.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-21 17:30Z, from an adopter report).** On a private repository on the GitHub Free plan, `allow_auto_merge` is false, there is no branch protection and no rulesets (the API answers 403 "Upgrade to GitHub Pro"). `armPr` in `merge-if-eligible.ts` shells out to the gh auto-merge subcommand; GitHub treats an already-clean PR as having nothing to wait for and lands it immediately under the shell's gh token. Four PRs in that repo show "landed by the operator's login, auto_merge null" although the CLI did it, and the audit record says "armed". The audit and the PR disagree, and nothing was ever armed. Operator principle: a step whose outcome is not what it reports is a hidden human-in-the-loop, because a person has to go and check.

**Five-step review (requirements first).**
1. Requirement questioned: "arming means asking GitHub to merge later". On a repository where auto-merge is unavailable there is no "later": the gate already supports the direct landing path, and `--arm` on a clean PR is the same action with a misleading name.
2. Delete: the unconditional ARMED report.
3. Simplify: before arming, read `allow_auto_merge` on the repository once per run (cached). When it is false, `--arm` on an eligible PR takes the direct landing path and reports `landed` with the merge sha; when the PR is not yet eligible it reports `not-armable: auto-merge unavailable on this repository`, so dispatch retries on the next tick. After a successful arm, the CLI reads the PR back and reports ARMED only when `autoMergeRequest` is present; otherwise it reports what GitHub shows.
4. Accelerate: dispatch stops re-arming PRs that were already landed, and the audit matches reality.
5. Automate: none beyond the above.

**Velocity impact.** Positive: one truthful report per PR; no human verification of what the CLI did.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 With `allow_auto_merge=false`, `--arm` on an eligible (green, CLEAN, trusted) PR lands it directly and reports `landed` with the sha; on a PR that is not yet eligible it reports `not-armable` naming the reason, and arms nothing; both covered by unit tests with a fake gh
- [ ] #2 With `allow_auto_merge=true`, the ARMED report is emitted only after the PR read-back shows an `autoMergeRequest`; a read-back without one reports the observed state; unit test
- [ ] #3 The audit record carries the observed outcome (`armed`, `landed`, `not-armable`, `refused`) and the repository's `allow_auto_merge` value
- [ ] #4 `docs/operations/merge-without-queue.md` documents the two repository shapes; `docs/operations/tooling-limitations.md` gains the GitHub Free auto-merge ceiling with its detection (`allow_auto_merge` on the repository)
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
