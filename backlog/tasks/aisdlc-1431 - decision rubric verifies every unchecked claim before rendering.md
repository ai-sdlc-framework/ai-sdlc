---
id: AISDLC-1431
title: Decision rubric verifies every unchecked claim with a research pass before rendering
status: To Do
priority: high
labels:
  - ai-sdlc-plugin
  - skills
  - governance
dependencies: []
references:
  - ai-sdlc-plugin/skills/decision-rubric/SKILL.md
---

## Description

**Five-step review (requirements first).**
1. Question: step 3 of `ai-sdlc-plugin/skills/decision-rubric/SKILL.md` lets a claim reach the operator tagged **unchecked**, and the presentation then names "the one thing to check" for the operator to verify. The skill's own table attributes about 10 of the ~37 reversed decisions to "a fact was wrong or never checked against its source". Requested by the operator on 2026-11-26: before a decision is rendered, the rubric must run research to verify every unchecked claim and path. The requirement holds: verifying is cheap for an agent (a grep, a read, a web fetch), but costly when an operator is asked to do it, or when nobody does.
2. Delete: the pattern where the operator is handed an unchecked fact to verify themselves. "The one thing to check" stays, but it becomes the weakest fact that **could not** be verified, with the reason.
3. Simplify: add one required step between today's step 3 (evidence) and step 4 (options), called "Verify". For every claim tagged unchecked, and every trace item marked "undefined" or not yet looked up in step 5, the agent runs a research task: a read-only `Explore`/Sonnet subagent for repository claims (grep, file:line, run a command), and a web fetch for external facts (standards status, library behaviour, comparable systems). The agent re-tags each item **checked** (with source) or **unverifiable** (with what was tried and what verifying it would take). The decision is not rendered while any item is still plain unchecked. Batch all items into one research subagent where possible, so the cost stays at one round. Update the presentation chunk "The one thing to check" and the Recording section's `Check:` line to point at the weakest **unverifiable** item. Autonomous mode gets the same step.
4. Accelerate: one batched research pass, run in parallel with drafting the options.
5. Automate: none in this task. A later lint over `--rationale` text for the word "unchecked" is possible but not requested.

Note for the operator, not part of this task: a user-level copy at `~/.claude/skills/decision-rubric/SKILL.md` (dated 2026-05-20) differs from the plugin copy and shadows the name `decision-rubric` outside the plugin namespace. Delete or refresh it by hand; it is outside the repo.

## Acceptance Criteria
- [ ] #1 `SKILL.md` has a required "Verify" step after evidence. It requires a research pass for every unchecked evidence claim and every unresolved trace item before options are rendered, with the subagent / web-fetch split above and batching into one pass.
- [ ] #2 The evidence tags become checked / unverifiable. "unchecked" is allowed only in a draft, and the anti-patterns list gains "rendering a decision with a claim still unchecked".
- [ ] #3 "The one thing to check" (presentation) and `Check:` (recording) refer to the weakest unverifiable item and carry the reason it could not be verified.
- [ ] #4 Autonomous mode states that the Verify step applies unchanged.
- [ ] #5 The step-to-cause table maps "A fact was wrong or never checked" to steps 3 and Verify. The worked example shows one item that was moved from unchecked to checked by the research pass.
- [ ] #6 Any test or lint that pins the skill's step count or headings is updated. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
