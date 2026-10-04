---
id: AISDLC-701
title: >-
  Attestation leaf binding hardening: nonce required for independent everywhere, atomic marker claim, nonce check before persisting, tested marker lookup
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - attestation
  - security
  - pipeline-cli
  - plugin
dependencies: []
references:
  - pipeline-cli/src/attestation/verdict-class.ts
  - pipeline-cli/src/attestation/harness-transcript.ts
  - pipeline-cli/src/cli/attestation.ts
  - ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh
  - ai-sdlc-plugin/commands/execute.md
  - docs/operations/independence-policy.md
priority: high
dispatchable: true
blocked:
  reason: "Builds on pull request 1182 (attestation leaf binding); remove this block once it is merged"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pull request 1182 binds each attestation leaf to its own reviewer run: the harness
marker is selected by reviewer role and agent id, and a marker found in a directory
shared between tasks counts only when that run's harness transcript contains the leaf's
diff-binding nonce. Its second review round approved it and left hardening items. They
are filed here under the operator's standing rule that minor reviewer findings become
backlog tasks.

Start this task only once that pull request is on `main`.

## Conventions
- Trust-sensitive: security review on the strongest reviewer model. No change to the
  leaf shape, the envelope or the verifier's acceptance rules. A leaf field is never
  written with an explicit default value.
- TypeScript strict, ESM, Vitest; `node --test` for plugin scripts; 80% line coverage on
  new code. Tests never touch the real home directory.
- Honest scope stays as documented: a coordinator that controls the account can still
  fabricate markers. These items remove accidental mis-binding, not that.

## Scope
1. **Nonce required for `independent` everywhere.** Today a role-matched marker under
   `--repo-root` earns `independent` with no nonce check. When `--repo-root` is the main
   checkout itself, that directory is shared between tasks, so one task can be credited
   from another task's reviewer marker. Require a nonce-verified harness transcript for
   `independent` in every location. Keep the local role-matched rule only behind an
   explicit `emit-leaf` flag for callers that cannot pass a nonce, and print a notice
   when it is used. List the callers in this repository that pass no nonce and update
   them first.
2. **Atomic marker claim.** The marker is deleted after the checks, so two concurrent
   `emit-leaf` runs for the same leaf can both report `independent`. Claim the marker
   atomically (rename to a per-process name, or create an exclusive sibling) and grant
   `independent` only to the process that wins the claim.
3. **Nonce check before persisting.** `persist-reviewer-artifacts.sh` accepts an optional
   `--nonce-marker` and refuses, with a distinct exit code, when the resolved harness
   transcript does not contain it. `execute.md` passes it. This stops another task's
   transcript from being copied in as this task's when a wrong agent id is supplied.
4. **Marker lookup as a tested script.** Move the inline node snippet in `execute.md`
   Step 7b.5 into `ai-sdlc-plugin/scripts/`, with tests for zero markers, one, several,
   a marker of another role, and a plugin-prefixed role. Add an age filter matching the
   30-minute window so stale unconsumed markers do not make it refuse. `execute.md`
   calls the script.
5. **Cleanups from the review.** Update the stale comment above the
   `bindLeafToReviewerRun` call in `emit-leaf`. Remove `findMatchingSubagentMarker`, or
   mark it test-only, since no non-test code calls it. Make the two `execute.md`
   sentences that still say "most recent marker" match the behaviour. In
   `docs/operations/independence-policy.md`, state that the nonce shows the run was
   given this nonce in its prompt, and correct the parallel-task sentence to what scope
   item 1 makes true.
6. **Tests for the remaining gaps.** `emit-leaf --project-dir` end to end; the fail-safe
   `catch` paths in `bindLeafToReviewerRun` and `hashForMarker`.

## Acceptance Criteria
- [ ] With `--repo-root` set to a main checkout holding two tasks' reviewer markers of the same role, each task's leaf is `independent` only through its own nonce-verified run; with no nonce passed and no opt-in flag the leaf is `self-authored`.
- [ ] The opt-in flag restores the local role-matched rule and prints a notice; every caller in this repository that needed it is listed in the PR body.
- [ ] Two concurrent `emit-leaf` runs for the same leaf yield exactly one `independent` leaf (test with two processes or an injected claim race).
- [ ] The persist helper refuses a transcript that lacks the nonce marker when `--nonce-marker` is given, and behaves as before without it.
- [ ] The marker lookup script's tests cover the five cases and the age filter, and `execute.md` contains no inline copy of the logic.
- [ ] No non-test caller of `findMatchingSubagentMarker` remains, or the function is gone.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
