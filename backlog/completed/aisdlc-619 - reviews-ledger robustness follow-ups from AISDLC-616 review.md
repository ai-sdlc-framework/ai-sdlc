---
id: AISDLC-619
title: reviews-ledger robustness follow-ups from AISDLC-616 review
status: Done
priority: low
labels:
  - observability
  - reviewers
  - tech-debt
created: 2026-09-14
---

## Context

Suggestion-level findings from the three-reviewer pass on AISDLC-616 (PR #1066).
None were blocking; consolidated here so they are not lost.

## Scope

- **appendFileSync over read-modify-write** (code-reviewer): `appendReviewLedgerRecord`
  in `pipeline-cli/src/attestation/reviews-ledger.ts` uses readFileSync + write-tmp
  + rename. The rename is atomic but the read-modify-write is not — concurrent
  same-task appends could lose a record (both read the same base, last rename
  wins). Current callers serialize per task and cross-task writers use distinct
  files, so real-world risk is low; but the ledger's whole purpose is durable
  capture of concurrent reviewer verdicts. Switch to `appendFileSync` (O_APPEND),
  which also fixes the O(N^2) whole-file rewrite per append. Correct the
  "Atomically APPEND" docstring accordingly.
- **Prototype-pollution hardening** (security-reviewer): `groupIntoCycles` in
  `reviews-analysis.ts` indexes a plain `{}` by `record.role` parsed from
  untrusted committed JSON. The `ALL_ROLES` filter means non-canonical roles
  (e.g. `__proto__`) are never read back, so there is no exploitable vector — but
  use `Object.create(null)` or a `Map` to harden the analysis tooling against a
  corrupted/adversarial committed ledger.
- **Test-gap suggestions** (test-reviewer): add a test for the `runReviewsCli()`
  wrapper; assert the malformed-line stderr warning text; add a counts-only
  (degraded `normalizeFindings`) overlap-collision test (synthetic titles could
  collide across roles in the overlap math).

## Acceptance Criteria

- [x] AC-1: `appendReviewLedgerRecord` uses append-mode IO (no full-file rewrite);
      a test proves concurrent-ish sequential appends never lose a record and the
      docstring matches the implementation.
- [x] AC-2: `groupIntoCycles` (and any sibling role-keyed maps in
      reviews-analysis) use a null-prototype map / Map; a test with a
      `__proto__`-role record proves no pollution and correct exclusion.
- [x] AC-3: Added tests for the CLI wrapper, the stderr-warning text, and the
      counts-only overlap-collision case.
- [x] AC-4: `pnpm build && test && lint` clean; patch coverage >= 80%.

## References

AISDLC-616 (PR #1066) reviewer suggestions (code + test + security).

## Final Summary

Implemented all three suggestion-level follow-ups from the AISDLC-616 review:

1. `appendReviewLedgerRecord` (`pipeline-cli/src/attestation/reviews-ledger.ts`)
   now uses `appendFileSync` (O_APPEND) instead of readFileSync + write-tmp +
   rename — atomic per-write, O(1) per append, and the docstring now accurately
   describes append-mode IO instead of overselling "Atomically APPEND".
2. `groupIntoCycles` (`pipeline-cli/src/attestation/reviews-analysis.ts`) now
   builds each per-cycle map via `Object.create(null)` instead of a plain `{}`,
   hardening against prototype pollution from a corrupted/adversarial committed
   ledger.
3. Added tests: `runReviewsCli()` bin-shim entry point, the malformed-line
   stderr warning text, a `__proto__`-role prototype-pollution regression test,
   and a counts-only (degraded `normalizeFindings`) overlap-collision fixture
   documenting the known title-collision limitation.

`pnpm build && pnpm test && pnpm lint && pnpm format:check` all clean; patch
coverage on the three touched source files is 98-100% lines.
