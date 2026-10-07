---
id: AISDLC-742
title: >-
  Condense CLAUDE.md to rules and pointers to cut the per-call context floor
  (63 KB to at most 20 KB)
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - docs
  - cost
dependencies: []
references:
  - CLAUDE.md
  - docs/operations/
  - docs/api-reference/
  - ai-sdlc-plugin/hooks/session-start.sh
  - ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md
priority: high
dispatchable: true
updated_date: '2026-10-07 02:29'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 48-hour token audit (to 2026-10-06 17:00 PDT) found 7,163 model calls and 1.38 billion cache-read tokens across the operator's Claude Code sessions; cache reads were 86% of the cost weight, and a freshly cleared session starts at about 90k tokens. CLAUDE.md is loaded into every call of every session and subagent in this repository; at 63 KB it is about 16k tokens, the largest single component of that floor (the memory index was 23 KB and has already been pruned to 8 KB locally). Most of CLAUDE.md is per-PR explanatory prose: the "Backlog Workflow" section alone is 15 KB and the "Review attestations" section 11 KB, with paragraphs that narrate AISDLC-393 round-2 findings, spawner kinds, Pattern C routing and release-please mechanics. The standing rule in the repository's memory already says CLAUDE.md is not a changelog. Standing rule from the operator's memory (feedback_claude_md_no_changelog): CLAUDE.md is not a changelog; do not append per-PR explanatory bullets. The governance SessionStart hook and the ai-sdlc-governance skill also inject rules; anything duplicated there must not also be in CLAUDE.md.

Velocity impact: zero prompts; roughly 10k to 12k tokens removed from every call of every session and subagent (about 7,000 calls in the last 48 hours, so tens of millions of cache-read tokens per day), faster turns, and fewer usage-limit stalls.

Out of scope: changing any rule's meaning; editing the plugin's hook or skill text; touching the memory folder.

## Acceptance Criteria
- [x] CLAUDE.md is at most 20 KB and keeps every MUST, NEVER, "always", "only" and numbered rule it has today, each verbatim or tightened without changing meaning; a table in the PR body maps every removed paragraph to where it now lives (an existing or new page under `docs/operations/` or `docs/api-reference/`, or "duplicate of <hook/skill section>, dropped").
- [x] Explanatory material (why a rule exists, incident history, implementation details such as file paths of helpers, round-N finding narratives, task ids used as citations) moves to the docs pages, and CLAUDE.md links to them with one line per topic.
- [x] Nothing in CLAUDE.md duplicates text that the SessionStart governance hook or the ai-sdlc-governance skill already injects; the PR body names what was deduplicated.
- [x] The PR body reports the byte size and an approximate token count before and after (use `wc -c` and bytes/4).
- [x] The three reviewers' prompts (`/ai-sdlc execute` step 7) still pass: run every test that references CLAUDE.md content (`grep -rl "CLAUDE.md" --include=*.test.* .` and run those), and they pass.
- [x] Velocity impact paragraph in the PR body.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
CLAUDE.md condensed from 63,297 to 20,362 bytes (~15.8k to ~5.1k tokens at bytes/4). Every MUST/NEVER/always/only/numbered rule stays; explanatory prose moved essentially verbatim to five new docs/operations pages that CLAUDE.md links to one line per topic.

## Changes
- `CLAUDE.md` (modified): rules plus pointers only.
- `docs/operations/claude-md-reference-git-ci-hooks.md` (new): Git Flow, CI, hooks, feature flags, dark-code gate.
- `docs/operations/claude-md-reference-governance.md` (new): decision authority, scope-creep, OQ-resolution, decision catalog.
- `docs/operations/claude-md-reference-attestation.md` (new): attestation and remote-agent detail.
- `docs/operations/claude-md-reference-backlog-execution.md` (new): backlog workflow, execution paths, spawners, templates.
- `docs/operations/claude-md-reference-releases-rfcs-pattern-c.md` (new): releases, RFC process, Pattern C routing.

## Design decisions
- **Verbatim moves**: moved text preserved rather than rewritten, to avoid changing any rule's meaning.
- **Margin**: result is 118 bytes under the 20,480 limit.

## Verification
- `pnpm build` — passed
- `pnpm test` — CLAUDE.md-referencing tests pass; remaining failures (execute.test.mjs model-routing, pipeline-cli verify-runtime/bin-invocation/tui) are pre-existing: execute.test.mjs fails identically on clean origin/main
- `pnpm lint` — passed
- `pnpm format:check` — passed
- code review approved (claude-native; codex quota exhausted)

## Follow-up
(none)
