---
id: AISDLC-264
title: pre-push audit gate has no per-CVE advisory-ignore mechanism
status: To Do
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - ci
  - audit
  - security
dependencies: []
priority: medium
references:
  - .husky/pre-push
  - scripts/check-coverage.sh
---

## Bug

`pnpm audit --audit-level=high` (or whichever package-manager equivalent) is the canonical pre-push gate, but it has no built-in per-CVE time-bound exemption mechanism. When a high-severity advisory lands in a transitive dep with no fix available yet, every adopter rolls their own wrapper script (or worse, disables the gate entirely).

## What we want

A canonical AI-SDLC pattern adopters can drop in:

1. **`.audit-ignores.json`** at repo root: structured exemption list with `{cveId, justification, expiresAt}` per entry.
2. **`scripts/audit-with-ignores.mjs`** reference impl: runs `pnpm audit --json`, filters output against `.audit-ignores.json`, exits non-zero only if a non-ignored high-severity advisory remains. Prints a summary including which exemptions are still active and which expired.
3. **Expiry enforcement**: if `expiresAt` is in the past, the entry is treated as expired and the gate fails as if the exemption didn't exist. Forces the operator to either renew (with fresh justification) or fix the underlying dep.
4. **Audit log**: every `audit-with-ignores` run appends to `$ARTIFACTS_DIR/_audit/audit.jsonl` so the adopter has a paper trail of exemptions used over time.

## Fix candidates

- Add the canonical files + script to the `init --with-workflows` scaffold (depends on AISDLC-261).
- Document in `docs/operations/audit-gate.md` with the exemption-renewal runbook.
- Add a `cli-audit-renew` operator command that re-evaluates all expired entries and prompts for fresh justification.

## Acceptance criteria

- [ ] `.audit-ignores.json` schema documented + JSON Schema in `spec/schemas/audit-ignores.schema.json`.
- [ ] `scripts/audit-with-ignores.mjs` runs `pnpm audit --json`, filters, exits 0 / non-0 correctly.
- [ ] Expired entries fail the gate.
- [ ] Audit log writes to `$ARTIFACTS_DIR/_audit/audit.jsonl`.
- [ ] Test coverage: hermetic tests for filtering, expiry, audit-log append.
- [ ] Adopter-facing docs at `docs/operations/audit-gate.md`.

## Source

Adopter session 2026-05-13, ranked #4 by friction. Forge has a homegrown wrapper today; we should ship the pattern.
