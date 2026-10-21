---
id: AISDLC-999
title: 'Drop this task''s earlier attestation chore commits before re-signing, as a non-interactive playbook action'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - attestation
  - pipeline
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - scripts/squash-attestation-chores.sh
  - scripts/pre-push-fixups.sh
  - ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh
  - pipeline-cli/src/hierarchy/playbook.ts
  - pipeline-cli/src/dispatch/types.ts
  - docs/operations/attestation-troubleshooting.md
priority: medium
dispatchable: true
---

## Description

A retried ship leaves the previous attempt's own commits in the stack: `chore: commit pending transcript leaves` (created at `pipeline-cli/src/next-step/ship.ts:139`) mid-stack and `chore: sign attestation` on top, with an envelope whose subject sha points at a commit no longer in history. Each retry re-signs on top of the stale commits and fails the same way. The only rewriter, `scripts/squash-attestation-chores.sh` (called from `scripts/pre-push-fixups.sh:122`), squashes only consecutive `chore: sign attestation` commits at the top (regex at `:40`), never the leaves commit or a chore buried mid-stack, and it is monorepo-only: `ai-sdlc-plugin/scripts/` does not ship it, so a consumer's `sign-attestation-if-consumer.sh:340-360` just commits another sign on top (`:432`). When a planner writes a resume note asking for `rebase -i` and a drop, nothing can act on it: the harness has no interactive git, `ResumeSignal` (`pipeline-cli/src/dispatch/types.ts:252-264`) is free text with `priorOutcome: 'iterate-needed'` only, the playbook actions are `rebase-push | retrigger-ci | requeue` (`pipeline-cli/src/hierarchy/playbook.ts:43,77`), and the rebase-resolver only resolves conflicts. A consumer repo (ai-sdlc-io) had the planner do the surgery by hand twice on 2026-10-20.

Fix: in `ship.ts:117-143`, before the 10.5 rebase, drop this task's earlier attestation chore commits non-interactively: a commit is one of ours when its subject is `chore: sign attestation` or `chore: commit pending transcript leaves` and it touches only `.ai-sdlc/attestations/` and `.ai-sdlc/transcript-leaves.jsonl`; drop them with a scripted `git rebase` (sequence editor set by the script, never `-i`) and re-emit the leaves from the transcript. Expose the same routine as a `drop-chores` playbook action (`playbook.ts:77/83`) and as a `cli-attestation reset-stack` subcommand, and ship it in `ai-sdlc-plugin/scripts/` so the consumer signer runs it before `:340`. `squash-attestation-chores.sh` gains the leaves subject so it stops leaving the second commit behind.

Out of scope: the `ResumeSignal` schema beyond the playbook action, the signer key (AISDLC-998) and the verifier.

**Five-step review (requirements first).**
1. Requirement questioned: should a retry ever re-sign on top of a previous attempt's attestation commits? No: an envelope whose subject is no longer in history is dead weight; the retry owns the stack.
2. Delete: the stale chore commits, and the "rebase -i" instruction in resume notes.
3. Simplify: one identification rule (subject + touched paths) shared by the squash script, the ship step and the playbook action.
4. Accelerate: a retry is clean on the first attempt instead of after planner surgery.
5. Automate: the drop runs before every 10.5 rebase; the playbook action lets dispatch trigger it without a person.

## Acceptance Criteria

- [ ] `ship.ts` drops this task's earlier attestation chore commits before the 10.5 rebase and re-emits the leaves; a test with a stacked stale sign + leaves commit ends with one envelope whose subject is HEAD.
- [ ] `cli-attestation reset-stack` performs the same drop non-interactively and refuses when a candidate commit touches any other path.
- [ ] `playbook.ts` offers a `drop-chores` action wired to that routine.
- [ ] The routine ships in `ai-sdlc-plugin/scripts/` and `sign-attestation-if-consumer.sh` runs it before signing; `squash-attestation-chores.sh` also matches the leaves subject.
- [ ] `docs/operations/attestation-troubleshooting.md` replaces any "rebase -i" guidance with the subcommand.
