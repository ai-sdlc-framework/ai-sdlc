---
id: AISDLC-674
title: >-
  RFC-0052: planner and synthesizer agent definitions with bounded inputs, evidence-cited findings and the grounding drop rule
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - plugin
  - agents
  - security
dependencies:
  - AISDLC-672
  - AISDLC-673
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - pipeline-cli/src/steps/08-aggregate-verdicts.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The two places the strongest model is used. The planner turns the risk map into a plan;
the synthesizer turns evidence into the verdict. Both read bounded inputs, never the
whole repository. RFC-0052 sections 1 (stages 3 and 5), 3 and 4.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0052-staged-review-pipeline.md`. Its Open Questions are
  resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest for packages, `node --test`
  for plugin scripts, 80% line coverage on new code.
- Tests never call a model or the network; spawners and fetch are injected.
- The developer agent never writes under `.ai-sdlc/`; repo config changes are operator
  steps with the YAML carried in the PR body.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **`review-planner` agent** (`ai-sdlc-plugin/agents/review-planner.md`): model from
   the routing cell `review-planner` (default `fable`, `opus` where unavailable);
   read-only tools; input is the risk map, the diff summary (file list, hunk headers,
   the top-ranked hunks in full up to a token budget), the acceptance criteria and the
   baseline checklist; output is a plan in the AISDLC-673 schema. The prompt restates
   the output contract after the diff content (the injection-hardening pattern the
   existing reviewers use) and tells the planner which hunks the injection screen
   flagged. The agent cannot drop baseline probes; validation enforces it regardless.
2. **`review-synthesizer` agent** (`ai-sdlc-plugin/agents/review-synthesizer.md`):
   same model cell `review-synthesizer`; input is the risk map, the plan, the evidence
   bundle, the acceptance criteria and the three remits (bugs and logic, tests,
   security) stated in full from the existing reviewer agents; output is the existing
   verdict envelope with `evidence` (probe ids and excerpts) on every finding and the
   `promptInjectionDetected` flag carried from the screen.
3. **Grounding drop rule** (`groundFindings(verdict, evidence)`): a finding whose
   `evidence` names no probe in the bundle, or cites an excerpt not present in it, is
   removed before aggregation and logged with the reason; the count of dropped
   findings is recorded on the verdict.
4. **Input budgets**: both agents receive inputs truncated by rank, never by position,
   and the truncation is recorded in the transcript.
5. **Transcript capture** for both agents follows the existing reviewer agents'
   mandatory capture section so AISDLC-676 can emit leaves.

## Acceptance Criteria
- [ ] The planner prompt contains the baseline checklist, the risk map and the diff summary, and its output for a fixture validates against the plan schema (mock spawner).
- [ ] The synthesizer output for a fixture evidence bundle is a valid verdict envelope in which every finding carries `evidence` naming a probe in the bundle.
- [ ] A finding citing a probe not in the bundle, or an excerpt not in the bundle, is dropped by `groundFindings` and counted.
- [ ] Both prompts restate the output contract after the diff-derived content, and the planner is told which hunks the injection screen flagged.
- [ ] Both agent definitions declare transcript capture as the existing reviewers do.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
