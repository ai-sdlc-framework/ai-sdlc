---
id: AISDLC-1287
title: 'Bug report template carries acceptance criteria, and the readiness comment stops naming a command that does not exist'
status: Done
assignee: []
created_date: '2026-11-16'
labels:
  - dor
  - pipeline-cli
  - bug
dependencies: []
references:
  - .github/ISSUE_TEMPLATE/bug-report.yml
  - .github/ISSUE_TEMPLATE/feature-request.yml
  - pipeline-cli/src/dor/comment-loop.ts
  - pipeline-cli/src/dor/comment-loop.test.ts
  - pipeline-cli/src/dor/staleness.ts
  - pipeline-cli/src/dor/staleness.test.ts
  - pipeline-cli/src/dor/gates/gate-1-ac-testable.ts
  - .github/workflows/dor-ingress.yml
  - docs/operations/dor-ingress-gate.md
priority: medium
dispatchable: true
dispatchableReason: 'Reported by an adopter in GitHub issue #2636 and confirmed in source by the planner on 2026-11-16: `bug-report.yml` has no acceptance criteria field, gate 1 blocks an issue without a checklist, and the comment text `/dor-recheck` appears in `comment-loop.ts` and `staleness.ts` while `dor-ingress.yml` runs only on `issues` `opened` and `edited`. The operator delegated the decision to the planner on 2026-11-16.'
---

## Description

**Gap.** A bug filed through the issue form is always blocked by the readiness check, and the bot then tells the reporter to do something that has no effect.

1. **The bug form cannot pass gate 1.** `.github/ISSUE_TEMPLATE/bug-report.yml` has the fields `description`, `steps`, `expected`, `actual`, `complexity` and `context`. It has no acceptance criteria field. `feature-request.yml` has one (`acceptance-criteria`, required). Gate 1 (`pipeline-cli/src/dor/gates/gate-1-ac-testable.ts`) blocks when the body has no checklist line (`- [ ] ...`), with "Issue has no Acceptance Criteria section / checklist."
2. **The comment names a command nothing handles.** `pipeline-cli/src/dor/comment-loop.ts` ends its comment with "Edit the issue to address these, then comment `/dor-recheck` (or just edit and wait ...)". `pipeline-cli/src/dor/staleness.ts` says "edit the issue body to address the clarifying questions, then comment `/dor-recheck`." No workflow listens for issue comments: `.github/workflows/dor-ingress.yml` runs on `issues` with types `opened` and `edited` only. Editing the issue is what reruns the check.

**Decision (planner, 2026-11-16).** Options weighed: (a) add the field to the bug form with a default checklist and reword the two messages; (b) build a comment handler for `/dor-recheck`; (c) exempt bug reports from gate 1; (d) reword the messages only. Option (a) was chosen. Comparable projects (Kubernetes, Rust, VS Code) ask a bug reporter for expected behaviour, not for acceptance criteria, so the strongest case against (a) is that a required field makes outsiders write filler. That is answered by shipping the field with a default checklist the reporter may leave as it is. (b) adds a workflow that runs on comments from anyone for a rerun that an edit already gives. (c) loosens the gate. (d) leaves every bug report blocked.

**Shape.** The bug form has an acceptance criteria field that is filled in by default. Both bot messages tell the reporter to edit the issue and say that the edit reruns the check.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a recheck command needed at all? No: the `edited` trigger already reruns the check, so the command is a second way to do the same thing. 2. Deleted: the `/dor-recheck` instruction from both messages. 3. Simplified or optimised: one way to rerun (edit the issue). 4. Accelerated: a bug report filed through the form passes gate 1 on the first run when the reporter keeps or improves the default. 5. Automated: tests on both message texts and on the form body against gate 1.

- **Bug form.** Add a `textarea` field with id `acceptance-criteria` and label `Acceptance Criteria` to `.github/ISSUE_TEMPLATE/bug-report.yml`, after `actual`. Give it a `value` (the text the form starts with), not only example text, of two checklist lines: the behaviour under Expected Behavior occurs with the steps under Steps to Reproduce; a regression test covers the case. The description says the reporter may keep or change them. The field is required.
- **Messages.** In `comment-loop.ts` and `staleness.ts`, replace the `/dor-recheck` instruction with: edit the issue body; the check runs again on every edit. No other wording changes.
- **Docs.** `docs/operations/dor-ingress-gate.md` states that an edit is the only rerun and that the bug form ships with a default checklist.
- `spec/rfcs/RFC-0011-definition-of-ready-gate.md` also quotes the old comment text and names a `dor-recheck` command. Do not edit the RFC in this task; say so in the PR body so the planner can raise it.

Out of scope: a comment-triggered workflow; any change to a gate's rule; the feature request form.

## Acceptance Criteria

- [ ] #1 `bug-report.yml` has a required `textarea` with id `acceptance-criteria`, label `Acceptance Criteria` and a `value` of two checklist lines.
- [ ] #2 A test builds the issue body GitHub renders from the bug form with every field at its default (field labels as `###` headings) and gate 1 passes on it.
- [ ] #3 The comment built by `comment-loop.ts` does not contain `/dor-recheck` and tells the reporter that editing the issue reruns the check; a test covers it.
- [ ] #4 The message built by `staleness.ts` does not contain `/dor-recheck` and gives the same instruction; a test covers it.
- [ ] #5 No file under `pipeline-cli/src`, `.github` or `docs/operations` contains the string `/dor-recheck`.
- [ ] #6 `docs/operations/dor-ingress-gate.md` describes the rerun on edit and the default checklist of the bug form.
- [ ] #7 The PR body names issue #2636 and the RFC-0011 passages left unchanged.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
