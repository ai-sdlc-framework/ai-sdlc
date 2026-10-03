---
id: AISDLC-697
title: >-
  Attestation: bind each leaf to its own reviewer run (marker location, role and agent id), and say that verify does not enforce independence
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - attestation
  - security
  - pipeline-cli
  - plugin
  - adopter-report
dependencies: []
references:
  - pipeline-cli/src/attestation/verdict-class.ts
  - pipeline-cli/src/attestation/harness-transcript.ts
  - pipeline-cli/src/cli/attestation.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
  - ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh
  - ai-sdlc-plugin/commands/execute.md
  - docs/operations/independence-policy.md
priority: high
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An adopter repository reported three defects in the review-attestation pipeline on
2026-10-03 (plugin 0.21.1, pipeline-cli 0.26.0, worktree layout, three reviewers run as
independent subagents). The operator asked for them to be fixed.

1. **Markers looked up in the wrong place.** `emit-leaf` read `SubagentStart` markers only
   from `<repo-root>/.ai-sdlc/subagent-sessions/`. With `--repo-root` set to a task
   worktree, the harness writes them under the directory the session was started in, the
   main checkout. Every leaf came out `self-authored` with `harnessTranscriptHash=null`
   although independent reviewers ran. The last 36 leaves in this repository show the
   same.
2. **`verify` passes self-authored envelopes.** `cli-attestation verify` checks integrity
   and exits 0 for a valid envelope whose leaves are self-authored. The adopter's CI ran
   only `verify`. The independence gate exists (`cli-attestation independence-policy`
   with `requiredTier`), but nothing in `verify`'s output pointed to it.
3. **Leaves bound by timing.** A marker was matched to a leaf only by being inside a
   30-minute window; role and agent id were not compared. With three reviewers finishing
   within seconds, each leaf's `harnessTranscriptHash` pointed at another reviewer's
   transcript, and the leaves still reported `independent`. The session directory was
   chosen as "the most recently modified", which is wrong when several sessions share a
   project directory.

## Scope
1. Marker selection by identity (`selectSubagentMarker`): reviewer role must match, the
   agent id must match when known, and the choice among several candidates is
   deterministic. `determineVerdictClass` consumes exactly the selected marker.
2. Markers are searched under the repo root, the main checkout and `--project-dir`.
3. `emit-leaf --agent-id`, with a fallback to the `<transcript>.agent-id` file that
   `persist-reviewer-artifacts.sh` now writes. `reconcile` passes the ids it already has.
4. The harness transcript's session directory is located by the agent id.
5. The transcript's harness-recorded role must be the leaf's reviewer.
6. `verify` prints a note for a valid self-authored envelope; docs explain `verify`
   against `independence-policy` and how a leaf is bound.
7. No change to the leaf shape, the envelope, the verifier's acceptance rules, or exit
   codes.

## Acceptance Criteria
- [x] With `--repo-root` a worktree and markers only under the main checkout, a reviewer's leaf is `independent` and its `harnessTranscriptHash` is set.
- [x] Three reviewers with markers fired within seconds: each leaf's `harnessTranscriptHash` equals the hash of its own reviewer's harness transcript, in any emit order.
- [x] A marker of another reviewer is never used or consumed for a leaf; the leaf is `self-authored`.
- [x] `--agent-id` (or the sidecar) selects exactly that run; an id whose marker belongs to another reviewer yields `self-authored` and a `null` hash; a malformed id is rejected.
- [x] The session directory is found by agent id even when another session is newer.
- [x] `verify` exits 0 for a valid self-authored envelope and prints the note; no note for an independent or an invalid envelope.
- [x] `persist-reviewer-artifacts.sh` writes the `.agent-id` file next to the transcript.
- [x] Callers that pass neither reviewer name nor agent id keep the earlier behaviour.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL-SUMMARY:BEGIN -->
## Summary
`emit-leaf` now binds a leaf to its own reviewer run. The harness marker is looked up
where the harness writes it, and it is matched by reviewer role and agent id, not by
timing alone. `verify` states that it does not enforce independence.

## Changes
- `pipeline-cli/src/attestation/verdict-class.ts` (modified): `selectSubagentMarker`,
  `AGENT_ID_PATTERN`; `determineVerdictClass` takes `reviewerName`, `agentId`,
  `extraRoots` and consumes the selected marker only.
- `pipeline-cli/src/attestation/harness-transcript.ts` (modified): `markerSearchRoots`,
  `locateSessionDirByAgentId`; `findMatchingSubagentMarker` and
  `computeHarnessTranscriptHash` take the reviewer and agent id; the transcript's role
  must equal the leaf's reviewer.
- `pipeline-cli/src/cli/attestation.ts` (modified): `emit-leaf --agent-id`,
  `readAgentIdSidecar`, the `verify` note.
- `pipeline-cli/src/orchestrator/reconcile.ts` (modified): passes `--agent-id`.
- `ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh` (modified): writes
  `<reviewer>.agent-id`.
- `ai-sdlc-plugin/commands/execute.md` (modified): marker lookup in the main checkout,
  bare-role comparison, note on the sidecar.
- `docs/operations/independence-policy.md` (modified): two sections.
- Tests in `verdict-class.test.ts`, `harness-transcript.test.ts`, `attestation.test.ts`,
  `reconcile.test.ts`, `persist-reviewer-artifacts.test.mjs`.

## Design decisions
- **`verify` keeps exit 0 for self-authored envelopes.** Changing it would fail every
  adopter whose reviews are not yet marker-backed, including this repository until this
  fix ships, and the opt-in gate already exists. The note and the docs make the gate
  discoverable. Making independence the default is a policy decision for the operator.
- **Role match is required even with an agent id.** An id that belongs to another
  reviewer gives a self-authored leaf, so a mix-up cannot produce a mis-bound
  `independent` leaf.
- **Sidecar file, not only a flag.** The coordinator already hands the agent id to the
  persist helper; recording it next to the transcript binds leaves without changing
  each caller of `emit-leaf`.
- **Untyped legacy markers** stay eligible for the harness hash only, and only when the
  harness's own `.meta.json` role equals the leaf's reviewer.
- **Honest scope unchanged.** Markers are still written by the same machine and
  account; this fixes mis-binding and false negatives, not forgery by a coordinator.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli test` and `pnpm lint`, `pnpm format:check`: see
  the PR body for counts.
- `node --test ai-sdlc-plugin/scripts/persist-reviewer-artifacts.test.mjs`: 10 passed.
- The rotation case from the report is reproduced as a test and passes.

## Follow-up
- declined: make `verify` fail on self-authored leaves; the gate is `independence-policy`, and the default tier is the operator's decision.
- declined: fix the unrelated failing assertion in `ai-sdlc-plugin/commands/execute.test.mjs` (bare `cli-decisions` path); it fails on `main` before this change and is reported to the operator.
<!-- SECTION:FINAL-SUMMARY:END -->
