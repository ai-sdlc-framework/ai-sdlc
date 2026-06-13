---
id: AISDLC-548
title: >-
  chore(deps): align @eslint/js 9 → 10 (eslint core already 10) and resolve the
  lint findings blocking Dependabot PR #899
status: To Do
assignee: []
labels:
  - chore
  - dependencies
  - tooling
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - package.json
  - eslint.config.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dependabot PR #899 (`@eslint/js` 9.39.4 → 10.0.1) is **stuck** on `Lint & Format`. NOTE: this is
NOT a full eslint major migration — `eslint` itself is **already `^10.4.1`** on main (with
`eslint-config-prettier ^10` + `typescript-eslint ^8.61`); only `@eslint/js` lags at `^9`. So
this is a small **alignment**, not a migration. Operator chose fix-forward (2026-06-13); when it
lands, **close #899** (superseded).

**Diagnose first (the failure is small but real):** main lints green today with `@eslint/js@9` +
`eslint@10`, so bumping `@eslint/js` to 10 either (a) just aligns the peer and lints clean — in
which case #899's `Lint & Format` failure is actually the **attestation** (`ai-sdlc/attestation:
contentHashV4 mismatch` — a dependabot code PR whose auto-approve/attestation path didn't fire),
not the lint itself; or (b) `@eslint/js@10`'s updated `recommended` config enables a rule that
flags existing code → genuine (small) lint errors to fix. Pull the actual `eslint .` output from
#899's failed `Lint & Format` job (`gh run view <id> --log-failed`, REST) to determine which.

**Work:**
- Bump `@eslint/js` to `^10` in the root manifest (and anywhere else it's pinned); regenerate the
  lockfile cleanly.
- If `eslint .` surfaces new findings under `@eslint/js@10`'s recommended set: fix the flagged
  code, or (if a rule is intentionally not wanted) adjust `eslint.config.mjs` with a documented
  rationale — do NOT blanket-disable.
- Ensure the change carries a valid attestation (this is a code PR — it needs the normal
  attestation, which is what the bare Dependabot PR lacked).
- `pnpm lint && pnpm format:check && pnpm build && pnpm test` green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The actual `Lint & Format` failure on #899 is diagnosed (real `@eslint/js@10` rule finding vs attestation-only) and documented in the PR body
- [ ] #2 `@eslint/js` bumped to `^10` aligned with the already-present `eslint@^10`; lockfile regenerated cleanly
- [ ] #3 Any new lint findings under `@eslint/js@10` are fixed in code (or a config rule decision documented); `pnpm lint` clean
- [ ] #4 `pnpm format:check && pnpm build && pnpm test` green; the PR carries a valid attestation
- [ ] #5 PR body notes it supersedes Dependabot #899 so the operator closes that PR
<!-- AC:END -->
