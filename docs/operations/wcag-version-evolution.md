# WCAG version evolution (RFC-0018 OQ-7)

How journey `accessibility.wcagVersion` handles new WCAG versions (AISDLC-469).

## Additive enum

`wcagVersion` is an additive enum: `2.0`, `2.1`, `2.2`, `3.0`. A new W3C version is appended; existing declarations stay valid and keep their declared version. New journeys may pick the latest. The enum lives in `spec/schemas/journey.v1.schema.json` and `WCAG_VERSIONS` in `orchestrator/src/journey-sa2-router.ts`; a test keeps the two in sync.

## Superseded-version advisory

Declaring WCAG 2.0 (superseded by 2.1/2.2 as a W3C Recommendation) emits `Decision: wcag-version-superseded`:

- severity `low`, advisory only;
- visible-gap signal for the operator, never a gate;
- no Eρ₅ scoring impact: `wcagLevel` alone drives Eρ₅ elevation, so scores are identical for every `wcagVersion`.

Use `evaluateWcagVersion(version)` to obtain the Decision (or `null`).

## WCAG 3.0 forward-compatibility

WCAG 3.0 is still a draft. `3.0` is accepted in the enum today and treated like 2.x for scoring.

Scoring-model shift (pre-documented): WCAG 2.x conformance is binary (a criterion passes or fails; `conformanceTarget` is a percentage of passing criteria). WCAG 3.0 moves to graduated scoring (outcome ratings across levels). When 3.0 becomes normative, a future RFC may need a `scoringModel` discriminant (for example `binary` vs `graduated`) on `accessibility` so `conformanceTarget` is interpreted correctly. No schema change is made now; existing declarations remain valid.
