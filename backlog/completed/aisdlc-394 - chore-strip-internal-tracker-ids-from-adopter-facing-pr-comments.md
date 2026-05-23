---
id: AISDLC-394
title: 'chore: strip internal tracker IDs from adopter-facing PR comments (ai-sdlc-review.yml)'
status: Done
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

- [x] AC-1: Line 1603 review body rewritten — no AISDLC-NNN reference
- [x] AC-2: Line 1560 Note rewritten — no AISDLC-NNN reference + post-388 wording
- [x] AC-3: Sweep `ai-sdlc-review.yml` for all `body:|message:|description:` strings containing `AISDLC-[0-9]+`; rewrite each
- [x] AC-4: Same sweep across `verify-attestation.yml`, `ai-sdlc-gate.yml`, `dor-ingress.yml`, `auto-enable-auto-merge.yml`, `auto-rebase-open-prs.yml` — there may be other leaks
- [x] AC-5: Snapshot test for adopter-facing strings (`scripts/check-adopter-facing-strings.test.mjs` or similar) that fails if any GitHub-posted string contains `AISDLC-\d+`

## Final summary

### Summary

Rewrote 11 adopter-facing strings across `.github/workflows/ai-sdlc-review.yml` (10 strings) and `.github/workflows/verify-attestation.yml` (1 string) to drop internal AI-SDLC tracker IDs (`AISDLC-NNN`). Added a snapshot test at `scripts/check-adopter-facing-strings.test.mjs` that scans every line of six watched workflow files and fails on any tracker ID outside a YAML `#` or JS `//` comment. Wired the test into `pnpm test` via the new `test:adopter-facing-strings` script.

### Changes

- `.github/workflows/ai-sdlc-review.yml`: rewrote the cost-saver APPROVE body (Finding 1) to describe the auto-approve semantics + point at `docs/operations/quality-gate.md`; rewrote the `Note:` line (Finding 2) to reflect post-AISDLC-388 truth (attestation is machine-enforced via `ai-sdlc/pr-ready`); stripped tracker IDs from the docs-only status description, the incremental-skip auto-approved verdict summary, the budget-circuit-breaker comment paragraph + footer, the v1-marker warning, the incremental-state marker, the attestation cost-saver status description + comment body + footer, and the prompt-preamble `## INCREMENTAL REVIEW` echo.
- `.github/workflows/verify-attestation.yml`: stripped `(AISDLC-214)` from the docs-only attestation status description.
- `scripts/check-adopter-facing-strings.test.mjs` (new): node-test snapshot enforcing the hygiene rule. Recognizes YAML `#` and JS `//` comments (whole-line + trailing) as maintainer-facing exemptions; treats every other line containing `AISDLC-\d+` as a leak. Includes 1 classifier-unit-test covering both directions.
- `package.json`: added `test:adopter-facing-strings` script + appended it to the `test` chain so CI runs it on every PR.

### Design decisions

- **JS `//` comment exemption**: workflows use `actions/github-script@v7` blocks with embedded JS that legitimately documents source via `//` and `// ──` block-rule comments. Those are stripped at JS-parse time and never reach GitHub, so they have the same maintainer-facing semantics as YAML `#`. The classifier exempts both forms.
- **Shell echo prompts also rewritten**: line 761's `echo "## INCREMENTAL REVIEW (AISDLC-142)"` is fed into a reviewer subagent prompt, not posted to GitHub. Cleaned it anyway — costs nothing, keeps the corpus consistent, and avoids carving a "prompt-only" exemption the classifier would need to encode.
- **Watched-workflow list is explicit**: the test takes a hard-coded list of six workflows rather than globbing `.github/workflows/*.yml`. New workflows that post to GitHub must be added to the list when they ship. Trade-off vs. globbing: glob would catch new leaks for free but also flag legitimate maintainer-only workflows; explicit list keeps signal high.

### Verification

- `pnpm format:check` — clean
- `pnpm lint` — clean
- `node --test scripts/check-adopter-facing-strings.test.mjs` — 7/7 pass
- `node --test scripts/verify-attestation.test.mjs` — 97/97 pass (1 todo)
- `node --test .github/workflows/__tests__/ai-sdlc-review.test.mjs` — 34/34 pass
- `node --test .github/workflows/__tests__/ai-sdlc-gate.test.mjs` — 24/24 pass
- `node --test .github/workflows/__tests__/fork-pr-safety.test.mjs` — 49/49 pass

### Follow-up

(none — the snapshot test prevents regression and the watched-workflow list is documented in the test header for future maintainers)

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
