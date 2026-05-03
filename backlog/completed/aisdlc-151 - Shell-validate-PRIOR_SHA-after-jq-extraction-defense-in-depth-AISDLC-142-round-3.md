---
id: AISDLC-151
title: >-
  Shell-validate PRIOR_SHA after jq extraction (defense-in-depth, AISDLC-142
  round 3)
status: Done
assignee: []
created_date: '2026-05-02 19:00'
labels:
  - ci
  - security
  - deps
dependencies:
  - AISDLC-142
references:
  - .github/workflows/ai-sdlc-review.yml
  - pipeline-cli/src/incremental-review/incremental.ts
  - pipeline-cli/src/incremental-review/incremental.test.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Defense-in-depth follow-up from the AISDLC-142 round-3 security review (severity LOW).

In `.github/workflows/ai-sdlc-review.yml` (analyze job, around lines 281–319), the workflow extracts `PRIOR_SHA` from the marker JSON (parsed via `jq -r '.reviewedSha'`) and interpolates it into a `git diff` invocation:

```bash
git diff "$PRIOR_SHA"...HEAD --numstat
```

The TypeScript-side `parseMarker` validates `reviewedSha` matches `/^[0-9a-f]{40}$/i` BEFORE producing the marker — but the bash-side extraction trusts whatever `jq` returns. A trusted COLLABORATOR could in principle craft a marker JSON with `reviewedSha` containing git-option-injection content (e.g. `--upload-pack=evil`).

The `...HEAD` suffix in the diff invocation mitigates pure option injection (the resulting arg starts with `--upload-pack=...HEAD` which git rejects as malformed), but bash-side hex-only validation is cheap insurance — and during implementation we discovered the original `printf '%s' | grep -qE` pattern also misses embedded-newline payloads (line-anchored regex matches line 1 only, letting `<40 valid hex>\n--evil` smuggle through). The final implementation uses bash's `[[ =~ ]]` which matches the whole string atomically.

### Threat model

The threat is a trusted `COLLABORATOR` (push access) crafting a marker comment containing a `reviewedSha` that decodes to git option-injection. The TS-side `parseMarker` would normally reject it, but the bash-side `jq -r '.reviewedSha'` runs against the raw decoded JSON without re-validating — so a payload that bypasses the TS parser (or a marker constructed by hand against the raw JSON shape) reaches `git diff` unchecked. In practice, git rejects malformed args, and the trust boundary already requires push access, so severity is LOW. But the validation is one bash conditional and removes the threat entirely.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance criteria

1. After extracting PRIOR_SHA via jq, validate with a bash regex that PRIOR_SHA matches `^[0-9a-fA-F]{40}$` (case-insensitive)
2. On invalid SHA: log a `::warning::` annotation including the offending value, set `PRIOR_SHA=""`, and fall through to the no-prior-SHA code path (FULL review)
3. Test in `pipeline-cli/src/incremental-review/incremental.test.ts` verifies the bash-side validation rejects malformed SHAs (executes the validator under a real `bash` subprocess across the adversarial payload matrix: too-short, too-long, non-hex, option-injection prefix, embedded-newline smuggling, leading whitespace, shell-metacharacter content)
4. The validation MUST run BEFORE PRIOR_SHA enters any subprocess invocation

## Out of scope

- Re-validating PRIOR_SHA inside the TypeScript `parseMarker` path — already enforced by `/^[0-9a-f]{40}$/i` regex
- Migrating off `jq` for marker JSON extraction — the bash hardening makes the jq trust boundary moot
- Hardening the `contentHash` field in the marker — that field is consumed only by the TS-side `decideIncrementalReview` which already validates schema

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added a bash-side `[[ "$PRIOR_SHA" =~ ^[0-9a-fA-F]{40}$ ]]` validator in the `ai-sdlc-review.yml` analyze job that runs immediately after the `jq -r '.reviewedSha'` extraction and BEFORE the `git diff "$PRIOR_SHA"...HEAD --numstat` invocation. On reject, the validator emits a `::warning::` annotation (operator visibility) and clears `PRIOR_SHA` so the no-prior-SHA path takes over (FULL review). Initial `printf | grep` design was upgraded to bash `[[ =~ ]]` after a test caught that line-anchored grep lets embedded-newline payloads (`<40 valid hex>\n--evil`) smuggle past line 1.

## Changes
- `.github/workflows/ai-sdlc-review.yml` (modified, +21/-0): Added validator block immediately after the `PRIOR_SHA=$(... | jq -r '.reviewedSha' ...)` assignment. Comment block documents the threat model, the `...HEAD`-suffix mitigation, and the rationale for `[[ =~ ]]` over `printf | grep`.
- `pipeline-cli/src/incremental-review/incremental.test.ts` (modified, +148/-0): Added two `describe` blocks. First (4 tests) asserts the workflow YAML carries the validator regex literal, the warning annotation, the empty-PRIOR_SHA reset, and the textual ordering vs the `git diff` invocation (AC #4 drift gate). Second (11 tests) executes the validator snippet under a real `bash` subprocess across valid and adversarial payloads — including the embedded-newline case that drove the bash-regex switch.

## Design decisions
- **Bash `[[ =~ ]]` over `printf | grep`**: the line-anchored grep form treats embedded `\n` as line separators, so a payload of `<40 valid hex>\n--evil` matches line 1 against `^[0-9a-f]{40}$` and passes — letting the rest smuggle through. `[[ =~ ]]` matches against the whole string atomically. The test we wrote first caught this; we then hardened the validator.
- **Pass `input` via env in tests, not by single-quoting**: matches how `$PRIOR_SHA` actually reaches the validator in the workflow (a shell variable populated from a subprocess), avoids shell-quoting hassles with embedded newlines / single quotes, and keeps the test payload exactly identical to the real attack surface.
- **Skip the bash subprocess tests on Windows**: AI-SDLC dev + CI all run on macOS/Linux, but Vitest is occasionally invoked from Windows editors. `describe.skip` on `process.platform === 'win32'` avoids spurious failures without lowering CI coverage.
- **AC #4 ordering test searches for the actual `git diff "$PRIOR_SHA"...HEAD --numstat` invocation, not a prose mention**: the workflow comment block discusses `git diff PRIOR_SHA…HEAD` (with ellipsis to avoid the literal); the test anchors on the `--numstat` suffix that only appears in the real invocation. Drift-resistant against future doc edits.

## Verification
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test -- --run incremental.test.ts` — 67 tests pass (15 new, all 52 pre-existing still green)

## Follow-up
- (none) — self-contained defense-in-depth hardening. The validator is one branch with a `::warning::` log; if the codepath ever fires in production, operators will see the offending payload in workflow logs and can decide whether to investigate the marker source.
<!-- SECTION:FINAL_SUMMARY:END -->
