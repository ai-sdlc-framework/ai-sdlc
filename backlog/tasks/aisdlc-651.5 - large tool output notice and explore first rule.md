---
id: AISDLC-651.5
title: >-
  RFC-0050 follow-up: PostToolUse large-output notice for main-session roles and the Explore-first rule in the planner and dispatch skills
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - rfc-0051
  - usage-ledger
  - plugin
  - hooks
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/hooks/collect-tool-sequence.js
  - ai-sdlc-plugin/commands/planner.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved on 2026-10-02 as part of turning the token-usage findings into
process: a practice holds when it is measured, nudged at the moment it matters, and
defaulted by the tooling. The usual conventions apply (strict TypeScript, ESM, hermetic
tests; plugin hooks under `node --test`; no writes under `.ai-sdlc/` by the developer
agent; no edits to RFC Open Questions).

Raw tool output read into a long-lived session stays in the window for every later
turn. An exploration through a subagent returns a summary of a few thousand tokens;
a file or log read into the main context can add tens of thousands that are then
re-read hundreds of times.

## Scope
1. **`PostToolUse` notice**: extend `ai-sdlc-plugin/hooks/collect-tool-sequence.js`
   (already registered for every tool) so that, for sessions whose roster role is
   planner or operator-dispatch, a tool result larger than
   `output.noticeTokens` (default 8000, estimated at four characters per token)
   returns a one-line notice: result size, and "for exploration use an Explore
   subagent; for logs use `tail` or `grep`; write large outputs to the artifacts
   directory and read back selectively". Developer and executor roles are exempt.
   Never blocks.
2. **Explore-first rule**: the planner skill and the operator-dispatch skill (when
   AISDLC-667 lands; until then the planner only) each gain a short rule: exploration
   through an `Explore` or Sonnet subagent that returns a summary; raw reads are for
   the file being edited or decided, not for finding it.
3. **Measure**: the growth-per-turn list from AISDLC-651.4 is the measurement; this
   task adds the tool name to each ledger record where the transcript provides it so
   that list can be computed.

## Acceptance Criteria
- [ ] A fixture tool result over the threshold in a planner-role session returns the notice; the same result in a developer-role session returns nothing; the hook never exits non-zero.
- [ ] The threshold is read from the usage config with the documented default.
- [ ] The planner skill carries the Explore-first rule.
- [ ] Ledger records carry the tool name where the transcript provides it (fixture).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
