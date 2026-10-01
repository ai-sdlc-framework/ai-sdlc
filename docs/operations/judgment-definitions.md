# Judgment definitions: registration-time safety rules

`registerJudgmentDefinition` (in `reference/src/judgment/catalog.ts`) validates every
definition before it enters the catalog. A definition that breaks a rule throws an error
naming the definition id and the rule, and the catalog is left unchanged. All rules fail
closed.

## Declaration fields

- `fallback?: 'pending'`: what the caller does when a seam judgment abstains or
  escalates. The only accepted value is the pending sentinel.
- `reducesReview?: boolean`: true when any outcome of the judgment can result in less
  review than the deterministic path would apply. Examples: fewer or cheaper reviewers,
  a skipped gate, an auto-approval, a lowered bar, a lower tier.
- `reducingOutcomes?: readonly string[]`: the names of the outcomes that reduce review.
  These are the strings the definition's `compose` uses in its decisions.

## Rules

- (a) `riskClass: 'seam'` requires `fallback === 'pending'`. Any other or missing value
  is rejected.
- (b) A definition that is both `riskClass: 'seam'` and `direction: 'bidirectional'` must
  declare `reducingOutcomes` explicitly, and it must be an empty array. A non-empty array
  or an undeclared field is rejected (undeclared means unknown). A tighten-only seam is
  not subject to this rule.
- (c) `reducesReview: true` requires `riskClass: 'relax'`. A non-empty `reducingOutcomes`
  implies `reducesReview: true`; otherwise the declaration is inconsistent and rejected.
  Together this means any definition that names an outcome as reducing review is held to
  the `relax` promotion bar.

Unknown `riskClass` or `direction` values, a non-boolean `reducesReview`, and a
`reducingOutcomes` that is not an array of strings are rejected rather than ignored,
because the registry is also called from JavaScript.

## Why

A `bidirectional` definition can make permissive decisions when the work item comes from
the backlog. The `relax` risk class carries the stricter promotion bar (corpus path with
precision 0.95, no override path), while `seam` and `tighten` accept 0.90 or an override.
Without a registration rule, a definition could declare `seam` or `tighten`, decide
permissively, and be promoted on the lower bar. The rules above close that gap.

## What the registry cannot check

The registry cannot observe what `compose` returns. The declarations are the author's
attestation, and they are reviewed in code review. When you change `compose`, re-check
that the declarations still describe every outcome it can produce.

## Conforming shapes

- A `tighten` + `bidirectional` definition with no declarations (for example the
  definition-of-ready stage B judgment) registers as is.
- A conforming seam: `riskClass: 'seam'`, `fallback: 'pending'`,
  `direction: 'bidirectional'`, `reducingOutcomes: []`.
- A review-reducing judgment: `riskClass: 'relax'`, `reducesReview: true`,
  `reducingOutcomes: ['<outcome name>']`.
