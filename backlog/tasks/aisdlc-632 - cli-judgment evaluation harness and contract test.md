---
id: AISDLC-632
title: >-
  RFC-0049 Phase 3: cli-judgment doctor/ask/eval/replay, promotion-record output, key-gated live contract test
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-3
  - cli
  - evaluation
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/bin/cli-dor-corpus.mjs
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - docs/operations/dor-promotion.md
  - pipeline-cli/README.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The tooling an operator uses to measure a judgment before promoting it, and the test
that detects drift between the recorded fixtures and the live API. RFC-0049 section 8
is the specification. Everything here is hermetic except the contract test, which is
skipped unless a key and an explicit opt-in are present.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Its Open Questions
  are resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No vendor SDK and no new runtime dependency. HTTP goes through an injectable `fetch`;
  tests never touch the network.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **CLI** `cli-judgment`, a new bin shim under `pipeline-cli/bin/` plus its source under
   `pipeline-cli/src/cli/`, following the existing `cli-dor-corpus` layout and the
   invocation rule enforced by `pipeline-cli/src/cli/bin-invocation.test.ts`:
   - `doctor`: layer enabled or not, provider, key present, model pinned, and for
     `--live` one minimal request reporting the returned `modelVersion` and latency.
   - `list`: every registered definition with id, version, `riskClass`, `direction`,
     `egressClass`, configured mode and effective mode.
   - `ask <judgment-id> --input <json-file>`: one evaluation in a forced
     evaluate-and-print mode; prints answers with probabilities, the outcome and the
     thresholds used. Respects egress rules.
   - `eval <judgment-id> --corpus <jsonl>`: each corpus line is an object with `input`
     and `label`. Runs the judgment per line (cache on), applies `compose` at the
     configured thresholds, and compares with `definition.agrees`. Report: `n`, share of
     items in each band (act, escalate, abstain), act-band precision, a confusion table
     of decision against label where decisions are enumerable, latency p50 and p95,
     total input tokens and cost. `--sweep <name>=<from>:<to>:<step>` recomputes the
     report across a threshold range from the stored answers without new provider calls.
     Writes the report to `.ai-sdlc/judgment-evals/<id>-<provider>-<model>-<date>.json`
     and prints the `promotion` YAML snippet for the config (RFC-0049 section 6),
     stating whether it meets the definition's `riskClass` bar.
   - `replay --since <date> [--judgment <id>]`: reads the judgment log, recomputes
     outcomes from the logged answers under thresholds given on the command line, and
     reports agreement with the logged `incumbent` where present. No provider calls.
2. **Exit codes:** `eval` exits non-zero when the corpus is unreadable or the definition
   has no `agrees`; it exits zero whether or not the bar is met (the verdict is in the
   output, the operator decides).
3. **Live contract test** beside the Jev adapter tests: runs only when
   `TYPESAFE_API_KEY` is set and `AI_SDLC_LIVE_CONTRACT=1`; otherwise reported as
   skipped. Sends one request with a choice, a score and a noul, and asserts the live
   response parses through the adapter with the same field set as the recorded
   fixtures. It is not part of the default `pnpm test` pass criteria in CI.
4. **README:** a short `cli-judgment` section in `pipeline-cli/README.md`.

## Acceptance Criteria
- [ ] `node pipeline-cli/bin/cli-judgment.mjs --help` lists `doctor`, `list`, `ask`, `eval` and `replay`, and the bin-invocation test covers the new shim.
- [ ] `eval` over a fixture corpus with a fake provider reports the correct `n`, band shares and act-band precision for a hand-computed case.
- [ ] `--sweep` produces one report row per threshold step and the fake provider receives no additional requests during the sweep.
- [ ] `eval` writes the report file and prints a `promotion` snippet whose `n` and `actBandPrecision` match the report, with a clear met or not-met statement for `seam`, `tighten` and `relax` definitions.
- [ ] `replay` reproduces logged outcomes when given the logged thresholds and reports incumbent agreement from `shadow` records.
- [ ] `ask` refuses a definition whose `egressClass` is not allowed and says which config key would allow it.
- [ ] The live contract test is skipped without `TYPESAFE_API_KEY` and `AI_SDLC_LIVE_CONTRACT=1`, and the skip is visible in test output.
- [ ] `pipeline-cli/README.md` documents the five subcommands.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
