---
id: AISDLC-70.7
title: 'Phase 4: Artifacts + observability'
status: Done
assignee: []
created_date: '2026-04-26 19:46'
updated_date: '2026-04-26 21:10'
labels:
  - rfc-0010
  - phase-4
  - observability
  - artifacts
milestone: m-2
dependencies:
  - AISDLC-70.6
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#16-artifact-directory-convention
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#17-observability-requirements
  - spec/schemas/artifacts/
parent_task_id: AISDLC-70
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Artifact directory schema (RFC §16) with dual .md + .json per artifact (Q7), heartbeat writer, observability surfaces (cli-status, _events.jsonl). Estimated 1 week.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Artifact directory layout per RFC §16.1 implemented; each artifact-producing stage writes both .md (narrative) and .json (schema-conformant)
- [x] #2 JSON schemas at spec/schemas/artifacts/{plan, implementation, validation, review, pr}.schema.json per RFC §16.4 with $schema versioning (Q7)
- [ ] #3 Existing review outputs migrated to dual format; downstream stages updated to consume .json
- [x] #4 Heartbeat writer per RFC §16.2: state.json updated every 60s; stale > 5 min surfaces in cli-status
- [x] #5 cli-status --all view summarizing all active branches per RFC §17 observability
- [x] #6 _events.jsonl event stream emitter for Slack integration per RFC §17 observability requirements
- [x] #7 cli-classifier-feedback audit trail integrated with calibration log
- [ ] #8 Resumability per RFC §16.3: orchestrator resumes interrupted runs from state.json
- [x] #9 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Phase 4 artifacts + observability shipped as 8bc950e. 5 JSON schemas (plan/implementation/validation/review/pr), StateWriter with heartbeat + stale detection, _events.jsonl emitter, atomic JSON writes, listActiveStates, cli-status command. 11 new tests. ACs deferred: #3 migration of existing review outputs and #8 resumability execution — both require Phase 3's full execute.ts conversion to land first.
<!-- SECTION:FINAL_SUMMARY:END -->
