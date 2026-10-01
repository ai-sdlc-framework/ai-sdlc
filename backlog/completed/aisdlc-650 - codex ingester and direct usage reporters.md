---
id: AISDLC-650
title: >-
  RFC-0050 Part A: Codex session ingester and direct usage reporters for API runners and embeddings
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - orchestrator
  - codex
dependencies:
  - AISDLC-648
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/runners/review-agent.ts
  - orchestrator/src/runners/security-triage.ts
  - orchestrator/src/embedding/adapters/openai-text-embedding-3-small.ts
  - orchestrator/src/harness/adapters/codex.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Covers the model calls that do not appear in Claude Code transcripts: reviews run on
Codex, and calls the framework makes itself with an API key. RFC-0050 section A2.

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
1. **Codex ingester:** reads Codex session files (one JSONL per session under the
   Codex home's sessions directory, path injectable). Usage arrives as events whose
   payload type is `token_count`, carrying cumulative `total_token_usage` and
   per-turn `last_token_usage` with `input_tokens`, `cached_input_tokens`,
   `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens`. Write one
   record per turn from `last_token_usage`; when a session only reports a total with no
   breakdown, write one record per session with the total in `input` and a flag
   `breakdownMissing`. `harness` is `codex`, `billingPool` is `codex-plan`, and the
   model is taken from the session's metadata when present. The `callId` is derived
   from the session id and the event ordinal. Scope and task attribution follow the
   same rules as the Claude Code ingester, using the session's working directory.
2. **Rate-limit capture:** when a `token_count` event carries a non-empty
   `rate_limits` object, write it to `limit-events.jsonl` as a window observation
   (window name, percent used, reset time where given).
3. **`cli-usage ingest`** runs the Codex ingester alongside the Claude Code one when
   AISDLC-649 has landed; until then it is reachable through its own subcommand flag.
4. **Direct reporters:** the API-key runners in
   `orchestrator/src/runners/review-agent.ts` and
   `orchestrator/src/runners/security-triage.ts` already receive token usage from the
   provider and drop it. Report each call through `recordModelCall` with
   `billingPool: 'api-key'`, the agent role of the runner, and the task or issue id
   when the runner has one. The embedding adapter reports its calls with the token
   total in `input`.
5. **No double counting:** a call reported directly must not also be ingested from a
   transcript. Direct reporters are used only on paths that write no harness
   transcript; state this in a comment at each call site.

## Acceptance Criteria
- [x] A synthetic Codex session with three `token_count` events ingests to three records with the per-turn token classes mapped correctly.
- [x] A session that reports only a total produces one record flagged `breakdownMissing`.
- [x] Re-running the Codex ingester writes nothing new.
- [x] A `token_count` event with a `rate_limits` object produces a window observation in `limit-events.jsonl`; a null `rate_limits` produces none.
- [x] A review run through the API-key review runner with an injected fetch writes one ledger record with `billingPool` `api-key` and the provider-reported token counts.
- [x] The security triage runner and the embedding adapter each write one record per call.
- [x] With the usage directory unwritable, all three direct call sites return their normal results.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added a Codex session ingester with rate-limit capture and its own `cli-usage-codex ingest` entry, and made the three API-key call sites (review runner, security triage, embedding adapter) report each call to the usage ledger with billing pool `api-key`. All eight acceptance criteria have tests.

## Changes
- `pipeline-cli/src/usage/codex-ingester.ts`, `codex-attribution.ts`, `pipeline-cli/src/cli/usage-codex.ts`, `pipeline-cli/bin/cli-usage-codex.mjs`, `pipeline-cli/package.json`: the ingester, its attribution rules and its entry point.
- `orchestrator/src/usage/direct-usage.ts` plus the review runner, security triage and embedding adapter: direct reporters that never change a runner's result when the usage directory is unwritable, each with a no-double-counting comment.
- `spec/schemas/model-call-record.v1.schema.json`, `reference/src/usage/types.ts`, `reference/src/core/generated-schemas.ts`: optional `breakdownMissing` boolean on the record.
- `orchestrator/vitest.config.ts`: points `AI_SDLC_USAGE_DIR` at a temporary directory so runner tests never write to the real home directory.

## Design decisions
- Token mapping: Codex counts cached and cache-write tokens inside input, so input is input minus cached minus cache-write (floored at zero), reasoning stays a subset of output. This is a reading of Codex's semantics that neither the task nor the RFC states.
- The call id is the session id plus the event ordinal; a total-only session gets one record with the total in input and `breakdownMissing`. Repeated cumulative totals are skipped.
- The cursor key is namespaced `codex:<file>` so a later Claude Code ingester cannot collide with it.
- The schema gained `breakdownMissing` because the record schema rejects unknown fields; the RFC does not list the field, and the change is additive.
- Scope 3 (run inside `cli-usage ingest`) is not done because the Claude Code ingester has not landed; the ingester has its own entry instead, as the task allows.

## Verification
- `pnpm build` — passed (reference, orchestrator, pipeline-cli)
- `pnpm test` — reference and orchestrator suites passed in full; new tests pass (ingester 11, direct reporters 9). Seven pipeline-cli tests (bin-invocation, verify-runtime) fail identically on a checkout without this change.
- `pnpm lint` — passed
- `pnpm format:check` — passed on touched files
- `pnpm dark-code:check` — passed
- 3 parallel reviews approved (Claude-native reviewers); the reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-663: fold the Codex ingester into `cli-usage ingest` once the Claude Code ingester lands, and the review findings on limit-event duplication, total-only staleness, direct-reporter lock blocking and size caps.
<!-- SECTION:FINAL_SUMMARY:END -->
