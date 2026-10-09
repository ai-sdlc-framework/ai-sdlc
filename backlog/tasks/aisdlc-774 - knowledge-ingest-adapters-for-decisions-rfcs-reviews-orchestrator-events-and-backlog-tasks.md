---
id: AISDLC-774
title: >-
  knowledge ingest adapters for decisions, RFCs, reviews, orchestrator events and backlog tasks
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-1
dependencies:
  - AISDLC-773
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/cli/index.ts
  - pipeline-cli/bin/cli-decisions.mjs
  - .ai-sdlc/reviews/
  - spec/rfcs/README.md
  - backlog/tasks/
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Project what ai-sdlc already structures into knowledge entries so the engine starts populated and stays current without double entry. Adapters: decision catalog events, RFC frontmatter plus Open Question resolutions, review logs under `.ai-sdlc/reviews/*.jsonl`, orchestrator events, and backlog tasks. Each source maps to an authority ceiling: repo artifacts on `main` become `specialist` with the proof set to the source id, and no adapter ever writes `canonical`. Re-ingest is idempotent by contentHash. The surface is `cli-context ingest --source <kind>`.

Sequencing: depends on the knowledge store task (AISDLC-773) in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `cli-context ingest --source decisions` writes one entry per decision record with authority `specialist` and the record id as proof (fixture test).
- [ ] `cli-context ingest --source rfc` writes entries from RFC frontmatter and Open Question resolutions (fixture test).
- [ ] `cli-context ingest --source reviews` writes entries from a review log fixture (fixture test).
- [ ] `cli-context ingest --source events` writes entries from an orchestrator events fixture (fixture test).
- [ ] `cli-context ingest --source tasks` writes entries from backlog task fixtures (fixture test).
- [ ] No adapter produces an entry with authority `canonical` (test over every adapter).
- [ ] Running ingest twice on the same fixture produces no new or changed files (idempotence test by contentHash).
- [ ] A changed source updates the entry and records a supersession (test).
