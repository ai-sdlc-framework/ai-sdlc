---
id: AISDLC-1289
title: 'Dependabot covers the Go modules of sdk-go with grouped weekly updates and the bot label'
status: To Do
assignee: []
created_date: '2026-11-16'
labels:
  - dependencies
  - ci
dependencies: []
references:
  - .github/dependabot.yml
  - sdk-go/go.mod
  - sdk-go/operator/go.mod
  - scripts/issue-link-decision.mjs
priority: low
dispatchable: true
dispatchableReason: 'Dependabot security PR #2653 for the Go SDK arrived without the `ci:no-issue-required` label, could not pass the issue-link check and had to be replaced by AISDLC-1274, which then moved Go and OpenTelemetry several versions in one task. `.github/dependabot.yml` has entries for `npm` and `github-actions` only (checked by the planner on 2026-11-16). The operator delegated the decision to the planner on 2026-11-16.'
---

## Description

**Gap.** `.github/dependabot.yml` configures `npm` and `github-actions`. The repository also has two Go modules, `sdk-go/go.mod` and `sdk-go/operator/go.mod`, with no entry. Two effects:

- Security updates for Go still open PRs (they need no entry), but with no entry they carry no labels. Without `ci:no-issue-required` the issue-link check (`scripts/issue-link-decision.mjs`, `BYPASS_LABEL`) fails, as on #2653.
- No version updates arrive, so the modules stand still until a security alert forces a large jump. AISDLC-1274 moved the Go toolchain and the OpenTelemetry modules in one task for that reason.

**Decision (planner, 2026-11-16).** Options weighed: (a) a `gomod` entry with grouped weekly minor and patch updates and the two labels; (b) a `gomod` entry with `open-pull-requests-limit: 0`, which labels security PRs and opens no version PRs; (c) no entry; (d) `gomod` and `pip` together. Option (a) was chosen. The strongest case against it is PR load: the hierarchy has an open-PR limit, and a failing dependency PR is routed to the planner, as #2684 was. (a) was kept because one group over both directories gives at most one PR a week, the `Test Go SDK` job already runs on `sdk-go/**`, and small weekly steps are what prevents the multi-version jump of AISDLC-1274. (b) fixes the label and keeps the drift. (d) is wider than the observed problem: the Python SDK pins its build requirements by hash and needs its own look.

The label is the one the `npm` and `github-actions` entries already carry. This task applies an existing bot bypass of the issue-link check to one more ecosystem; it adds no new bypass and changes no check.

**Shape.** One more `updates` entry, of the same form as the `npm` one.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: are weekly Go version PRs wanted, or only labelled security PRs? Weekly, for the reason above; majors are left out because each needs coordinated work. 2. Deleted: nothing. 3. Simplified or optimised: one entry with `directories` for both modules and one group, not two entries. 4. Accelerated: not applicable. 5. Automated: Dependabot itself.

- Add an entry to `.github/dependabot.yml`: `package-ecosystem: gomod`; both module directories (`/sdk-go` and `/sdk-go/operator`) in one entry; weekly on Monday; `open-pull-requests-limit: 2`; labels `dependencies` and `ci:no-issue-required`; one group for minor and patch updates of all modules; major updates ignored; commit message prefix `chore(deps)`.
- Update the comment at the top of the file, which says "Two ecosystems".
- When a test under `.github/workflows/__tests__/` reads `dependabot.yml`, extend it; when none does, add no test and say so in the PR body.

Out of scope: `pip` for `sdk-python`; any change to the issue-link check; the Go version itself.

## Acceptance Criteria

- [ ] #1 `.github/dependabot.yml` has a `gomod` entry covering `/sdk-go` and `/sdk-go/operator` with a weekly schedule, the labels `dependencies` and `ci:no-issue-required`, one group for minor and patch updates and an ignore for major updates.
- [ ] #2 The `npm` and `github-actions` entries are unchanged.
- [ ] #3 The file parses as YAML and the header comment names three ecosystems.
- [ ] #4 The PR body states whether a test reads `dependabot.yml` and what was done.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
