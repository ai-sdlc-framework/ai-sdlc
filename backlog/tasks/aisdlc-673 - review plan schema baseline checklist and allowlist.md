---
id: AISDLC-673
title: >-
  RFC-0052: review-plan schema, the baseline checklist as code, plan validation and coverage rejection, executor command allowlist
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - schema
  - security
dependencies: []
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/agents/correctness-reviewer.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The plan is the contract between the strongest model and the cheap executors, and the
baseline checklist is the part of that contract no plan can remove. RFC-0052 sections 1
(stage 3), 2 and 3.

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
1. **Schema** `spec/schemas/review-plan.v1.schema.json`: an ordered list of probes with
   `id`, `type` (`read`, `trace`, `run`, `compare`, `search`), `target` (files and line
   ranges, symbols, an allowlisted command, two revisions, or a search query), the
   `question` the probe answers, the hunk ids it covers, and `baseline: true` for
   checklist probes. Register with AJV and regenerate generated schemas.
2. **Baseline checklist** as code (`buildBaselineProbes(riskMap, task)`), producing
   the probes listed in RFC-0052 section 2: per changed source file a `read` of its
   hunks and changed tests; per hunk above the risk threshold a `read` and a `trace`
   of callers; the security probe set for hunks flagged for authentication,
   authorization, input handling, secrets, shell or path handling, manifests or
   workflows, derived from the checks in `ai-sdlc-plugin/agents/security-reviewer.md`;
   a `run` of the test runner over changed tests and a `compare` of acceptance
   criteria against test names and assertions; a `compare` per criterion the
   coverage judgment marked likely uncovered; a `search` for files outside the task's
   references. The checklist carries a version.
3. **Plan validation** `validatePlan(plan, baseline, riskMap, limits)`: schema-valid;
   every baseline probe present and unmodified; no hunk above the risk threshold left
   uncovered; probe count and total target size within limits; every `run` target in
   the allowlist. Returns the reason for each rejection.
4. **Fallback plan**: when a planner's output is rejected twice, the plan is the
   baseline plus a `read` probe per uncovered hunk, built without a model.
5. **Command allowlist**: read from `.ai-sdlc/review-config.yaml` on the base ref
   (`staged.executorCommandAllowlist`), defaulting to the repo's test, lint and
   typecheck scripts; nothing else may be a `run` target. Risk threshold, max probes
   and evidence budget are read the same way with documented defaults.

## Acceptance Criteria
- [ ] A plan missing a baseline probe, modifying one, leaving a high-risk hunk uncovered, exceeding the probe limit, or naming a non-allowlisted command is rejected with that reason (one test each).
- [ ] The baseline for a fixture risk map contains every probe RFC-0052 section 2 lists, and a hunk flagged for authentication gets the security probe set.
- [ ] The fallback plan covers every high-risk hunk and contains no model-authored probe.
- [ ] A working-tree copy of `review-config.yaml` is ignored; only the base ref is read.
- [ ] The schema is registered and `pnpm validate-schemas` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
