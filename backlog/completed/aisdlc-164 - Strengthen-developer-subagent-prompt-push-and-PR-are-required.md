---
id: AISDLC-164
title: 'Strengthen developer subagent prompt — push + PR are required, not optional'
status: Done
assignee: []
created_date: '2026-05-02'
labels:
  - spec
  - plugin
  - agent-prompt
  - devloop
dependencies: []
references:
  - ai-sdlc-plugin/agents/developer.md
  - backlog/completed/aisdlc-160 - Create-RFC-0010-phase-sub-tasks-AISDLC-70.1-through-70.9.md
  - backlog/completed/aisdlc-161 - Wire-up-DoR-calibration-data-collection-in-CI-and-enable-hybrid-Phase-8-promotion-path.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Multiple recent dev runs (AISDLC-160, 161, 162, etc.) returned with the commit landed but no push and no PR opened — citing "my role ends at commit, the orchestrator handles push + PR." This cost ~30s/run of orchestrator overhead per task AND lost the developer subagent's mid-stream context that produces a richer PR body than the orchestrator can synthesize from the JSON return alone.

The system prompt at `ai-sdlc-plugin/agents/developer.md` already said to push + open the PR (Step 8 in the typical workflow). The model was interpreting it as optional cleanup, mentally bucketing it as "the orchestrator's job."

This task tightens the prompt so push + PR are framed as core deliverables on equal footing with the commit itself: a prominent **Definition of Done** section, a hard rule statement, an explicit anti-pattern callout naming the prior failures, a `prUrl` REQUIRED field in the JSON return schema, and a CORRECT-vs-WRONG behavior example pair. The intent is zero plausible re-interpretation surface for "push is optional."
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc-plugin/agents/developer.md` has a clear, prominent "Hard rule: you MUST push and open the PR. Returning without pushing or without opening the PR is INCORRECT." statement
- [x] #2 Push + PR step moved out of the workflow numbered list and into a top-level "Definition of Done" section so it cannot be mentally bucketed as optional cleanup
- [x] #3 JSON return schema makes `prUrl` REQUIRED (not optional) with note: "if you returned without `prUrl`, you have failed the task"
- [x] #4 CORRECT behavior example + WRONG interpretation example (citing the AISDLC-160/161/162 failure mode verbatim) included so the model has explicit anti-pattern coverage
- [x] #5 Rest of the agent's responsibilities unchanged — only the push + PR contract was tightened
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:NOTES:BEGIN -->
Single-file edit to `ai-sdlc-plugin/agents/developer.md`:

- New top-level "Definition of Done — read this FIRST and last" section placed BEFORE "Your environment" so it lands in the model's working set early, with the hard-rule statement formatted as a blockquote for visual prominence.
- CORRECT and WRONG behavior code blocks side-by-side, with the WRONG block quoting the exact "orchestrator handles push + PR" rationalization observed in AISDLC-160/161/162 returns.
- Workflow section: kept the existing 4-step plan/implement/verify/commit list intact, then added a blockquote callout immediately after listing push + PR as mandatory follow-on stages with explicit `git push -u origin HEAD` and `gh pr create` commands plus the two required progress lines (`[ai-sdlc-progress] push:` and `[ai-sdlc-progress] pr:`).
- Return schema: added `prUrl` field to the JSON example, then a "Required fields" subsection asserting `prUrl` is required and quoting the "you have failed the task" line. A "Failure / blocker returns" subsection distinguishes the legitimate `prUrl: null` exemption (no commit to push) from the illegitimate one (committed but skipped push).

No other prompt content changed — file budget = 1.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Tightened the developer subagent prompt (`ai-sdlc-plugin/agents/developer.md`) to eliminate the re-interpretation surface that made multiple recent dev runs (AISDLC-160, 161, 162) return at commit-landed-but-no-PR. Push + `gh pr create` are now framed as core deliverables on equal footing with the commit, with a prominent Definition of Done section, an anti-pattern example pair, and a required `prUrl` field in the JSON return schema.

## Changes
- `ai-sdlc-plugin/agents/developer.md` (modified): added Definition of Done section with hard-rule statement and CORRECT/WRONG examples; promoted push + `gh pr create` from workflow step 8 to mandatory follow-on stages with explicit commands; made `prUrl` REQUIRED in the JSON schema and added a Failure/blocker subsection that distinguishes legitimate `prUrl: null` (no commit to push) from illegitimate (committed but skipped push).

## Design decisions
- **Definition-of-Done framing over additional workflow step**: a numbered step buries the requirement; a top-level section with a blockquote hard rule lands in the model's attention budget early and re-anchors at the return-schema section.
- **Verbatim quote of the prior rationalization**: explicitly naming the "my role ends at commit, the orchestrator handles push + PR" phrasing in the WRONG example gives the model exact anti-pattern coverage rather than a generic "don't skip the PR" hedge.
- **Two-tier null-`prUrl` semantics**: distinguishing "no commit, no PR — legitimate blocker" from "committed but skipped PR — failure" prevents the model from using the blocker exemption as an escape hatch.

## Verification
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
(none) — observe whether subsequent dev runs return with `prUrl` populated; if regressions persist, consider an orchestrator-side preflight that refuses to accept a return JSON without `prUrl` and re-prompts the subagent with a citation of the failure.
