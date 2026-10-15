---
id: AISDLC-902
title: 'fix: main is red on rfc:check (PR lifecycle RFC legacy status) and main-health-monitor runs rfc:check'
status: In Progress
assignee: []
created_date: '2026-10-14'
labels: [ci, rfc]
dependencies: []
references: [scripts/check-rfc-docs.mjs, .github/workflows/main-health-monitor.yml, spec/rfcs/README.md]
priority: critical
dispatchable: true
---

## Description

PR #1542 (OQ walkthrough of the PR lifecycle RFC, landed 2026-10-14 18:50) set the RFC's legacy `status:` to `Ready for Review`, a value `KNOWN_STATUSES` in `scripts/check-rfc-docs.mjs` does not accept. `node scripts/check-rfc-docs.mjs` on `origin/main` fails: `rfc 0054: invalid or missing 'status' (got "Ready for Review"; expected one of Draft, Under Review, Approved, Implemented, Final, Rejected, Withdrawn)`. Every PR that runs the full `pnpm test` in `ai-sdlc-gate.yml` Build & Test fails the four `CLI` subtests of `scripts/check-rfc-docs.test.mjs` (`# fail 4`); on 2026-10-15 that is PRs #1480, #1531 and #1546, and any code PR rebased onto main. `main-health-monitor.yml` stayed green because its full-suite step does not run `rfc:check`, so the regression was invisible for hours. The README mapping guide (spec/rfcs/README.md, "Legacy status field") maps `lifecycle: Ready for Review` to `status: Draft`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that an RFC carries two status fields. The legacy `status` enum exists only so `check-rfc-docs.mjs` can decide when to enforce `requiresDocs`; retiring it is a larger change and not this task. 2. Deleted: nothing deleted; the invalid value is replaced. 3. Simplified: set the 0054 RFC frontmatter `status: Draft` per the README mapping (keep `lifecycle: Ready for Review`), the one-line change that turns main green; do not widen `KNOWN_STATUSES`, which would blur the two fields. 4. Accelerated: `main-health-monitor.yml` runs `pnpm rfc:check` (the same step the gate's Build & Test runs after coverage) so an RFC edit that breaks the check shows on the main-push run within minutes instead of on the next unrelated code PR. 5. Automated: `check-rfc-docs.test.mjs` already covers the CLI against the real workspace; no new test beyond the workflow step. Optional, only if trivial: a one-line hint in the gate's error message pointing to the README mapping table.

## Acceptance Criteria

- [ ] `node scripts/check-rfc-docs.mjs` exits 0 on the branch; the 0054 RFC frontmatter has `status: Draft` and `lifecycle: Ready for Review`; the README registry row for 0054 shows the same.
- [ ] `node --test scripts/check-rfc-docs.test.mjs` passes (all `CLI` subtests).
- [ ] `.github/workflows/main-health-monitor.yml` runs `pnpm rfc:check` in its main-push suite.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Docs + workflow change; it touches `.github/workflows/` which is allowed for internal agents. After it lands, PRs #1480, #1531 and #1546 need a rebase onto main (or a rerun once their CI ref includes the fix). #1546 also hit a separate one-off race (`reference prebuild` generate-schemas written twice concurrently under the dogfood `pretest:coverage` build); a plain rerun is expected to clear it, file separately only if it recurs.
