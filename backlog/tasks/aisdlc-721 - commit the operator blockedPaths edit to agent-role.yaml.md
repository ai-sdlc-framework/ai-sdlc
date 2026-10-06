---
id: AISDLC-721
title: >-
  Commit the operator's agent-role.yaml edit: remove two blockedPaths entries
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - governance
  - config
dependencies: []
references:
  - .ai-sdlc/agent-role.yaml
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Dominique Legault (operator) edited `.ai-sdlc/agent-role.yaml` in the main checkout on 2026-10-03/04, removing two entries from `spec.governance.blockedPaths`: `.github/workflows/**` and `.ai-sdlc/**`. The edit is uncommitted. Per DEC-0057 it is applied by an executor with the Edit tool through the normal PR pipeline, with no exception to any hook, now that plugin 0.23.0 (AISDLC-720) allows trusted local sessions to edit `.ai-sdlc` config.

Reason: the "never edit .github/workflows" rule guards external agents only. Operator-overseen internal work may edit workflows and this repo's own config through reviewed PRs (DEC-0048 and the `.ai-sdlc` config decision recorded for AISDLC-720).

Three pieces of work wait on it: the CI-marker workflow half of AISDLC-720, the pr-ready rollup half of AISDLC-712, and the workflow half of AISDLC-704.

The operator's edit, as a zero-context diff against main (`git diff -U0`):

```diff
--- a/.ai-sdlc/agent-role.yaml
+++ b/.ai-sdlc/agent-role.yaml
@@ -35,2 +34,0 @@ spec:
-      - '.github/workflows/**'
-      - '.ai-sdlc/**'
```

Out of scope: any other change to `agent-role.yaml`; changing what the blockedPaths hook (`ai-sdlc-plugin/hooks/enforce-blocked-actions.js`) does.

## Acceptance Criteria
- [ ] `.ai-sdlc/agent-role.yaml` on main no longer lists `.github/workflows/**` or `.ai-sdlc/**` under `spec.governance.blockedPaths`; every other line of the file is unchanged (diff limited to those two deletions).
- [ ] The edit is made with the Edit tool in the task worktree; no skip variable, no script that writes around the hook. If the installed hook refuses, the refusal text goes in the PR body and the task stops.
- [ ] The PR body states which plugin version's hook allowed the edit.
- [ ] Any schema or test that asserts those two entries is updated in the same PR, with the reason.
- [ ] After merge, the planner restores the main checkout's working copy of the file from main (it must then be byte-identical).
<!-- SECTION:DESCRIPTION:END -->
