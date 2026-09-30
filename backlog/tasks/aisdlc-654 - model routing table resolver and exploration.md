---
id: AISDLC-654
title: >-
  RFC-0050 Part B: model-routing table, resolveModel, deterministic exploration, assignment log, wiring
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - pipeline-cli
  - plugin
  - schema
dependencies:
  - AISDLC-649
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.ts
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/estimation/types.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Makes the model for each role a looked-up value with a recorded reason, and adds the
exploration mechanism that produces comparisons between models from work that runs
anyway. With no table file the result is exactly today's per-role pins. RFC-0050
sections B2 and B3, and the OQ-2 resolution.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Schema and loader:** `spec/schemas/model-routing.v1.schema.json` for kind
   `ModelRouting` (RFC-0050 section B2): `strength` (ordered list, weakest first),
   `exploreShare`, a `salt`, `cells` keyed by role then task class (with `*` as the
   wildcard) each holding `model` and optional `candidates`, and `evidence` keyed by
   cell. Register with AJV and regenerate generated schemas. The loader reads
   `.ai-sdlc/model-routing.yaml` from the base ref only, following
   `pipeline-cli/src/steps/reviewer-set.ts`; a missing or invalid file yields the
   built-in default table. A `candidates` entry on the security reviewer role, or a
   model missing from `strength`, is a validation error that falls back to defaults.
2. **Built-in default table** reproducing the current per-role models from
   `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` and the agent definitions, with
   no candidates.
3. **`resolveModel(input)`** taking role, task class, task id, `sourceKind` and
   iteration, returning model, arm (`table`, `explore`, `override`, `default`) and
   reason. Pure: same inputs and same files give the same result. Order: an override
   (file shape defined here, written by AISDLC-656) wins; then exploration; then the
   table cell; then the wildcard cell; then the built-in default.
4. **Exploration:** eligible only when the cell has candidates, `sourceKind` is
   `backlog`, the role is not the security reviewer, and iteration is 1. The arm is
   chosen from a SHA-256 of task id, role and salt: the value modulo 10000 is compared
   with `exploreShare`, and the candidate index comes from the same hash. For iteration
   2 and later the resolver returns the arm recorded for iteration 1.
5. **Assignment log:** every resolution is appended to
   `assignments.jsonl` in the repository's artifacts directory with timestamp, task,
   role, task class, iteration, model, arm and reason. Appending never fails the
   caller.
6. **Wiring:**
   - the Tier 2 spawner consults the resolver in place of its fixed per-role map;
   - Step 5 (`pipeline-cli/src/steps/05-build-dev-prompt.ts`) and Step 7
     (`pipeline-cli/src/steps/07-build-review-prompts.ts`) return the resolved model
     per agent, and the plugin step tools
     (`ai-sdlc-plugin/mcp-server/src/tools/pipeline-tools.ts`) surface it;
   - `ai-sdlc-plugin/commands/execute.md` passes the returned model on each agent call
     and writes it to the transcript leaf's model field in place of the fixed default.
7. **Task class** comes from the estimation class (`pipeline-cli/src/estimation/types.ts`),
   `uncategorized` when none is recorded.
8. **Capability:** when the capability registry is present, report `routing.table` as
   `live` when a repository table is in use and `degraded` with reason `default-table`
   otherwise.

## Acceptance Criteria
- [ ] With no `model-routing.yaml` on the base ref, `resolveModel` returns for every role the same model the spawner's fixed map returns today (asserted against that map).
- [ ] A working-tree copy of the table is ignored; only the base ref is read.
- [ ] A table with `candidates` on the security reviewer, or a model absent from `strength`, fails validation and the built-in defaults are used.
- [ ] For a cell with `exploreShare` 0.10 and one candidate, resolving 10,000 synthetic task ids sends between 8 and 12 percent to the candidate, and resolving any one id twice returns the same arm.
- [ ] `sourceKind` `gh-issue` never explores, and the security reviewer never explores, whatever the table says.
- [ ] Iteration 2 of a task returns the arm logged for iteration 1.
- [ ] An override entry wins over exploration and the table, and the returned arm is `override`.
- [ ] Every resolution appends one assignment-log line, and an unwritable log does not change the returned model.
- [ ] Step 5 and Step 7 outputs include the resolved model per agent, and the step tools expose it.
- [ ] `execute.md` passes the resolved model on the developer and reviewer agent calls and no longer writes a fixed default model into the transcript leaf.
- [ ] The schema is registered, `generated-schemas.ts` is regenerated and committed, and `pnpm validate-schemas` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
