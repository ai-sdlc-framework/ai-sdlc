---
id: AISDLC-982
title: 'model-routing.yaml is the single source for role to model; fill the cells; pins gate asserts frontmatter equals the table'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - config
  - tooling
dependencies: []
references:
  - .ai-sdlc/model-routing.yaml
  - pipeline-cli/src/dispatch/reviewer-harness.ts
  - pipeline-cli/src/review-plan/executor.ts
  - ai-sdlc-plugin/commands/model-pins.test.mjs
  - ai-sdlc-plugin/agents/review-executor.md
priority: medium
dispatchable: true
---

## Description

`.ai-sdlc/model-routing.yaml` (RFC-0050) has cells only for `developer`, `code-reviewer`, `test-reviewer`, `review-executor` (all `sonnet`) and `security-reviewer` (`opus`). There is no cell for `review-planner`, `review-synthesizer`, `correctness-reviewer`, the `-codex` variants, or the commands. The cells that exist disagree with the frontmatter: the table says `review-executor: sonnet` while `ai-sdlc-plugin/agents/review-executor.md:16` pins `model: haiku`; `ai-sdlc-plugin/commands/planner.md:12` pins `sonnet` while the hierarchy launch passes `--model` from `opts.plannerModel` (`pipeline-cli/src/hierarchy/up.ts:161` and `:181`), which the roster sets to `fable`. The code hard-codes models too: `pipeline-cli/src/dispatch/reviewer-harness.ts:58-113` returns `model: 'sonnet'` and `model: 'opus'` literals per role (and `'inherit'` for the codex variants), and `pipeline-cli/src/review-plan/executor.ts:295` has `export const DEFAULT_EXECUTOR_MODEL = 'sonnet'`. The pins gate `ai-sdlc-plugin/commands/model-pins.test.mjs` only asserts each file pins a non-`inherit` model against lists kept inside the test (`haikuAgents`, `sonnetAgents`, `:128-160`).

Operator decision (2026-10-20): the table is the source. Every agent and command role gets a cell; the pins gate reads the yaml and asserts each agent and command `model:` equals its cell; the hard-coded literals in `reviewer-harness.ts` and `executor.ts` are replaced by table lookups; the hierarchy launch reads the planner cell. Values: `review-executor: haiku`, `planner: fable`, everything else as pinned today. Adopters override by editing the table. Two related clean-ups ride along: the stale `Co-Authored-By: Claude Opus 4.6 (1M context)` trailer in `ai-sdlc-plugin/agents/developer.md:92`, `ai-sdlc-plugin/commands/rebase.md:269`, `ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh:438` and `ai-sdlc-plugin/scripts/check-attestation-sign.sh:502` is replaced by a value derived from the routed model; and the duplicate iteration cap (`const DEFAULT_MAX_ITERATIONS = 2;` at `pipeline-cli/src/steps/09-iterate.ts:37` and `const MAX_ITERATIONS = 2;` at `pipeline-cli/src/next-step/next-step.ts:107`) collapses onto one exported constant.

**Five-step review (requirements first).**
1. Requirement questioned: do we need both a table and frontmatter pins? The harness reads frontmatter, so pins stay; the table becomes the source the gate checks them against, instead of lists inside a test.
2. Delete: the role lists inside `model-pins.test.mjs`, the model literals in `reviewer-harness.ts` and `executor.ts`, the duplicate iteration constant.
3. Simplify: one lookup function (role to model) used by the harness, the review-plan executor, the hierarchy launch and the pins gate.
4. Accelerate: changing a role's model is one yaml edit, no code change.
5. Automate: the pins gate fails on any frontmatter that drifts from its cell or any role without a cell.

## Acceptance Criteria

- [ ] `.ai-sdlc/model-routing.yaml` has a cell for every agent under `ai-sdlc-plugin/agents/` and every command under `ai-sdlc-plugin/commands/`, with `review-executor: haiku` and `planner: fable`.
- [ ] `model-pins.test.mjs` reads the yaml and fails when any agent or command `model:` differs from its cell or has no cell.
- [ ] `reviewer-harness.ts`, `review-plan/executor.ts` and the hierarchy launch resolve models through one table lookup; no model literal remains in those files.
- [ ] The `Claude Opus 4.6` trailer is gone from the four plugin files and the trailer is derived from the routed model; one iteration-cap constant remains.
