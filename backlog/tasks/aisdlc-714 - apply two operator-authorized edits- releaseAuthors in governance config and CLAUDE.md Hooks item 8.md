---
id: AISDLC-714
title: >-
  Apply two operator-authorized edits: releaseAuthors in governance config, and CLAUDE.md Hooks item 8
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - docs
dependencies:
  - AISDLC-702
  - AISDLC-694
references:
  - .ai-sdlc/agent-role.yaml
  - CLAUDE.md
  - spec/schemas/agent-role.schema.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two edits (three lines in all) were approved by the operator and need an executor to apply them. On
2026-10-04 the operator (Dominique Legault) told the planner session directly, about both:
"write it into a task so an executor applies it". This task is that authorization; the
executor does not need a further word from the operator for these two edits and must not
make any other edit to either file.

1. `.ai-sdlc/agent-role.yaml`: add `releaseAuthors: [deefactorial]` and `allowReleaseMerge: true`
   (two lines) under `spec.governance`. The operator approved the second line directly on
   2026-10-04 ("Approved"). Reason for the second line: the release path honors `allowMerge`
   (this repository runs `never`) unless `allowReleaseMerge: true` is set.
   Reason for the first line:
   Reason: the release merge path from AISDLC-702 accepts a release PR only when its author
   is in the effective release author set (releaseAuthors, else mergeAuthors, else the
   release-please bot identities; DEC-0050). This repository's release PRs are authored by
   the personal access token owner `deefactorial`, and the config sets neither key, so the
   path would refuse every release PR here.
2. `CLAUDE.md`, Hooks section item 8: replace the old text with the new text exactly as
   given in the "operator review" section of the pull request that implements AISDLC-694
   (PR #1195). Reason: AISDLC-694 changes what the pre-push hook runs and `CLAUDE.md` must
   describe the behaviour on main.

## Acceptance Criteria
- [ ] `.ai-sdlc/agent-role.yaml` contains `releaseAuthors: [deefactorial]` under `spec.governance`, validates against `spec/schemas/agent-role.schema.json` as extended by AISDLC-702, and nothing else in the file changes. Applied only once the release source kind change is on main (the key does not exist in the schema before that).
- [ ] `.ai-sdlc/agent-role.yaml` also contains `allowReleaseMerge: true` under `spec.governance`; with it present and `allowMerge: never`, the release path in a dry run does not refuse on the master switch, and with the line removed it refuses and the refusal names both keys; the dry-run output is pasted in the PR body.
- [ ] With that line present, the release source kind's eligibility check accepts a release PR authored by `deefactorial` on the release-please branch in a dry run, and still refuses one authored by another login; the dry-run output is pasted in the PR body.
- [ ] `CLAUDE.md` Hooks item 8 matches the new text from PR #1195's body exactly, applied only after that PR is on main; no other line of `CLAUDE.md` changes.
- [ ] The two config lines are applied with the Edit tool, through the governance hook. Sessions run the installed plugin's hook, which refuses Write and Edit under `.ai-sdlc/` until the release that ships the config-edit trust model change (backlog task 720) is installed. Until then the config half of this task waits; no executor routes the edit through a shell command to get around the hook, because the operator's authorization covers the content of the change, not a bypass. The CLAUDE.md Hooks item 8 half does not wait and ships as its own small pull request.
- [ ] The two edits may ship as two small PRs if their dependencies land at different times; each PR body quotes the operator authorization above and carries a "Velocity impact" section stating that these edits remove a human-only exit.

## Out of scope
- Any other governance config or `CLAUDE.md` change; adding other logins.
<!-- SECTION:DESCRIPTION:END -->
