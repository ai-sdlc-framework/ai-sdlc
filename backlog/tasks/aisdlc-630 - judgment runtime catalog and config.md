---
id: AISDLC-630
title: >-
  RFC-0049 Phase 1: evaluateJudgment runtime, Judgment Catalog, JudgmentConfig schema and loader, redaction move
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-1
  - reference
  - schema
  - adopter
dependencies:
  - AISDLC-629
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/dor/secret-redact.ts
  - pipeline-cli/src/steps/reviewer-set.ts
  - spec/schemas/dor-config.v1.schema.json
  - reference/src/core/generated-schemas.ts
  - .ai-sdlc/templates/capture-config.yaml
  - reference/src/index.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Builds the runtime that every judgment call goes through, the catalog that holds
judgment definitions, and the per-repo configuration. RFC-0049 sections 3, 4, 6 and 8
are the specification. The central property: `evaluateJudgment` never throws, and
`abstain` always means the caller does what it did before this series.

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
1. **Definition types** (RFC-0049 section 3): `JudgmentDefinition<I, D>` with `id`,
   `version`, `egressClass` (`work-item-text`, `code-diff`, `agent-output`),
   `direction` (`tighten-only`, `bidirectional`), `riskClass` (`seam`, `tighten`,
   `relax`), `buildState`, `questions`, `compose(answers, input, thresholds, ctx)` where
   `ctx` carries `permissiveAllowed`, and optional `agrees(decision, label)`.
   `JudgmentOutcome<D>` is `act`, `escalate` (to `llm` or `operator`) or `abstain`.
2. **Catalog registry:** `registerJudgmentDefinition`, `getJudgmentDefinition(id)`,
   `listJudgmentDefinitions`; duplicate ids are rejected.
3. **`questionSetHash(definition, probeInput)`**: SHA-256 over canonical JSON (sorted
   keys) of the definition's questions for the probe input plus its `version`.
4. **`evaluateJudgment(definition, input, ctx)`** implementing the RFC-0049 section 4
   table. `ctx` carries the resolved config, a provider lookup, `sourceKind`, optional
   `taskId`, and a list of sinks called with one record per evaluation (the log and
   cost sinks arrive in AISDLC-631; here the sink is an interface and tests use an
   in-memory one). Rules, in order:
   - No provider configured, provider unavailable, or effective mode `off`: abstain
     `disabled`, no provider call.
   - `egressClass` not in `egress.allow`: abstain `egress-not-permitted`, no call.
     A provider whose base URL is a loopback host skips this check.
   - Estimated state size (characters divided by 4) above the provider's
     `maxStateTokens`: abstain `state-too-large`, no call. Never truncate.
   - State passes through `redactSecrets` (applied to every string in the JSON value)
     before the provider call.
   - Provider error or an answer missing for any question: abstain `provider-error`.
   - Effective mode `shadow`: call, record, return abstain `shadow`.
   - Effective mode `enforce`: return `compose(...)` with
     `permissiveAllowed = definition.direction === 'bidirectional' && sourceKind === 'backlog'`.
   - A thrown `compose`, `buildState` or `questions` is caught and becomes abstain
     `definition-error`.
5. **Enforce downgrade** (RFC-0049 section 4): a judgment configured `enforce` runs as
   `shadow`, with the reason on the record, when the model is an alias (`*-latest`,
   `*-preview`) and not an exact version; when the provider declares
   `calibratedProbabilities: false`; when no thresholds exist for the active
   `provider@model` key; or when no promotion record for that key satisfies the
   `riskClass` bar. Bars (RFC-0049 section 8): `seam` and `tighten` accept
   `path: corpus` with `n >= 50` and `actBandPrecision >= 0.90`, or `path: override`
   with non-empty `evidence`; `relax` accepts only `path: corpus` with `n >= 50` and
   `actBandPrecision >= 0.95`.
6. **Config:** new schema `spec/schemas/judgment-config.v1.schema.json` for kind
   `JudgmentConfig` (RFC-0049 section 6): `spec.provider`, `spec.model`,
   `spec.providerOptions` (free-form object per provider name), `spec.egress.allow`,
   `spec.defaults` (`mode`, `timeoutMs`, `cache`), and `spec.judgments.<id>` with
   `mode`, `thresholds` keyed by `provider@model`, and `promotion` keyed by
   `provider@model`. Register the schema with the AJV instance in
   `reference/src/core/validation.ts`, regenerate and commit
   `reference/src/core/generated-schemas.ts`, and run the full `reference` test suite.
7. **Loader** `loadJudgmentConfig(opts)`: reads `.ai-sdlc/judgment-config.yaml` from the
   base ref with `git show <baseRef>:<path>` (default `origin/main`), the same trust
   model as `pipeline-cli/src/steps/reviewer-set.ts`; never reads the working tree.
   Env `AI_SDLC_JUDGMENT_CONFIG_PATH` (operator-controlled) points at a local file
   instead. Env `AI_SDLC_JUDGMENT=off` disables the layer. A missing, unreadable or
   schema-invalid file resolves to the disabled config; the loader never throws.
   Defaults when a provider is named: `egress.allow` is `[work-item-text]`, mode is
   `shadow`.
8. **Redaction move:** move the module at `pipeline-cli/src/dor/secret-redact.ts` into
   `reference/src/security/` and leave a re-export at the old path so existing imports
   and tests keep working unchanged.
9. **Init template:** add `.ai-sdlc/templates/judgment-config.yaml`, fully commented,
   shipped the same way as `.ai-sdlc/templates/capture-config.yaml`. It shows
   `egress.allow` with each class on its own commented line.

## Acceptance Criteria
- [ ] With no config file on the base ref, `evaluateJudgment` returns abstain `disabled` and the provider is never called.
- [ ] With a provider named and nothing else, a `work-item-text` judgment runs in `shadow` (provider called, sink receives one record, caller gets abstain `shadow`) and a `code-diff` judgment returns abstain `egress-not-permitted` with no provider call.
- [ ] A state containing a string matched by `SECRET_PATTERNS` reaches the provider redacted (asserted on the fake provider's recorded request).
- [ ] An input whose state exceeds `maxStateTokens` returns abstain `state-too-large` and makes no provider call.
- [ ] A provider error, a missing answer, and a throwing `compose` each resolve to an abstain outcome; `evaluateJudgment` does not throw in any test.
- [ ] `enforce` with an alias model, with a provider declaring `calibratedProbabilities: false`, with no thresholds for the active key, or with no satisfying promotion record runs as `shadow` and records the reason; one test per condition.
- [ ] A `relax` definition with a `path: override` promotion record, or a corpus record below `n` 50 or precision 0.95, is not enforced; a `seam` definition with a non-empty override `evidence` is.
- [ ] `permissiveAllowed` is true only for a `bidirectional` definition with `sourceKind` `backlog`; false for `gh-issue`, for an absent `sourceKind`, and for any `tighten-only` definition.
- [ ] `questionSetHash` is stable across runs and changes when a question's text, an option, or the definition `version` changes.
- [ ] The config schema is registered with AJV, `generated-schemas.ts` is regenerated and committed, and `pnpm validate-schemas` passes.
- [ ] The loader reads only from the base ref or the explicit env path; a test proves a working-tree copy of the file is ignored.
- [ ] `redactSecrets` and `SECRET_PATTERNS` are importable from both the new `reference` location and the old `pipeline-cli` path, and the existing redaction tests pass unmodified.
- [ ] `.ai-sdlc/templates/judgment-config.yaml` exists and validates against the schema once uncommented.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
