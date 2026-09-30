---
id: AISDLC-629
title: >-
  RFC-0049 Phase 0: JudgmentProvider interface, registry, fake provider and thin-fetch Jev adapter
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-0
  - reference
  - adapter
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/embedding/types.ts
  - orchestrator/src/embedding/registry.ts
  - orchestrator/src/sa-scoring/depparse-client.ts
  - reference/src/index.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0049 adds a judgment layer: closed-set questions (choice, score, yes/no) answered
with probabilities and no generated text. This task ships the provider-neutral
interface and the first adapter, Jev (typesafe.ai), in a new directory
`reference/src/judgment/`. Nothing calls it yet; later tasks in the series do.

Model the adapter and registry on `orchestrator/src/embedding/types.ts` and
`orchestrator/src/embedding/registry.ts`, and the HTTP client on
`orchestrator/src/sa-scoring/depparse-client.ts` (typed error kinds, per-attempt
timeout, injectable fetch).

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
1. **Types** in the new judgment directory, exactly as RFC-0049 section 2:
   `Entry`, `JudgmentQuestion` (choice with `options`, score with ordered `levels`,
   noul with optional `criteria`), `JudgmentAnswer`, `JudgmentRequest`,
   `JudgmentResponse`, `JudgmentProvider`, and `JudgmentCapabilities` with
   `maxStateTokens`, `maxRequestTokens`, `maxChoiceOptions`, `maxScoreLevels`,
   `billingModel`, `inputCostPer1MTokens`, `outputCostPer1MTokens`,
   `calibratedProbabilities`.
2. **Errors:** `JudgmentProviderError` with `kind` one of `auth`, `validation`,
   `rate-limited`, `overloaded`, `timeout`, `network`, `bad-response`. The API key never
   appears in a message or a logged value.
3. **Registry:** `registerJudgmentProvider`, `getJudgmentProvider(name)`,
   `listJudgmentProviders`, and `UnknownJudgmentProviderError`.
4. **`FakeJudgmentProvider`:** scripted answers per question id (value or function of
   the request), records every request it receives, can be told to throw a given error
   kind. Used by every later task's tests.
5. **Jev adapter** `createJevProvider(opts)` with options `apiKey`, `baseUrl`, `model`,
   `timeoutMs` (default 10000), `maxRetries` (default 2), `fetchImpl`, `sleep`:
   - Key from `opts.apiKey`, else env `TYPESAFE_API_KEY`. Base URL from `opts.baseUrl`,
     else env `TYPESAFE_BASE_URL`, else the default host in the Endpoint block below.
     Header `Authorization: Bearer <key>`.
   - Request mapping: `options` and `levels` both go on the wire as `criteria`
     (see the wire format below). Question ids are the map keys.
   - Response mapping: choice keeps `choice`, `probabilities`, `confidence`; score keeps
     `score`, `confidence`, and turns the `probabilities` map keyed `"0".."n-1"` into an
     array ordered by level index; noul maps the wire field `noul` to `probability`.
     `modelVersion` is the response's `model`. `usage` maps `input_tokens` and
     `output_tokens`. `latencyMs` is measured around the whole call including retries.
   - Validate before sending, with no network call on failure (`validation`): at least
     one question; a choice has 2 to 255 options; a score has 2 to 10 levels.
   - Validate the response (`bad-response`): every question id has an answer of the
     matching type; a choice answer names one of the supplied options; probabilities
     are finite numbers.
   - HTTP handling: 401 is `auth` and 422 is `validation`, neither retried. 429
     (`rate-limited`), 529 (`overloaded`) and other 5xx are retried with exponential
     backoff, honouring a `retry-after` header when present. A per-attempt
     `AbortController` timeout yields `timeout`. A thrown fetch yields `network`.
   - `isAvailable()` checks key presence only. `getAccountId()` returns the first 16 hex
     chars of `sha256("jev:" + key)`, or null without a key.
   - Capabilities: `maxStateTokens` 32000, `maxRequestTokens` 64000, `maxChoiceOptions`
     255, `maxScoreLevels` 10, `billingModel` `pay-per-token`, `inputCostPer1MTokens`
     0.042, `outputCostPer1MTokens` 0, `calibratedProbabilities` true.
6. **Fixtures:** recorded request and response JSON for one choice, one score and one
   noul, built from the wire format below, stored beside the adapter tests.
7. **Barrel:** re-export the judgment module from `reference/src/index.ts`.

## Wire format (from the provider's API reference, read 2026-09-30)

Endpoint:

```text
scheme: https
host:   api.typesafe.ai
method: POST
path:   /v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Request body, then response body:

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-1.13.0",
  "questions": {
    "department": { "type": "choice", "instructions": "Which team should handle this?",
      "criteria": { "billing": "Payments, invoicing, refunds", "technical": "Bugs, outages", "sales": null } },
    "frustration": { "type": "score", "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"] },
    "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?",
      "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } }
  }
}
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": { "type": "choice", "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 }, "confidence": 0.81 },
    "frustration": { "type": "score", "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 }, "confidence": 0.92 },
    "is_urgent": { "type": "noul", "noul": 0.95 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

## Acceptance Criteria
- [ ] The types, error class, registry, fake provider and Jev adapter exist under `reference/src/judgment/` and are re-exported from `reference/src/index.ts`.
- [ ] A choice, a score and a noul question round-trip through the Jev adapter against the recorded fixtures with an injected fetch, producing the mapped `JudgmentAnswer` shapes (score probabilities as an ordered array, noul as `probability`).
- [ ] Invalid requests (no questions, a choice with one option, a score with 11 levels) fail with kind `validation` and make no fetch call.
- [ ] A response missing an answer, carrying the wrong answer type, or naming a choice outside the supplied options fails with kind `bad-response`.
- [ ] 401 and 422 are not retried; 429, 529 and 500 are retried up to `maxRetries` with backoff, and a `retry-after` header sets the wait.
- [ ] A hung fetch is aborted at `timeoutMs` and reported as kind `timeout`.
- [ ] No error message, thrown value or log line contains the API key (asserted in a test).
- [ ] `FakeJudgmentProvider` returns scripted answers, records requests, and can throw a chosen error kind.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
