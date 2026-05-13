---
id: AISDLC-264
title: pre-push audit gate has no per-CVE advisory-ignore mechanism
status: Done
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
  - scripts/audit-with-ignores.mjs
  - scripts/audit-with-ignores.test.mjs
  - spec/schemas/audit-ignores.schema.json
  - docs/operations/audit-gate.md
finalSummary: |
  ## Summary
  Shipped the canonical per-CVE time-bound audit-ignore pattern as part of the AI-SDLC framework.
  Adopters can now drop `.audit-ignores.json` at their repo root and run
  `node scripts/audit-with-ignores.mjs` instead of bare `pnpm audit --audit-level=high`.
  Expired entries fail the gate, forcing regular re-evaluation. Every run appends to
  `$ARTIFACTS_DIR/_audit/audit.jsonl` for a paper-trail.

  ## Changes
  - `spec/schemas/audit-ignores.schema.json` (new): JSON Schema for `.audit-ignores.json`
    with `{cveId, justification, expiresAt}` per entry.
  - `scripts/audit-with-ignores.mjs` (new): reference implementation — runs `pnpm audit
    --json`, filters against `.audit-ignores.json`, exits non-zero if non-ignored highs
    remain or expired entries exist.
  - `scripts/audit-with-ignores.test.mjs` (new): 28 hermetic tests covering filtering,
    expiry enforcement, audit-log append, both pnpm JSON shapes, and dry-run mode.
  - `docs/operations/audit-gate.md` (new): adopter-facing docs with field reference,
    CLI usage, expiry renewal runbook, and audit-log format.
  - `package.json` (modified): added `test:audit-gate` script + wired into `pnpm test`.

  ## Design decisions
  - **Expired entries fail the gate even with no new advisories**: forces the operator to
    consciously renew or fix, rather than silently letting stale exemptions accumulate.
  - **Both pnpm audit JSON shapes supported**: pnpm v7 uses `advisories` key, newer versions
    use `vulnerabilities` key. The implementation detects shape at runtime.
  - **Audit log is append-only JSONL**: mirrors the existing `reference/src/audit/file-sink.ts`
    pattern; easy to `tail -f` and parse.

  ## Verification
  - `node --test scripts/audit-with-ignores.test.mjs` — 28 pass, 0 fail
  - `pnpm lint` — 0 errors (2 pre-existing warnings in pipeline-cli, unrelated)
  - `pnpm format:check` — clean

  ## Follow-up
  - AISDLC-261 (init scaffold) should include this script + schema in `--with-workflows`.
  - A `cli-audit-renew` operator command (mentioned in the task) is a follow-up item.
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
