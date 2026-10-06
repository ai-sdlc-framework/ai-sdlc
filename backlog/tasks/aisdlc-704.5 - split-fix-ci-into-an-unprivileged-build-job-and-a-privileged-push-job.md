---
id: AISDLC-704.5
title: >-
  split fix-ci into an unprivileged build job and a privileged push job
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). AISDLC-704 removed the untrusted checkout from `ai-sdlc-fix-ci.yml` but the pipeline step still holds the write PAT, the job token and ANTHROPIC_API_KEY while the agent runs PR-branch code, and git hooks can run during the final push. Run PR code in a job with no secrets and hand off through an artifact; push from a separate privileged job (at minimum `git -c core.hooksPath=/dev/null push --no-verify`). Also from the AISDLC-704 security review: add `--ignore-pnpmfile` to the pr-work install (and correct the test/comment claiming scripts cannot run), skip the diagnostics copy when the path is a symlink, give the pr-work install its own pnpm store or no cache, and build PR code in pr-work with no secrets if validation needs dist output.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
