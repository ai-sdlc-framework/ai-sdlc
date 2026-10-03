---
id: AISDLC-675
title: >-
  RFC-0052: read-only, tool-restricted executor probe subagents per type, evidence schema and budgets, parallel fan-out
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - review
  - plugin
  - agents
  - security
dependencies:
  - AISDLC-673
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - ai-sdlc-plugin/agents/code-reviewer.md
  - pipeline-cli/bin/cli-deps.mjs
  - docs/operations/cross-harness-review.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The cheap stage: one subagent per probe, each with only the tools its probe type needs,
returning evidence in a fixed shape. RFC-0052 section 1 (stage 4) and section 3.

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
1. **Evidence schema** `spec/schemas/review-evidence.v1.schema.json`: per probe, the
   probe id, observations, excerpts with file and line range, commands run with exit
   status and bounded output, the probe's answer to its question with a confidence
   word, and the harness and model that ran it. Register with AJV and regenerate
   generated schemas.
2. **`review-executor` agent** (`ai-sdlc-plugin/agents/review-executor.md`): model from
   the routing cell `review-executor` (default `sonnet`); tools by probe type: `read`
   and `search` get read-only file access; `trace` gets the dependency graph CLI;
   `run` gets Bash restricted to the allowlisted commands; `compare` gets read-only
   access to two revisions. No `Write`, no `Edit`, no `git push`, no agent dispatch, no
   model selection of its own. The prompt restates the output contract after the
   target content.
3. **Fan-out** `executePlan(plan, spawner, limits)`: runs probes in parallel up to a
   configured width, enforces per-probe and total evidence budgets (an over-budget
   probe's evidence is truncated with a marker, never silently), collects the bundle,
   and records per-probe latency and tokens for the usage ledger.
4. **Codex option**: when the Codex harness is available and the task is trusted,
   probes may run on the `-codex` variant, following the cross-harness review
   defaults in `docs/operations/cross-harness-review.md`; the evidence records the
   harness.
5. **Transcript capture** per probe as the existing reviewers do.


### Hard requirement carried from AISDLC-673 review (DEC-0019, 2026-10-03)

Probe targets are the trust boundary for what the review model sees. The 673
security review (MEDIUM, declined in 673's Final Summary and accepted for v1 only
on the condition that 675 closes it) found that read, search and compare targets are
not limited to git-tracked files, so a gitignored `.env` or other untracked secret is
reachable. 675 MUST:

- resolve read/search targets from `git ls-files` (tracked) plus the diff's added
  paths only; a target outside that set is refused before any read;
- redact evidence with the framework's `redactSecrets` before it enters the bundle;
- re-check containment at open time with `realpath` and `O_NOFOLLOW` (TOCTOU), not
  only at plan validation;
- cap `run` probes per plan (default 2) independently of `maxProbes`, so a plan
  cannot schedule `maxProbes` full test runs.

## Acceptance Criteria
- [x] A plan naming a gitignored file (fixture `.env`) as a read, search or compare target is refused before any read, and the refusal is recorded in the bundle.
- [x] A symlink swapped in between validation and open is refused (realpath + O_NOFOLLOW test).
- [x] Evidence containing a fixture secret is redacted in the bundle.
- [x] A plan with more `run` probes than the run cap executes only the cap and records the rest as skipped.
- [x] Each probe type's agent invocation carries only the tools RFC-0052 permits for that type (asserted on the mock spawner's spawn options).
- [x] A `run` probe with a command outside the allowlist is refused before any spawn.
- [x] A fixture plan with six probes runs with the configured width and yields a bundle that validates against the evidence schema with one entry per probe.
- [x] An over-budget probe is truncated with a marker and the bundle total stays within the budget.
- [x] A probe run on the Codex variant records `harness: codex` in its evidence.
- [x] The schema is registered and `pnpm validate-schemas` passes.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL-SUMMARY:BEGIN -->
## Summary
Ships the review executor as a library: the evidence schema, the `review-executor` agent (and a Codex variant), and `executePlan`, which runs probes in parallel under per-probe and total evidence budgets and enforces the hard security requirement from the plan review.

## Changes
- `spec/schemas/review-evidence.v1.schema.json` (new), `reference/src/core/validation.ts` and `index.ts` (modified), `reference/src/core/review-evidence-schema.test.ts` (new): the schema and `validateReviewEvidence`.
- `pipeline-cli/src/review-plan/executor.ts` and `executor.test.ts` (new), `index.ts` (modified): `executePlan`.
- `ai-sdlc-plugin/agents/review-executor.md` and `review-executor-codex.md` (new), `agents.test.mjs` (modified).
- `backlog/tasks/aisdlc-676 - ...` (modified): the production-adapter scope and acceptance criterion.

## Design decisions
- **ProbeSpawner.spawnProbe, not a wider SubagentSpawner**: the probe needs (tools, file scope, harness) are probe-only, the acceptance criterion asserts only the mock's options, and a closed union sits behind three exhaustive tables. A spawner must declare `enforcesFileScope: true` or any probe with a file scope is refused before spawn.
- **Run cap counts every run probe**, baseline included, in plan order: the executor cannot trust the plan's baseline flag. The plan validator counts only added run probes, so one baseline plus two added leaves one skipped.

## Verification
- `pnpm build` clean; `pnpm validate-schemas` clean; `pnpm dark-code:check` clean.
- review-plan tests 220 passed; agents tests 51 passed; evidence schema tests 3 passed.

## Follow-up
- AISDLC-676 carries the production ProbeSpawner adapter.
<!-- SECTION:FINAL-SUMMARY:END -->
