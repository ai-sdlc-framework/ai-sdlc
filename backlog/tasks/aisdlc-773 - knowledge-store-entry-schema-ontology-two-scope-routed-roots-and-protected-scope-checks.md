---
id: AISDLC-773
title: >-
  knowledge store: entry schema, ontology, two scope-routed roots and protected-scope checks
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/cli/index.ts
  - .gitignore
  - scripts/check-backlog-ascii.sh
  - orchestrator/src/embedding/index.ts
priority: high
dispatchable: true
blocked:
  reason: "RFC-0053 OQ-4 to OQ-8 open; phase 1 depends only on OQ-1 to OQ-3, resolved 2026-10-09 by operator rubric"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build the RFC-0053 knowledge layer foundation, as resolved by OQ-1 and OQ-3. An entry has the fields value, confidence, authority, scope, source, observed, decay, relations, supersedes and contentHash. Entries with scope `internal` or `universal` live under the tracked root `.ai-sdlc/knowledge/<trunk>/<topic>.md`. Entries with scope `protected` live under the gitignored root `.ai-sdlc/knowledge-protected/` (or a path set by `knowledge.protectedRoot` in `.ai-sdlc/context.yaml`) and never enter the repository or a PR body. An ontology file declares the trunks, entry types, allowed relations and the closed proof-kind vocabulary used later for promotion. `cli-context validate` checks entries and the ontology. A CI check refuses a `protected` entry in the tracked root, the pre-push chain refuses a PR body that cites a protected entry, and a classification heuristic (source path under a data-room root, client identifiers) flags likely mis-scoped entries. Follow the shape of `scripts/check-backlog-ascii.sh` for the check script.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `cli-context validate` rejects an entry with a missing required field, an out-of-range confidence, an unknown relation type or an unknown trunk (test per case).
- [ ] `cli-context validate` rejects an agent-written entry whose authority is above `inferred` or whose confidence exceeds 0.85 (test).
- [ ] The ontology file declares trunks, entry types, relations and the closed proof-kind vocabulary; validation fails when an entry uses an undeclared value (test).
- [ ] A CI check script fails when a `protected` entry sits in the tracked root and passes otherwise (hermetic test).
- [ ] A pre-push check fails when a PR body cites a protected entry id and passes for a body that does not (hermetic test).
- [ ] The classification heuristic flags an entry whose source path is under a configured data-room root or that contains a configured client identifier (test).
- [ ] `.gitignore` ignores `.ai-sdlc/knowledge-protected/` and a test asserts the entry is present.
- [ ] `.ai-sdlc/context.yaml` keys `knowledge.trackedRoot` and `knowledge.protectedRoot` are read with the stated defaults (test).
- [ ] A docs page under `docs/` describes the schema, the two roots and the scope rule.
