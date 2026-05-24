---
id: AISDLC-350
title: 'feat: wire RFC lifecycle promotion gate into CI + harden operator override'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0011
  - lifecycle-gate
  - security
  - critical-from-review
dependencies:
  - AISDLC-297
priority: high
references:
  - scripts/check-rfc-lifecycle-transitions.mjs
  - .github/workflows/ci.yml
---

## Background

AISDLC-297 (PR #509) shipped the lifecycle ladder checker as a standalone library — but security + code reviewers caught that the gate is NOT WIRED INTO ANY CI WORKFLOW, HUSKY HOOK, OR PIPELINE STEP. `pnpm rfc:lifecycle-check` (the only npm script referencing the gate) exits 0 unconditionally because no caller supplies `--before`/`--after` from the git diff. As shipped, the gate is dead code — no actual enforcement.

Plus several adjacent hardening findings the security reviewer wants addressed before the gate can be trusted as a real merge-gate.

## Acceptance criteria

### Wiring (CRITICAL per security reviewer)

- [x] **CI workflow step** in `.github/workflows/rfc-lifecycle-check.yml` that:
  1. Detects changed `spec/rfcs/*.md` files in the PR diff
  2. For each, runs `git show $BASE_SHA:$file` to extract the prior content
  3. Invokes `node scripts/check-rfc-lifecycle-transitions.mjs --before <prior> --after <current>` per file
  4. Fails the PR if any returns non-zero
  5. Posts a `ai-sdlc/rfc-lifecycle` commit status (success/failure)
- [x] **Branch protection update** docs: workflow includes operator action note after one-week soak (see workflow comment + PR body)
- [x] **Diagnostic message** updated to point at `.github/workflows/rfc-lifecycle-check.yml` (AISDLC-350) instead of the false `pnpm rfc:test` claim

### Override hardening (HIGH per security reviewer)

- [x] **Operator allowlist**: `.ai-sdlc/lifecycle-approvers.yaml` committed; `loadLifecycleApprovers()` validates operator against it; names not in list → override ignored, ladder enforced
- [x] **Defense-in-depth — both locations**: marker must now appear in BOTH PR body AND RFC body; single-source override is rejected with clear diagnostic
- [x] **GH review signature option**: `rfc-lifecycle-check.yml` checks approving review comments for the marker and validates reviewer login against allowlist
- [x] **Audit log**: `appendAuditEntry()` writes to `.ai-sdlc/_audit/lifecycle-overrides.jsonl`; `_audit/.gitkeep` ensures directory is tracked

### Library fail-closed fixes (MEDIUM per security reviewer)

- [x] **`extractLifecycle` fail-closed**: `toLifecycle === null` with `fromLifecycle` set now fails with "REMOVED" diagnostic instead of passing as new-file
- [x] **Empty-reason override**: `parseOverrideMarker` returns null when reason is whitespace-only after trim
- [x] **YAML parser**: `extractLifecycle` uses `js-yaml.load(frontmatter)` when available (js-yaml added as root devDependency); fallback inline parser restricted to col-0 keys only to block nested-key bypass

### Operator name + ANSI hygiene (LOW per security reviewer)

- [x] **Tighten operator-name capture**: `OVERRIDE_MARKER_REGEX` now uses `[a-zA-Z0-9_-]{1,32}` — blocks ANSI escapes and special chars
- [x] **Reason sanitization**: `sanitizeReason()` strips C0/C1 control chars before logging or audit JSONL writes

## Out of scope

- Migrating existing RFC files to the new lifecycle ladder (separate retroactive task if needed)
- Slack integration for the audit feed (separate Slack-substrate task)
- Pre-commit hook variant (`.husky/pre-commit` running the gate locally) — CI is the primary enforcement point; pre-commit is operator-convenience for later

## Source

Filed 2026-05-16 from AISDLC-297 PR #509 review findings:
- Code-reviewer MAJOR (wiring gap, false diagnostic message)
- Security-reviewer CRITICAL (no enforcement), HIGH (trust-all override), MEDIUM (silent bypass via removed lifecycle field), 2× LOW (YAML parser + operator name regex)
- Test-reviewer 4× MINOR (empty-reason override bypass untested, Withdrawn lifecycle ambiguity)

PR #509 ships the library substrate ONLY. AISDLC-350 wires + hardens so the gate becomes real enforcement.

## finalSummary

## Summary

Wired the RFC lifecycle ladder checker into CI as a real merge gate and addressed all security reviewer hardening findings. A new dedicated workflow `.github/workflows/rfc-lifecycle-check.yml` fires on every PR that touches `spec/rfcs/*.md`, extracts before/after content via `git show`, and invokes the checker per RFC, posting `ai-sdlc/rfc-lifecycle` commit status. The script itself received: js-yaml YAML parser (closes nested-key/comment bypass), fail-closed lifecycle-removed-mid-PR detection, dual-location override requirement (both PR body AND RFC body), operator allowlist (`.ai-sdlc/lifecycle-approvers.yaml`), GH review signature alternative override, append-only audit log, empty-reason rejection, tightened operator-name regex, and reason sanitization.

## Changes

- `.github/workflows/rfc-lifecycle-check.yml` (new): CI enforcement workflow
- `scripts/check-rfc-lifecycle-transitions.mjs` (modified): all hardening applied
- `scripts/check-rfc-lifecycle-transitions.test.mjs` (modified): 76 tests covering all new behaviors
- `.ai-sdlc/lifecycle-approvers.yaml` (new): operator allowlist
- `.ai-sdlc/_audit/.gitkeep` (new): tracks audit directory
- `package.json` (modified): js-yaml added as root devDependency
- `pnpm-lock.yaml` (modified): updated lockfile

## Design decisions

- **Dedicated workflow vs ci.yml job**: Chose `rfc-lifecycle-check.yml` over a ci.yml job so the `ai-sdlc/rfc-lifecycle` status name is clear and the `paths:` filter is RFC-specific.
- **js-yaml as root devDep**: Added to root package.json (not just pipeline-cli) so `scripts/check-rfc-lifecycle-transitions.mjs` can use it without a package.json of its own; fallback inline parser retained for safety.
- **Dual-location override**: Defense-in-depth against PR body being auto-populated without RFC body consent; both must contain the marker.
- **Empty approvers → no enforcement**: When allowlist file is missing or empty, allowlist validation is skipped for backward compatibility (fresh adopter repos that haven't set up the allowlist yet).

## Verification

- `pnpm build` — clean
- `pnpm test` — all pass (76 lifecycle-gate tests + all other suite tests)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

- Operator should add `ai-sdlc/rfc-lifecycle` to required-checks after one-week soak
- Slack digest integration for `_audit/lifecycle-overrides.jsonl` (out of scope per task)
