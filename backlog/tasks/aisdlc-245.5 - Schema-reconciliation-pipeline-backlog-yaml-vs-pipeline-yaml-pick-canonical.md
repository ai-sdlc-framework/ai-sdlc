---
id: AISDLC-245.5
title: >-
  Phase 5: Schema reconciliation — pipeline-backlog.yaml vs pipeline.yaml pick
  canonical
status: To Do
assignee: []
created_date: '2026-05-08 12:10'
labels:
  - adoption
  - plugin
  - schema
  - phase-5
parentTaskId: AISDLC-245
dependencies: []
priority: high
references:
  - .ai-sdlc/pipeline-backlog.yaml
  - spec/schemas/pipeline.schema.json
  - ai-sdlc-plugin/commands/execute.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Operator decision (2026-05-10)

**(A) pipeline.yaml is canonical — operator decision 2026-05-10.** Migrate slash command bodies to read `.ai-sdlc/pipeline.yaml`. Define backlog-specific section (e.g. `pipeline.yaml: { backlog: { branching, milestones } }`). Keep `pipeline-backlog.yaml` as legacy shim (warn-on-load) for one release, then delete.

## Problem
Framework dev-repo uses `.ai-sdlc/pipeline-backlog.yaml`. Adopter (arc-1) was
shipped `.ai-sdlc/pipeline.yaml` with a different schema. The slash command
body's Step 2 reads branch pattern from `pipeline-backlog.yaml`'s
`branching.pattern` — adopter's file doesn't have that key in the same
location.

Pick one canonical schema and migrate. The init scaffold should produce
exactly the schema the slash commands expect.

## Acceptance Criteria

- [ ] #1 Decide canonical filename: `.ai-sdlc/pipeline.yaml` (preferred — shorter, matches adopter expectation) or `.ai-sdlc/pipeline-backlog.yaml` (status quo for framework). Document the decision in the task's finalSummary
- [ ] #2 Reconcile schema: ensure `branching.pattern` (and any other slash-command-required keys) live at consistent paths in BOTH framework and adopter usage
- [ ] #3 Update JSON schema at `spec/schemas/pipeline.schema.json` to match canonical
- [ ] #4 Update `/ai-sdlc init` template to write the canonical schema
- [ ] #5 Migration: framework dev-repo's existing `.ai-sdlc/pipeline-backlog.yaml` migrated to canonical (or, if old name kept, adopter's `pipeline.yaml` migrated to `pipeline-backlog.yaml`). Whichever direction — write a one-shot migration helper for adopters who installed an earlier plugin version
- [ ] #6 All slash command bodies + pipeline-cli readers updated to read from canonical filename
- [ ] #7 Hermetic test: framework dev-repo execute still works post-migration; adopter fixture project init produces schema slash commands can read
- [ ] #8 Operator runbook documents the migration path for existing adopters
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Canonical filename decided + documented (.ai-sdlc/pipeline.yaml or pipeline-backlog.yaml)
- [ ] #2 Schema reconciled: branching.pattern + required keys at consistent paths
- [ ] #3 spec/schemas/pipeline.schema.json updated to match canonical
- [ ] #4 /ai-sdlc init template writes canonical schema
- [ ] #5 Migration helper for adopters on prior plugin version
- [ ] #6 All slash commands + pipeline-cli readers updated to canonical filename
- [ ] #7 Framework + adopter fixture both verified end-to-end
- [ ] #8 Adopter runbook documents migration
<!-- SECTION:ACCEPTANCE:END -->
