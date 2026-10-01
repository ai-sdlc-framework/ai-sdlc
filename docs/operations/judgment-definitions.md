# Judgment definitions: registration-time safety rules

`registerJudgmentDefinition` (in `reference/src/judgment/catalog.ts`) validates every
definition before it enters the catalog, and `evaluateJudgment` runs the same check on
the definition object it receives, so an unregistered definition cannot skip the rules.
A definition that breaks a rule is rejected: registration throws an error naming the
definition id and the rule and leaves the catalog unchanged, and evaluation returns the
`definition-error` abstain outcome without calling the provider. All rules fail closed.

## Declaration fields

- `fallback?: 'pending'`: what the caller does when a seam judgment abstains or
  escalates. The only accepted value is the pending sentinel.
- `reducesReview?: boolean`: true when any outcome of the judgment can result in less
  review than the deterministic path would apply. Examples: fewer or cheaper reviewers,
  a skipped gate, an auto-approval, a lowered bar, a lower tier.
- `reducingOutcomes?: readonly string[]`: the names of the outcomes that reduce review.
  These are the strings the definition's `compose` uses in its decisions. Entries must be
  non-empty strings.

## What is enforced

- Shape: `id` is a non-empty string; `riskClass` and `direction` are known values;
  `reducesReview` is a boolean and `reducingOutcomes` an array of non-empty strings when
  declared. Wrong types are rejected rather than ignored.
- (a) `riskClass: 'seam'` requires `fallback === 'pending'`.
- (b) A definition that is both `riskClass: 'seam'` and `direction: 'bidirectional'` must
  declare `reducingOutcomes` explicitly as an empty array. Undeclared or non-empty is
  rejected. A tighten-only seam is not subject to this rule.
- (c) `reducesReview: true` requires `riskClass: 'relax'`. A non-empty `reducingOutcomes`
  requires `reducesReview: true` (otherwise the declaration is inconsistent), and so
  also `relax`.
- (d) Every `direction: 'bidirectional'` definition, of any risk class, must declare
  `reducesReview` explicitly as `true` or `false`. Undeclared means unknown, so it is
  rejected. Tighten-only definitions are not subject to this rule.

The stored definition is a frozen copy taken from a single read of each field, so later
mutation of the original object, or a getter that returns different values on each read,
cannot change what was validated.

## Why

A `bidirectional` definition can make permissive decisions when the work item comes from
the backlog. The `relax` risk class carries the stricter promotion bar (corpus path with
precision 0.95, no override path), while `seam` and `tighten` accept 0.90 or an override.
Requiring bidirectional definitions to state whether they reduce review, and holding
those that do to `relax`, stops a definition from deciding permissively on the lower bar
by simply saying nothing.

## What is not enforced

The registry and `evaluateJudgment` check declarations only, not behaviour. They cannot
observe what `compose` returns. The declaration is the author's attestation and is
reviewed in code review. The residual risk: a definition can declare `reducesReview:
false` while its `compose` in fact reduces review. Reviewers must check `compose`
against the declaration, and re-check it whenever `compose` changes.

## What to declare

A bidirectional definition declares `reducesReview: true` when any `act` outcome lets a
gate pass, or review be skipped or reduced, without the stricter deterministic path. It
then must be `riskClass: 'relax'` and list those outcomes in `reducingOutcomes`. If no
outcome can do that (the judgment only adds scrutiny or chooses between equally strict
paths), declare `reducesReview: false`.

## Conforming shapes

- A definition-of-ready stage B style judgment: `riskClass: 'tighten'`,
  `direction: 'bidirectional'`, `reducesReview: false`.
- A conforming seam: `riskClass: 'seam'`, `fallback: 'pending'`,
  `direction: 'bidirectional'`, `reducingOutcomes: []`, `reducesReview: false`. A
  tighten-only seam needs just `fallback: 'pending'`.
- A review-reducing judgment: `riskClass: 'relax'`, `direction: 'bidirectional'`,
  `reducesReview: true`, `reducingOutcomes: ['<outcome name>']`.
