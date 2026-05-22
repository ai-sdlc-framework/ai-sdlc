---
id: AISDLC-394
title: 'chore: strip internal tracker IDs from adopter-facing PR comments (ai-sdlc-review.yml)'
status: To Do
labels:
  - ux
  - workflows
  - adopter-facing
references:
  - .github/workflows/ai-sdlc-review.yml
---

## Description

Two adopter-facing strings in `.github/workflows/ai-sdlc-review.yml` leak internal AISDLC tracker IDs into messages adopters see in their PRs. They should describe WHAT happened, not point at our internal change history.

### Finding 1 — Line 1603 (programmatic APPROVE review body)

When CI's cost-saver shortcut detects a valid local DSSE attestation envelope and skips the reviewer fan-out, it posts a GitHub PR review with body:

```
Auto-approved by valid local DSSE attestation (AISDLC-147 patch 1).
```

The `(AISDLC-147 patch 1)` suffix is meaningless to any adopter reading their PR. Rewrite to describe what the auto-approve means + why:

```
Auto-approved: a valid local DSSE attestation envelope is present on the PR head SHA, so the CI-side reviewer fan-out is skipped as a cost-saver (the local attestation IS the review). See docs/operations/quality-gate.md for the attestation chain.
```

### Finding 2 — Line 1560 (PR comment Note)

When the same shortcut fires, the PR also gets a comment with:

```
_Note: Attestation remains AUDIT-ONLY as a merge gate (per AISDLC-140 sub-4)._
```

This is **factually wrong** post-AISDLC-388 (PR #608, merged 2026-05-22). The new `attestation-gate` job in `ai-sdlc/pr-ready` rollup MACHINE-ENFORCES attestation for code PRs (skipped on docs-only). Attestation is no longer audit-only.

Rewrite to current truth + drop the internal ref:

```
_Note: attestation is required for code PRs (machine-enforced via the `ai-sdlc/pr-ready` rollup). Docs-only PRs skip the check entirely._
```

### Finding 3 — Sweep for other AISDLC-NNNN leaks in adopter-facing strings

Run `grep -n "AISDLC-[0-9]" .github/workflows/ai-sdlc-review.yml | grep -E "body:|message:|description:"` and audit each hit. Internal comments in YAML (lines beginning with `#`) are fine — those are for maintainers. The bug is internal IDs in strings posted TO GitHub (PR review bodies, PR comments, check descriptions).

## Acceptance criteria

- [ ] AC-1: Line 1603 review body rewritten — no AISDLC-NNN reference
- [ ] AC-2: Line 1560 Note rewritten — no AISDLC-NNN reference + post-388 wording
- [ ] AC-3: Sweep `ai-sdlc-review.yml` for all `body:|message:|description:` strings containing `AISDLC-[0-9]+`; rewrite each
- [ ] AC-4: Same sweep across `verify-attestation.yml`, `ai-sdlc-gate.yml`, `dor-ingress.yml`, `auto-enable-auto-merge.yml`, `auto-rebase-open-prs.yml` — there may be other leaks
- [ ] AC-5: Snapshot test for adopter-facing strings (`scripts/check-adopter-facing-strings.test.mjs` or similar) that fails if any GitHub-posted string contains `AISDLC-\d+`

## Estimated effort

1-2 hours.

## Out of scope

- Comments inside YAML (lines starting with `#`) — those are for maintainers
- Internal documentation pages (`docs/operations/*.md`) — those are read by operators, fine to reference internal IDs

## References

- AISDLC-147 patch 1 — origin of the offending line 1603
- AISDLC-140 sub-4 — origin of the stale Note on line 1560
- AISDLC-388 — made attestation machine-enforced; falsified line 1560
- AISDLC-392 — promoted Decision Catalog default-on (also adopter-facing)
