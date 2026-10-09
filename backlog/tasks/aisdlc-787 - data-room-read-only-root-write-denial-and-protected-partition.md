---
id: AISDLC-787
title: >-
  data-room read-only root, write denial and protected partition
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-4
dependencies:
  - AISDLC-773
  - AISDLC-775
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/subagent-start.js
  - pipeline-cli/src/cli/index.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the RFC-0053 OQ-7 resolution. `knowledge.dataRoomRoot` configures an optional raw root, possibly a sibling repository, indexed read-only at `scope: protected` with authority from document kind (signed documents canonical at 0.95, decks and plans 0.7 to 0.85). The PreToolUse hook denies writes under that root unless the active task's `permittedExternalPaths` names it. Facts taken from a document are captured as `protected` entries in the protected root with a citation to the source. One index spans both roots, partitioned by scope, and the protected partition is excluded from any export or sharing path by scope alone.

Sequencing: depends on AISDLC-773, AISDLC-775 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `knowledge.dataRoomRoot` is read from `.ai-sdlc/context.yaml` and is unset by default (test).
- [ ] Documents under the root are indexed read-only at `scope: protected` with authority by document kind (test per kind).
- [ ] A write under the root is denied by the PreToolUse hook unless the active task's `permittedExternalPaths` names it, and allowed when it does (hook test both ways).
- [ ] A captured fact is written as a `protected` entry in the protected root with a citation to the source document (test).
- [ ] An export or sharing path excludes the protected partition by scope (test).
- [ ] The index never writes to the data-room root (test).
