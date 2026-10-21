---
id: AISDLC-969
title: 'The gate detect job runs the docs-only classifier from the base sha, never from the PR tree, and a PR touching the classifier is code'
status: Done
assignee: []
created_date: '2026-10-17'
labels:
  - ci
  - trust-chain
  - security
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - pipeline-cli/attestation-core/docs-only-paths.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

The `detect` job of `.github/workflows/ai-sdlc-gate.yml` (lines 109-125) checks out the PR merge ref and runs `node scripts/is-docs-only-changeset.mjs` from that checkout. The classifier decides `docs_only` and `records_only`, and those outputs put `lint`, `build-test`, `attestation-gate` and `independence-gate` in the allowed-skips of the `ai-sdlc/pr-ready` rollup. A same-repo PR can therefore edit the classifier (or `pipeline-cli/attestation-core/docs-only-paths.mjs`) to answer `true`, carry arbitrary code, and land with no build, no test and no review attestation; auto-arming happens at open (DEC-0065 requires no human approval). The verifier's own base-sha isolation (AISDLC-704.6, DEC-0206) runs after this decision and so never sees the PR. Introduced by commit dd4940bb4 (AISDLC-484) with no decision record. The `governance-gate` job already shows the safe pattern: it reads its scripts with `git show "$BASE_SHA:scripts/..."`.

**Five-step review (requirements first).**
1. Requirement questioned: do we need a PR-side lane classifier at all? Yes: the docs-only lane is what keeps the gate cheap for filing and RFC PRs, so the lane stays; only its source of truth moves.
2. Delete: the checkout of the PR ref in `detect` for the purpose of running scripts; the diff list is all it needs from the PR.
3. Simplify: `detect` reads both classifier files from `$BASE_SHA` with `git show`, exactly like `governance-gate`, and any changeset touching `scripts/is-docs-only-changeset.mjs`, `pipeline-cli/attestation-core/docs-only-paths.mjs` or `.github/workflows/ai-sdlc-gate.yml` is classified `code` regardless of what the classifier says.
4. Accelerate: nothing; one fewer checkout.
5. Automate: a workflow test (`scripts/*.test.mjs`) asserts that every `node scripts/...` invocation in the `detect` job is preceded by a base-sha `git show`, so the pattern cannot regress silently; `docs/operations/quality-gate.md` states the rule in one line.

## Acceptance Criteria

- [x] `detect` runs the classifier code taken from the base sha; the PR's copy is never executed.
- [x] A PR that modifies either classifier file or the gate workflow is classified `code` and runs the full gate.
- [x] A test fails if a `node scripts/...` call in `detect` is not sourced from the base sha.
- [x] `docs/operations/quality-gate.md` documents the rule.

## Final Summary

## Summary
The gate `detect` job now reads the docs-only classifier and its two imports from the base sha with `git show` and runs that copy, never the PR tree. Any diff touching the classifier, `docs-only-paths.mjs` or `ai-sdlc-gate.yml` is forced to `code`. A new test enforces the base-sha pattern, and `quality-gate.md` documents the rule.

## Changes
- .github/workflows/ai-sdlc-gate.yml
- scripts/gate-detect-base-sha.test.mjs
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-969 - the docs-only classifier runs from the base sha not the pr tree.md

## Design decisions
I did not run pnpm build or the full pnpm test. The new test passes, `node scripts/run-gate-tests.mjs` exited 0, and prettier and the commit hooks (eslint, prettier) were clean. The `commit-msg` hook rejects the scope `gate`, so the commit uses `ci`. The task file under backlog/tasks was modified by a hook and is part of the commit. One of my pushes ran from the parent checkout by mistake. It pushed main's own HEAD to the task branch ref, which was then overwritten by the correct push, and the parent's `main` upstream is reset to origin/main. I did not exercise the workflow shell itself on a real PR.

## Verification
- `pnpm build` — skipped
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

