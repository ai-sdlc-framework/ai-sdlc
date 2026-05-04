---
id: AISDLC-176
title: >-
  Orchestrator: enforce developer subagent JSON return contract (retry once on
  parse failure)
status: Done
assignee: []
created_date: '2026-05-04 00:13'
labels:
  - bug
  - orchestrator
  - developer-agent
  - rfc-0015
dependencies: []
references:
  - ai-sdlc-plugin/agents/developer.md
  - pipeline-cli/src/cli/orchestrator.ts
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Witness test of `cli-orchestrator tick` (2026-05-03) dispatched AISDLC-70. The dev subagent **made a valid commit** (moved parent task file to `backlog/completed/`, wrote thorough finalSummary) but **returned plain text** `"Done. AISD..."` instead of the required JSON envelope `{commitSha, verifications, prUrl, notes}`.

Result: orchestrator failed at Step 6 with `outcome: "developer-failed"`, abandoned the worktree with the valid commit stranded inside, and recorded the run as a failure even though the work was correct.

## Root cause

`ai-sdlc-plugin/agents/developer.md` documents the JSON return shape but does not enforce it programmatically. When the dev subagent produces prose (not uncommon — Claude defaults to natural-language summaries), Step 6's JSON.parse fails fast and the orchestrator can't recover the work.

## Fix options

**Option A (preferred):** Step 6 should attempt JSON parse, and on failure send ONE follow-up message to the same subagent: "Your previous response was not valid JSON. Re-emit the JSON envelope with shape `{commitSha, verifications, prUrl, notes}`. If you have already committed, populate commitSha from `git rev-parse HEAD`." This recovers the common case (dev forgot the contract).

**Option B:** Strengthen `developer.md` system prompt to make JSON envelope absolute (e.g., "Your FINAL message MUST be a single JSON object — no surrounding prose"), and add a fail-loud assertion in Step 6 that surfaces the actual returned text in the error message.

**Recommended:** ship A + B together. A is the recovery; B is the prevention.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 Step 6 (parse-dev-return) attempts JSON parse, on failure sends ONE retry message asking for envelope re-emission
- [ ] #2 Retry preserves the original commit (caller can populate commitSha from `git rev-parse HEAD` if dev's retry omits it)
- [ ] #3 developer.md system prompt strengthened: FINAL message MUST be JSON envelope, no surrounding prose
- [ ] #4 Failure-mode test: subagent that returns prose first, then JSON on retry, succeeds end-to-end through Step 11
- [ ] #5 Failure-mode test: subagent that returns prose twice fails with clear outcome 'developer-json-contract-violated' (not the cryptic JSON.parse error)
- [ ] #6 Orchestrator events.jsonl emits DeveloperContractRetry on the recovery path
<!-- AC:END -->
