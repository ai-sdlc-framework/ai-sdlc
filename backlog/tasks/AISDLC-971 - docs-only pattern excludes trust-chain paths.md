---
id: AISDLC-971
title: 'The docs-only lane is docs AND not trust-chain: root markdown, agent memory, dispatch briefs and dependabot config leave the pattern'
status: To Do
assignee: []
created_date: '2026-10-17'
labels:
  - ci
  - trust-chain
dependencies:
  - AISDLC-969
references:
  - scripts/docs-only-paths.mjs
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

`scripts/docs-only-paths.mjs` (lines 14-25) classifies as docs-only any root `*.md` (so `CLAUDE.md` and `AGENTS.md`, the agents' standing instructions), `.claude/memory/**`, `.ai-sdlc/dispatch/briefs/**` (the files that drive the autonomous hierarchy), `.github/*.md`, `.github/dependabot.yml` and committed envelopes. `pipeline-cli/attestation-core/review-scope-core.mjs` (lines 33-34, 71, 78) classifies the same paths as trust-chain and demands three reviewers for them. The two lists disagree, and the lane wins: a "docs" PR rewrites governance or a brief with zero review. The records-only lane already applies the right rule (records AND not a trust-chain exception); docs-only should match it. Introduced across AISDLC-534 (commit 9eca1d336) with no decision record.

**Five-step review (requirements first).**
1. Requirement questioned: must RFCs, docs/ and backlog stay cheap? Yes; those stay in the lane. The question is only whether instruction and governance files are docs. They are inputs to agents, so they are code for review purposes.
2. Delete: the `[^/]+\.md$` root pattern, `.claude/memory/`, `.ai-sdlc/dispatch/briefs/`, `.github/dependabot.yml` and `.github/*.md` entries from `DOCS_ONLY_PATTERN`.
3. Simplify: one function `isDocsOnlyChangeset(files) = files.every(isDocsPath) && !files.some(isTrustChainPath)` with `isTrustChainPath` imported from `review-scope-core.mjs`, so the two lists cannot diverge again.
4. Accelerate: nothing.
5. Automate: a test enumerates every trust-chain pattern and asserts none is docs-only; `docs/operations/quality-gate.md` lists what the lane admits.

## Acceptance Criteria

- [ ] A PR touching `CLAUDE.md`, `AGENTS.md`, `.claude/memory/**`, `.ai-sdlc/dispatch/briefs/**` or `.github/dependabot.yml` runs the full gate.
- [ ] A PR touching only `docs/**`, `spec/rfcs/**`, `backlog/**` or non-root `README.md` files still takes the docs-only lane.
- [ ] The docs-only predicate reuses the trust-chain predicate; a test proves no trust-chain pattern is docs-only.
- [ ] `docs/operations/quality-gate.md` lists the lane's admitted paths.
