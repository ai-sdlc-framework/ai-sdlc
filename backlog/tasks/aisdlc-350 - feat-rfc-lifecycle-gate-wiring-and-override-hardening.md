---
id: AISDLC-350
title: 'feat: wire RFC lifecycle promotion gate into CI + harden operator override'
status: To Do
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

- [ ] **CI workflow step** in `.github/workflows/ci.yml` (or a dedicated `rfc-lifecycle-check.yml`) that:
  1. Detects changed `spec/rfcs/*.md` files in the PR diff
  2. For each, runs `git show $BASE_REF:$file` to extract the prior content
  3. Invokes `node scripts/check-rfc-lifecycle-transitions.mjs --before <prior> --after <current>` per file
  4. Fails the PR if any returns non-zero
  5. Posts a `ai-sdlc/rfc-lifecycle` commit status (success/failure)
- [ ] **Branch protection update** docs: note that operators must add the new check to required-checks for `main` after the workflow has soaked for one week
- [ ] **Diagnostic message** in the library (`check-rfc-lifecycle-transitions.mjs` line 191) currently says "`pnpm rfc:test` enforces the gate" — that's false (only runs unit tests). Update to point at the CI workflow + the actual enforcing script invocation.

### Override hardening (HIGH per security reviewer)

- [ ] **Operator allowlist**: the override marker `<!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->` MUST validate `<operator>` against a committed allowlist (e.g. `.ai-sdlc/lifecycle-approvers.yaml`). Any name not in the allowlist → override ignored, lifecycle ladder enforced.
- [ ] **Defense-in-depth — both locations**: require marker presence in BOTH PR body AND RFC body (not either). Single-source override is currently a trust-all bypass.
- [ ] **GH review signature option**: alternative to in-marker override — operator submits an approving GH review comment containing the marker; CI validates via `gh api review.user.login` against the allowlist.
- [ ] **Audit log**: every override emission writes a structured entry to `.ai-sdlc/_audit/lifecycle-overrides.jsonl` (append-only). Fields: `{ts, rfc, fromLifecycle, toLifecycle, operator, reason, prNumber, commitSha}`. Slack digest pulls this for nightly review.

### Library fail-closed fixes (MEDIUM per security reviewer)

- [ ] **`extractLifecycle` returning null when `from` had value → fail closed** (currently passes as "new-file" treatment). When toContent's lifecycle is null but fromContent's was set, treat as "lifecycle removed mid-PR" and fail with a clear diagnostic.
- [ ] **Empty-reason override** (`parseOverrideMarker` line 178): if `reason` is whitespace-only after trim, return null (audit-trail purpose is undermined by blank reasons).
- [ ] **YAML parser**: replace hand-rolled `extractLifecycle` line-by-line scan with `js-yaml.load(frontmatter)` (already a repo dep). Closes the "lifecycle as nested key / inside block-scalar / inside YAML comment" bypass.

### Operator name + ANSI hygiene (LOW per security reviewer)

- [ ] **Tighten operator-name capture**: `OVERRIDE_MARKER_REGEX` should constrain operator capture to `[a-zA-Z0-9_-]{1,32}` (currently `[^\s>]+` allows special chars including potential ANSI escapes).
- [ ] **Reason sanitization**: strip control chars from `reason` before logging or appending to audit JSONL.

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
