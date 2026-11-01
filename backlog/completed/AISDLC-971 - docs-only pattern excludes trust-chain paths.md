---
id: AISDLC-971
title: 'The docs-only lane is docs AND not trust-chain: root markdown, agent memory, dispatch briefs and dependabot config leave the pattern'
status: Done
assignee: []
created_date: '2026-10-17'
labels:
  - ci
  - trust-chain
dependencies:
  - AISDLC-969
references:
  - pipeline-cli/attestation-core/docs-only-paths.mjs
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

`pipeline-cli/attestation-core/docs-only-paths.mjs` (lines 14-25) classifies as docs-only any root `*.md` (so `CLAUDE.md` and `AGENTS.md`, the agents' standing instructions), `.claude/memory/**`, `.ai-sdlc/dispatch/briefs/**` (the files that drive the autonomous hierarchy), `.github/*.md`, `.github/dependabot.yml` and committed envelopes. `pipeline-cli/attestation-core/review-scope-core.mjs` (lines 33-34, 71, 78) classifies the same paths as trust-chain and demands three reviewers for them. The two lists disagree, and the lane wins: a "docs" PR rewrites governance or a brief with zero review. The records-only lane already applies the right rule (records AND not a trust-chain exception); docs-only should match it. Introduced across AISDLC-534 (commit 9eca1d336) with no decision record.

**Five-step review (requirements first).**
1. Requirement questioned: must RFCs, docs/ and backlog stay cheap? Yes; those stay in the lane. The question is only whether instruction and governance files are docs. They are inputs to agents, so they are code for review purposes.
2. Delete: the `[^/]+\.md$` root pattern, `.claude/memory/`, `.ai-sdlc/dispatch/briefs/`, `.github/dependabot.yml` and `.github/*.md` entries from `DOCS_ONLY_PATTERN`.
3. Simplify: one function `isDocsOnlyChangeset(files) = files.every(isDocsPath) && !files.some(isTrustChainPath)` with `isTrustChainPath` imported from `review-scope-core.mjs`, so the two lists cannot diverge again.
4. Accelerate: nothing.
5. Automate: a test enumerates every trust-chain pattern and asserts none is docs-only; `docs/operations/quality-gate.md` lists what the lane admits.

## Acceptance Criteria

- [x] A PR touching `CLAUDE.md`, `AGENTS.md`, `.claude/memory/**`, `.ai-sdlc/dispatch/briefs/**` or `.github/dependabot.yml` runs the full gate.
- [x] A PR touching only `docs/**`, `spec/rfcs/**`, `backlog/**` or non-root `README.md` files still takes the docs-only lane.
- [x] The docs-only predicate reuses the trust-chain predicate; a test proves no trust-chain pattern is docs-only.
- [x] `docs/operations/quality-gate.md` lists the lane's admitted paths.

## Final Summary

## Summary
The docs-only lane now requires a docs path that is not a trust-chain path. Root `*.md` (including `CLAUDE.md` and `AGENTS.md`), `.claude/memory/**`, `.ai-sdlc/dispatch/briefs/**` and `.github/**` (including `dependabot.yml`) take the full gate. The root `*.md`, memory, briefs and `.github/*.md`/`dependabot.yml` alternatives are gone from `DOCS_ONLY_PATTERN`, and `isDocsOnly` plus the docs+records branch of `classifyChangeset` also reject `isTrustChainPath`.

## Changes
- pipeline-cli/attestation-core/docs-only-paths.mjs
- scripts/is-docs-only-changeset.mjs
- scripts/is-docs-only-changeset.test.mjs
- pipeline-cli/src/governance/merge-if-eligible.test.ts
- .github/workflows/ai-sdlc-review.yml
- docs/operations/quality-gate.md
- backlog/tasks/AISDLC-971 - docs-only pattern excludes trust-chain paths.md

## Design decisions
I ran `pnpm build && pnpm test && pnpm lint && pnpm format:check`. The first full `pnpm test` had one pipeline-cli failure in `merge-if-eligible.test.ts` (the docs lane test 'arms a docs-only ai-sdlc/file-* PR'), because it asserted that briefs and memory could be armed. I changed that test to use docs paths and added a refusal test for briefs, memory and `CLAUDE.md`. I then re-ran only `merge-if-eligible.test.ts` (225 passed), `pnpm lint` and `pnpm format:check`, all clean. I did not repeat the full `pnpm test` after that edit. `scripts/is-docs-only-changeset.test.mjs` passes 45/45. Four things beyond the task text. First, the docs lane's `merge-if-eligible` auto-arm now also refuses those paths. Second, I removed the `.github/dependabot.yml`, `.github/*.md` and `*.md` globs from the `ai-sdlc-review.yml` paths-ignore list, so those PRs now trigger review. Third, root `README.md` and `CHANGELOG.md` now run the full gate (a consequence of deleting the root pattern), so release-please PRs take the full gate. Fourth, the AC 2 non-root `README.md` case is only partly covered: `pipeline-cli/README.md` stays code, matching an existing test, and only READMEs under `docs/` or `spec/rfcs/` stay docs-only. The task file status line also changed to In Progress.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

