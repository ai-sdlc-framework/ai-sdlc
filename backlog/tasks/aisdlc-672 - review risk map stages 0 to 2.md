---
id: AISDLC-672
title: >-
  RFC-0052: review risk map (deterministic facts, structural facts, judgment request) and its schema
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - judgment-layer
  - pipeline-cli
dependencies:
  - AISDLC-637
  - AISDLC-638
  - AISDLC-639
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/pipeline/ast-gate.ts
  - pipeline-cli/bin/cli-deps.mjs
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The first three stages of the staged review pipeline, all of which run before any
generative model: facts code can compute about the diff, facts the dependency graph and
coverage data provide, and the judgment layer's classification of each hunk. Their
output, the risk map, is what the planner reads instead of the whole diff. RFC-0052
sections 1 (stages 0 to 2) and 3.

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
1. **Schema** `spec/schemas/review-risk-map.v1.schema.json`: per hunk, the file, the
   hunk header and line range, file class, whether the file's tests changed, changed
   symbols, callers and callees, patch-coverage lines, the judgment probabilities
   (authentication or authorization, state or persistence, concurrency, input
   handling, error handling, behaviour change without test change), a risk score, and
   a `judged` flag; across the diff, the acceptance-criteria coverage result, the
   injection-screen result and the routing result. Register with AJV and regenerate
   generated schemas.
2. **Stage 0 (code):** diff statistics, file classes by the path rules the review
   classifier already uses, changed-test detection per source file, secret-pattern
   scan with `redactSecrets`, dependency-manifest and workflow change flags, the
   task's acceptance criteria, and the developer's recorded verification results.
3. **Stage 1 (code):** changed symbols per hunk from the AST gate's parser where the
   language is supported, callers and callees from the dependency graph (`cli-deps`),
   test files that reference changed symbols, patch-coverage lines for the hunk, and
   schema consumers for changed schema files. Unsupported languages record
   `structural: unavailable` and are treated as high risk.
4. **Stage 2 (judgment):** one judgment request per diff (split by the state budget
   when needed) through the RFC-0049 runtime: the per-hunk Nouls and the risk Score,
   plus `dev.ac-coverage`, `triage.injection-screen` and `review.routing`. A hunk the
   layer abstains on is marked `judged: false` and ranked as high risk.
5. **`buildRiskMap(diff, opts)`** returning the validated map, ranked by risk, with a
   JSON file written under the artifacts directory for the run.

## Acceptance Criteria
- [ ] For a fixture diff touching three files, the risk map lists every hunk with file class, changed-test flag, changed symbols and coverage lines, and validates against the schema.
- [ ] With the judgment layer disabled, every hunk is `judged: false` and ranked high; with a fake provider, the Nouls and Score appear on each hunk and the ranking follows the Score.
- [ ] A hunk in an unsupported language is marked `structural: unavailable` and ranked high.
- [ ] A secret matched by `redactSecrets` in the diff appears in the map as a redacted marker, never as the secret.
- [ ] The injection-screen and acceptance-criteria results appear at the diff level, and the map file is written under the artifacts directory.
- [ ] The schema is registered and `pnpm validate-schemas` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
