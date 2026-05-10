---
id: AISDLC-250
title: check-attestation-sign.sh should pass --harness-name and --harness-version from CODEX_VERSION env
status: Done
assignee: []
created_date: '2026-05-09'
labels:
  - codex
  - attestation
  - bug
  - aisdlc-202.4-followup
parentTaskId: AISDLC-202
dependencies:
  - AISDLC-202.3
references:
  - scripts/check-attestation-sign.sh
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - docs/operations/cross-harness-review.md
priority: medium
---

## Problem

`docs/operations/cross-harness-review.md` (AISDLC-202.3 section) states:

> The pre-push hook's `check-attestation-sign.sh` already reads the `CODEX_VERSION` env var (when set) to populate `--harness-name` and `--harness-version` automatically in the Codex execution path.

This is aspirational, not implemented. The actual `scripts/check-attestation-sign.sh` invokes `sign-attestation.mjs` without `--harness-name` or `--harness-version`:

```bash
node "$WT_ROOT/ai-sdlc-plugin/scripts/sign-attestation.mjs" \
  --review-verdicts "$VERDICT_FILE" \
  --iteration-count "$ITERATION_COUNT" \
  --harness-note "$HARNESS_NOTE"
```

The `CODEX_VERSION` env var is never read. This means Codex-path attestation envelopes always show `harness: <unknown>` in CI verification logs even when the Codex harness is known, making the harness field audit-unusable for Codex PRs.

## Goal

Implement the `CODEX_VERSION` env var behavior documented in `cross-harness-review.md`: when `CODEX_VERSION` is set, pass `--harness-name codex --harness-version $CODEX_VERSION` to `sign-attestation.mjs`.

## Acceptance Criteria

- [ ] #1 `scripts/check-attestation-sign.sh` reads `CODEX_VERSION` env var when present.
- [ ] #2 When `CODEX_VERSION` is set, the hook passes `--harness-name codex --harness-version "$CODEX_VERSION"` to `sign-attestation.mjs`.
- [ ] #3 When `CODEX_VERSION` is absent, the hook behaves as today (no `--harness-name` / `--harness-version` flags).
- [ ] #4 `scripts/check-attestation-sign.test.mjs` gains test coverage for both the `CODEX_VERSION`-set and `CODEX_VERSION`-absent paths.
- [ ] #5 `docs/operations/cross-harness-review.md`'s "How the harness field is populated" section is updated to reflect the implemented behavior (remove the aspiration marker).
