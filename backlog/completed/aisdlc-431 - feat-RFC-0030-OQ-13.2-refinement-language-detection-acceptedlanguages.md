---
id: AISDLC-431
title: 'feat: RFC-0030 OQ-13.2 re-walkthrough refinement — per-org acceptedLanguages config + franc language detection'
status: Done
assignee:
  - '@dominique-legault'
created_date: '2026-05-26'
completed_date: '2026-05-27'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - i18n
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.2 (multi-language signal processing). Lands on top of shipped Phase 2 + Phase 3 substrate (AISDLC-344, AISDLC-345 in `backlog/completed/`).

## Scope (RFC-0030 §13.2 v0.3 refinements)

- **Add `franc` library** (deterministic; <10ms per signal; JS-native; MIT-licensed; 95%+ accuracy on text >50 chars) for language detection at the classifier stage.
- **Per-org `acceptedLanguages` config** in `.ai-sdlc/signal-ingestion.yaml`:
  - Default: `[en]` (English-only; matches conservative v0.2 intent)
  - Multi-language opt-in: `[en, fr, es, ...]` (orgs with non-English customer bases opt in knowingly, accepting documented BM25 quality degradation)
- **Non-accepted-language signals**: `Decision: signal-language-unsupported` → drop + log to catalog for visible-gap metric (no pipeline halt).
- **Operator runbook update**: document the multi-language trade-off — BM25 precision degrades ~15-30% without per-language stopwords/stemming (Robertson & Zaragoza §3.5); LLM ICP-resonance and embedding clustering are native multi-language; per-org opt-in is the right model for "you know your data better than the framework does."
- **Hermetic tests**: deterministic language detection (franc returns same answer for same input); acceptedLanguages config respected; Decision emitted on language drop; visible-gap metric increments.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `franc` library wired into classifier; per-signal detection runs in <10ms median
- [x] #2 Per-org `acceptedLanguages: [en]` default in `.ai-sdlc/signal-ingestion.yaml`; multi-language opt-in via config
- [x] #3 Non-accepted-language signals dropped with `Decision: signal-language-unsupported` to catalog
- [x] #4 Visible-gap metric increments on language drop (operator runbook explains it)
- [x] #5 Operator runbook section "Multi-language signals: when to opt in" published with BM25 quality-degradation caveat
- [x] #6 Hermetic tests for franc determinism (same input → same output), config respect, Decision emission
<!-- AC:END -->

## Final Summary

### Summary

Replaced the v0.2 Unicode-script-block heuristic in
`orchestrator/src/signal-ingestion/classifier.ts` with the `franc`
trigram-based detector (MIT, JS-native, <10ms/signal, 95%+ accuracy on
text >50 chars, returns ISO 639-3 codes). Added a `languageDetection`
config block (library / minDetectionLength / onUndetermined) for
operator tuning. The existing `acceptedLanguages: [en]` default holds;
multi-language opt-in (`[en, fr, es, ...]`) now performs real
per-language detection instead of v0.2's pass-through-all-on-opt-in
relaxation. Operator runbook gains a "9b. Multi-language signals: when
to opt in" section with the BM25 quality-degradation rubric +
opt-in/opt-out tradeoffs.

### Changes

- `orchestrator/package.json` (modified): added `franc ^6.2.0` dependency
- `orchestrator/src/signal-ingestion/config.ts` (modified):
  added `LanguageDetectionConfig` interface + default `{ library: 'franc',
  minDetectionLength: 50, onUndetermined: 'accept' }`; added
  `resolveLanguageDetectionConfig()` loader; expanded `acceptedLanguages`
  doc with multi-language opt-in semantics
- `orchestrator/src/signal-ingestion/config.test.ts` (modified): 6 new
  tests for the `languageDetection` block (defaults, override, library:
  none, invalid library/onUndetermined, partial-override fills defaults)
- `orchestrator/src/signal-ingestion/classifier.ts` (modified): replaced
  `detectDominantNonLatinScript()` + `detectScript()` (script-block
  heuristic, ~150 lines) with `checkLanguage()` (franc-based,
  fuzzy-accept via francAll top-N to defend short technical English from
  Nordic misclassification); added ISO 639-1 → 639-3 mapping for the
  most-common languages; added script-family hint lookup tables for
  v0.2 dashboard backward-compat
- `orchestrator/src/signal-ingestion/classifier.test.ts` (modified):
  rewrote language-gate tests for the new `franc` semantics (15 tests
  total); added hermetic determinism test + library: 'none' test +
  onUndetermined: 'drop' test + multi-language opt-in tests + ISO 639-3
  direct + BCP-47 regional prefix matching tests
- `orchestrator/src/signal-ingestion/index.ts` (modified): export
  `LanguageDetectionConfig` type
- `spec/schemas/signal-ingestion-config.v1.schema.json` (modified):
  added `LanguageDetectionConfig` `$def` + wired into `SignalIngestionSpec`;
  expanded `acceptedLanguages` description
- `reference/src/core/generated-schemas.ts` (modified): regenerated from
  the JSON schema via `generate-schemas` script
- `docs/operations/signal-ingestion.md` (modified): added section "9b.
  Multi-language signals: when to opt in" with default behavior,
  opt-in syntax (BCP-47/ISO 639-1/ISO 639-3 forms), BM25 trade-off table,
  decision rubric, operator-visibility jq snippet, tuning guidance for
  the three knobs, and "why franc instead of LLM" rationale
- `backlog/completed/aisdlc-431 - ...md` (moved from `backlog/tasks/`,
  status flipped to Done, all 6 ACs checked, finalSummary added)

### Design decisions

- **Franc over LLM-based detection**: RFC §13.2 rubric — franc is
  deterministic (same input → same output forever), runs locally
  (no API tokens), is 95%+ accurate on text >50 chars, ships as one
  270 kB JS bundle with one trivial dep. LLM-based is 100-500× slower,
  costs money, and is less deterministic. RFC-prescribed.

- **`minDetectionLength: 50`** as default: matches the franc-documented
  accuracy threshold. Texts under 50 chars return `'und'` and are
  handled by `onUndetermined: 'accept'` (default) — short bug-report
  signals like "Crash on save" never get false-dropped.

- **Fuzzy acceptance via `francAll` top-N + 0.80 score floor**: short
  technical English (sub-60-char SAML/SSO-jargon bug reports) routinely
  misclassifies as Nordic languages (`nno`, `dan`, `nld`) because
  technical English uses uncommon trigrams. Franc's script prefilter is
  the LOAD-BEARING protection — foreign-script text excludes English
  from the candidate list entirely. The score-floor handles
  same-script close-runners-up. This is the standard franc
  misclassification workaround.

- **Multi-language opt-in does REAL detection (v0.3) instead of
  pass-through-everything (v0.2)**: v0.2's "if acceptedLanguages
  includes anything non-en, relax gate to accept everything" was a
  forward-compat hack for the deferred multi-language work. v0.3
  delivers the multi-language work, so opting in to `['en', 'fr']`
  now means "accept en + fr, drop everything else" — the obvious
  contract.

- **Backward-compat for `detectedScript` field**: v0.2's
  `SignalLanguageUnsupportedDecision.detectedScript` returned a coarse
  script-family name (`'cjk'`, `'cyrillic'`). v0.3 promotes the
  primary field to `detectedLanguage` (ISO 639-3) but keeps
  `detectedScript` populated via the new `scriptHintFor()` lookup so
  v0.2 TUI dashboards / runbook examples continue to work for one
  release window. Marked `@deprecated`.

- **Two-letter ↔ three-letter mapping table is intentionally
  non-exhaustive**: covers the top-30 languages by speaker count plus
  EU + East-Asian majors. Uncommon languages (Tagalog `tgl`, Northern
  Pashto `pbu`, etc.) can be specified directly in their ISO 639-3
  form — the matcher does exact-match on three-letter codes
  unconditionally. Avoids shipping a 200-entry lookup table that
  almost nobody needs.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 4063 passed, 1 skipped (187 test files)
  - signal-ingestion subsuite: 211 tests across 7 files, all green
  - 15 new tests in classifier.test.ts language gate suite
  - 6 new tests in config.test.ts languageDetection suite
- `pnpm --filter @ai-sdlc/reference test` — 1384 passed, 3 skipped (regenerated-schemas surface clean)
- `pnpm lint` — clean (no eslint output)
- `pnpm format:check` — clean (prettier idempotent)

### Follow-up

- (none planned for this task)
- (informational) When v2 ships an embedding-based clustering adopter
  (RFC-0019), the runbook's recommendation "switch to embedding
  clustering for multi-language" becomes actionable. Until then
  multi-language adopters take the documented 15-30% BM25 precision
  drop.
- (informational) The `detectedScript` field on
  `SignalLanguageUnsupportedDecision` is now `@deprecated`. Track
  one release window then remove in a future RFC-0030 housekeeping
  task.
