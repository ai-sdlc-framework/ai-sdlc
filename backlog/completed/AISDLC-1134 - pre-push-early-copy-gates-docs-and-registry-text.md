---
id: AISDLC-1134
title: 'Registry and docs describe the two pre-push early-copy gates correctly: gates.yaml DEC-0283 property drops attestation verify; quality-gate.md and CLAUDE.md stop saying coverage never runs locally'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - docs
  - hooks
  - governance
dependencies: []
references:
  - .ai-sdlc/gates.yaml
  - docs/operations/quality-gate.md
  - CLAUDE.md
  - .husky/pre-push
  - scripts/pre-push-patch-coverage.mjs
  - scripts/check-governance-on-push.sh
  - scripts/check-gate-registry.test.mjs
priority: medium
dispatchable: true
---

## Description

DEC-0282 (AISDLC-1119, pre-push patch-coverage step) and DEC-0283 (AISDLC-1123, pre-push governance-checks step) were answered `register` by the operator on 2026-10-31 through the decision rubric. Both rulings carry a documentation condition that this task delivers. Nothing in the hooks or scripts changes.

1. `.ai-sdlc/gates.yaml`: the `property` line of `pre-push:scripts/check-governance-on-push.sh` lists "attestation verify". The step does not verify attestations; that stays in the fixups step (AISDLC-694), as the hook header and `scripts/check-governance-on-push.sh` both state. A registry entry that misdescribes a control defeats the registry.
2. `docs/operations/quality-gate.md` (section "Patch coverage", around the sentence "There is no local pre-push or Stop-hook coverage run and no skip variable") contradicts the paragraph AISDLC-1119 added below it ("the gate runs twice with the same script and threshold").
3. `CLAUDE.md` Testing section: "Coverage is NOT a local gate; CI is the single gate (AISDLC-726)" is now half true. CI is the only gate that blocks a merge; the pre-push step is its early copy over the touched packages.

**Five-step review (requirements first).**
1. Requirement questioned: should the pre-push coverage step be removed instead, restoring DEC-0056 row 2 verbatim? The operator ruled no in DEC-0282 (one standard enforced early: same script, same threshold YAML). This task records the amended standard; it does not reopen it.
2. Delete: the words "attestation verify" from the DEC-0283 registry line and the sentence "no local pre-push or Stop-hook coverage run and no skip variable" from quality-gate.md.
3. Simplify: one sentence in CLAUDE.md replaces the absolute claim: "Coverage blocks a merge only in CI (AISDLC-726); the pre-push step is an early copy of the same patch gate over the touched packages (AISDLC-1119, DEC-0282)." Stay inside the CLAUDE.md size budget (`scripts/check-claude-md-size.test.mjs`).
4. Accelerate: nothing to accelerate; three text edits.
5. Automate: nothing new. `scripts/check-gate-registry.test.mjs` already fails on an unregistered or mis-flagged entry; it does not check property prose, and adding a prose check is not worth a gate.

Velocity impact: none on pushes; removes one contradiction that misleads agents into setting the skip variable or filing a removal task.

## Acceptance Criteria

- [x] AC-1: `.ai-sdlc/gates.yaml` entry `pre-push:scripts/check-governance-on-push.sh` has a `property` that names only what `scripts/check-governance-on-push.sh` runs (conflict markers, waived-tests, reviewers, backlog drift on removed referenced files, gate tests) and no longer mentions attestation verify; `decision: DEC-0283` is unchanged; `pnpm test:gates` is green.
- [x] AC-2: `docs/operations/quality-gate.md` no longer states that no local pre-push coverage run exists; its coverage section says once that CI is the only gate that blocks a merge and that the pre-push step runs the same script and threshold over the touched packages, with the skip variable `AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1` named under the never-routine rule.
- [x] AC-3: `CLAUDE.md` Testing section says coverage blocks a merge only in CI and names the pre-push step as its early copy; `scripts/check-claude-md-size.test.mjs` is green.
- [x] AC-4: No change to `.husky/pre-push`, `scripts/pre-push-patch-coverage.mjs` or `scripts/check-governance-on-push.sh`; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner, decision rubric session 2026-10-31 (DEC-0282 and DEC-0283 rationale, PRs #2205 and the DEC-0283 filing). DEC-0056 row 2 is amended by DEC-0282; do not edit DEC-0056.

## Final Summary

## Summary
Made three text edits and no code changes. The `gates.yaml` DEC-0283 property no longer mentions attestation verify. `quality-gate.md` now says CI is the only coverage gate that blocks a merge and that the pre-push step is an early copy of it. The `CLAUDE.md` Testing line says the same in one sentence.

## Changes
- .ai-sdlc/gates.yaml
- docs/operations/quality-gate.md
- CLAUDE.md

## Design decisions
`pnpm test` passed once I unset the executor session variables (`AI_SDLC_EXECUTOR_TASK`, `AI_SDLC_HIERARCHY_SESSION`, `AI_SDLC_HIERARCHY_ROLE`). I ran it with `env -u` for those three variables, and the final output was exit code 0, with no summary line captured. With them set, `pipeline-cli/src/hierarchy/executor-start.test.ts` fails 14 of 23 tests. That file and its source are untouched by this diff, and the failure comes from the executor env leaking into the tests. Build, lint and format passed. I did not run `check-claude-md-size` or `pnpm test:gates` separately; they are part of `pnpm test`, which exited 0. The task file's status line was modified by the claim, not by me, and I reverted it before committing. The PR is a draft.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

