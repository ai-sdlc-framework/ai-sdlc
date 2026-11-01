---
id: AISDLC-940
title: 'Security findings become backlog tasks: CodeQL, Dependabot and Scorecard alerts file a task with a dismissal-reason field'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - security
  - backlog
  - automation
dependencies: []
references:
  - .github/workflows/codeql.yml
  - .github/workflows/scorecard.yml
  - .github/dependabot.yml
  - ai-sdlc-plugin/commands/triage.md
  - docs/operations/deps-composition.md
priority: high
dispatchable: true
---

## Description

Security findings live in three GitHub tabs (code scanning, Dependabot, Scorecard) that no session reads. Dependabot alert #94 (moderate) has sat open on `main` since 2026-10-15 with no task, because nothing turns an alert into backlog work. The playbook gap analysis (2026-10-16, gap 17) asks for the routing the rest of the system already has: a finding becomes a backlog task, and closing it without a fix records why.

**Five-step review (requirements first).**
1. Requirement questioned: "the operator reviews the security tabs". He does not; the tabs are outside every loop the hierarchy runs.
2. Delete: nothing to delete; the scanners stay as they are.
3. Simplify: one script, `scripts/security-findings-to-tasks.mjs`, lists open alerts through the REST API and writes one task file per alert not yet filed (keyed by alert number in the task body), on the existing planner filing path.
4. Accelerate: run it from the nightly suite, not per PR (the installation API budget is already tight).
5. Automate: a `dismissal:` frontmatter field (`reason` + `by` + `date`) is the only sanctioned way to complete such a task without a code change; the DoR check rejects a completed finding task that has neither a PR nor a dismissal.

Velocity impact: positive. Findings stop being surprise work at release time.

## Acceptance Criteria

- [ ] AC-1: `scripts/security-findings-to-tasks.mjs --dry-run` lists open CodeQL, Dependabot and Scorecard alerts with severity and the task id each would get; without `--dry-run` it writes the task files under `backlog/tasks/` (label `security-finding`, body carries alert source, number, severity, URL) and opens one filing PR for the batch.
- [ ] AC-2: Idempotent: an alert already named in an open or completed task is skipped.
- [ ] AC-3: Task template gains an optional `dismissal:` frontmatter block (`reason`, `by`, `date`); `cli-dor-check` fails a `security-finding` task moved to `backlog/completed/` with neither a PR reference nor a `dismissal:` block.
- [ ] AC-4: A nightly workflow job (in the existing nightly workflow, no new workflow file) runs the script with `--dry-run` output in the job summary and files when `AI_SDLC_FILE_SECURITY_FINDINGS=1` is set in repo variables.
- [ ] AC-5: Vitest covers: alert listing parse, dedupe against existing tasks, task body rendering, DoR dismissal rule.
- [ ] AC-6: `docs/operations/deps-composition.md` (or a new `docs/operations/security-findings.md` linked from the README index) documents the flow and the dismissal rule.

## Notes

Origin: playbook gap analysis 2026-10-16 (gap 17). Dependabot alert #94 is the first alert the script should file.
