---
id: AISDLC-633
title: >-
  RFC-0049 OQ-5: generic OpenAI-compatible judgment adapter (Ollama, OpenAI, compatible gateways), shadow-only
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - adapter
  - adopter
  - phase-3
dependencies:
  - AISDLC-630
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/runners/generic-llm.ts
  - docs/operations/embedding-providers.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0049 OQ-5 (operator decision): adopters who cannot use a new vendor get a second
adapter that sends the same state and questions to any chat-completions endpoint. It
is lower fidelity by design. Its probabilities are a model self-report, so it declares
`calibratedProbabilities: false`, which the AISDLC-630 runtime already caps at `shadow`.

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
1. **Adapter** `createOpenAICompatibleProvider(opts)` registered under the name
   `openai-compatible`, in the judgment adapters directory beside the Jev adapter.
   Options come from `spec.providerOptions.openai-compatible` in the judgment config:
   `baseUrl`, `model`, `apiKeyEnv` (name of the env var holding the key; optional for
   local endpoints), `timeoutMs`.
2. **Request:** one chat-completions POST per evaluation containing the redacted state
   and every question. The system message instructs the model to return a single JSON
   object keyed by question id. For a choice it asks for the chosen option and a
   probability per option; for a score, the chosen level index and a probability per
   level; for a noul, a probability of yes. Send `response_format` with type
   `json_object`; on a 400 response retry once without it.
3. **Parsing:** strict parse first, then strip one code fence and parse. Validate every
   answer against its question: chosen option is one of the supplied options, level
   index is in range, probabilities are finite and non-negative. Normalise each
   distribution to sum to 1. When a distribution is absent, put the reported confidence
   on the chosen answer and spread the remainder evenly. `confidence` for choice and
   score is the largest probability. Any missing, malformed or out-of-set answer fails
   the whole call with kind `bad-response`.
4. **Capabilities:** `calibratedProbabilities` false; `billingModel` `pay-per-token`;
   cost rates 0 unless given in provider options; limits taken from provider options
   with conservative defaults.
5. **Loopback:** when `baseUrl` resolves to `localhost`, `127.0.0.1` or `::1`, the
   provider reports itself as local so the runtime's egress check is skipped
   (RFC-0049 OQ-2 resolution).
6. **Errors and retries** follow the Jev adapter's kinds and policy.

## Acceptance Criteria
- [ ] The adapter is registered as `openai-compatible` and selected by `spec.provider: openai-compatible` with its options read from `spec.providerOptions`.
- [ ] A well-formed model reply for a choice, a score and a noul maps to valid `JudgmentAnswer` values with distributions that sum to 1.
- [ ] A reply wrapped in a code fence parses; a reply naming an option that was not offered, omitting a question, or containing non-JSON fails with kind `bad-response`.
- [ ] A 400 on the first attempt triggers exactly one retry without `response_format`.
- [ ] With this provider active, a judgment configured `enforce` runs as `shadow` with the downgrade reason recorded (integration test through `evaluateJudgment`).
- [ ] A loopback `baseUrl` lets a `code-diff` judgment run without `code-diff` in `egress.allow`; a non-loopback `baseUrl` does not.
- [ ] No test touches the network; the key value never appears in errors or logs.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
