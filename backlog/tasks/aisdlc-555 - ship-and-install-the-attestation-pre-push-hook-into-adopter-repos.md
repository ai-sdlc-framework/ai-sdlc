---
id: AISDLC-555
title: >-
  feat(plugin): ship check-attestation-sign.sh and an idempotent pre-push hook
  installer so adopter repos actually invoke the signer
status: To Do
assignee: []
labels:
  - attestation
  - adoption
  - plugin
  - ci:no-issue-required
priority: high
dependencies:
  - AISDLC-554
references:
  - scripts/check-attestation-sign.sh
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/commands/execute.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`/ai-sdlc execute` Step 10 stops after writing reviewer verdicts and delegates
signing to a `pre-push` hook in the consuming repo (AISDLC-133). The step's own
text hands three things to that repo: `.husky/pre-push`,
`scripts/check-attestation-sign.sh`, and a working signer invocation.

AISDLC-554 fixed the third. The first two are still never delivered:
`check-attestation-sign.sh` exists only in the ai-sdlc monorepo's `scripts/`,
not under `ai-sdlc-plugin/`, so it is not part of what an adopter installs. The
plugin ships seven hooks and every one of them is a **Claude Code** hook — there
is no git hook and no installer that writes one. An adopter repo that is
otherwise fully configured (review policy, trusted-reviewers, signing key all
present) therefore has nothing that ever calls the signer.

Consequence: even with AISDLC-554 landed, an adopter still gets no attestation
unless they hand-write a hook, because nothing invokes signing at push time.

### Scope

- Move or copy `check-attestation-sign.sh` into `ai-sdlc-plugin/scripts/` so it
  ships with the plugin. Keep the monorepo's own `.husky/pre-push` working.
- Add an installer that writes `.husky/pre-push` into the consuming repo
  idempotently — re-running must not duplicate lines, and it must append to an
  existing hook rather than clobber a repo's own.
- Decide and document the entry point: a dedicated `/ai-sdlc init-hooks`, or an
  extension of `install-runtime-deps.sh`. Prefer whichever an adopter already
  runs, so this is not one more step they must discover.
- Handle repos that do not use husky at all — writing `.git/hooks/pre-push`
  directly, or documenting the manual wiring.

A second adopter report (2026-08-14) widened this: the same consumer repo has
no `.ai-sdlc/verdicts/`, no `dispatch/` board, and no `dispatch-config.yaml`,
and the shipped command list contains no initializer for any of them. So the
deliverable is better framed as a single idempotent `/ai-sdlc init` that brings
a consumer repo to the same state the dogfood monorepo is in, of which the
pre-push hook is one part.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 `check-attestation-sign.sh` is present in the plugin's shipped
      `scripts/` directory
- [ ] #2 An installer writes a working `.husky/pre-push` into a fresh adopter
      repo, and running it twice is a no-op the second time
- [ ] #3 The installer appends to, rather than overwrites, a pre-existing
      `pre-push` hook
- [ ] #4 A non-husky repo either gets a `.git/hooks/pre-push` or a documented
      manual path — decided explicitly, not left undefined
- [ ] #5 End-to-end on a scratch repo outside the monorepo: verdict file
      present at push time produces a committed DSSE envelope
- [ ] #6 Hermetic tests cover the idempotence and append-not-clobber cases
- [ ] #7 The initializer also creates `.ai-sdlc/verdicts/`, the Dispatch Board
      directories, and `dispatch-config.yaml`, so a consumer repo reaches
      parity with the dogfood monorepo in one command
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From the 2026-08-14 adopter report against plugin 0.9.0. `resolve-pipeline-cli.sh`
plus `install-runtime-deps.sh` are the existing precedent for shipping and
self-healing a runtime artifact in the plugin cache; the same shape likely
applies here.

AC#5 requires a repo outside the monorepo. A worktree of this repo is not a
valid substitute — it inherits monorepo state, which is exactly what masked
this class of bug until an adopter hit it.
<!-- SECTION:NOTES:END -->
