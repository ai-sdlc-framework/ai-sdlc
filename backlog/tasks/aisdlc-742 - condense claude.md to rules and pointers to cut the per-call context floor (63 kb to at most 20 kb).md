---
id: AISDLC-742
title: >-
  Condense CLAUDE.md to rules and pointers to cut the per-call context floor
  (63 KB to at most 20 KB)
status: To Do
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
  - .claude/memory/feedback_claude_md_no_changelog.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A 48-hour token audit (to 2026-10-06 17:00 PDT) found 7,163 model calls and 1.38 billion cache-read tokens across the operator's Claude Code sessions; cache reads were 86% of the cost weight, and a freshly cleared session starts at about 90k tokens. CLAUDE.md is loaded into every call of every session and subagent in this repository; at 63 KB it is about 16k tokens, the largest single component of that floor (the memory index was 23 KB and has already been pruned to 8 KB locally). Most of CLAUDE.md is per-PR explanatory prose: the "Backlog Workflow" section alone is 15 KB and the "Review attestations" section 11 KB, with paragraphs that narrate AISDLC-393 round-2 findings, spawner kinds, Pattern C routing and release-please mechanics. The standing rule in the repository's memory already says CLAUDE.md is not a changelog. The governance SessionStart hook and the ai-sdlc-governance skill also inject rules; anything duplicated there must not also be in CLAUDE.md.

Velocity impact: zero prompts; roughly 10k to 12k tokens removed from every call of every session and subagent (about 7,000 calls in the last 48 hours, so tens of millions of cache-read tokens per day), faster turns, and fewer usage-limit stalls.

Out of scope: changing any rule's meaning; editing the plugin's hook or skill text; touching the memory folder.

## Acceptance Criteria
- [ ] CLAUDE.md is at most 20 KB and keeps every MUST, NEVER, "always", "only" and numbered rule it has today, each verbatim or tightened without changing meaning; a table in the PR body maps every removed paragraph to where it now lives (an existing or new page under `docs/operations/` or `docs/api-reference/`, or "duplicate of <hook/skill section>, dropped").
- [ ] Explanatory material (why a rule exists, incident history, implementation details such as file paths of helpers, round-N finding narratives, task ids used as citations) moves to the docs pages, and CLAUDE.md links to them with one line per topic.
- [ ] Nothing in CLAUDE.md duplicates text that the SessionStart governance hook or the ai-sdlc-governance skill already injects; the PR body names what was deduplicated.
- [ ] The PR body reports the byte size and an approximate token count before and after (use `wc -c` and bytes/4).
- [ ] The three reviewers' prompts (`/ai-sdlc execute` step 7) still pass: run every test that references CLAUDE.md content (`grep -rl "CLAUDE.md" --include=*.test.* .` and run those), and they pass.
- [ ] Velocity impact paragraph in the PR body.
<!-- SECTION:DESCRIPTION:END -->
