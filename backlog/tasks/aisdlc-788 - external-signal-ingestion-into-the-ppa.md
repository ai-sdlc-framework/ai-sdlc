---
id: AISDLC-788
title: >-
  external signal ingestion into the PPA
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-4
dependencies:
  - AISDLC-774
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - orchestrator/src/priority.ts
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ingest external signals into the priority score, as the RFC-0053 human surface and RFC-0008 describe. Define an adapter interface for support, CRM, analytics and roadmap exports that turns each signal into a knowledge entry with source and observed date, and feeds those entries into the PPA priority computation as inputs. Ship the interface and one fixture adapter that reads a CSV export; real adapters per source are follow-ups owned by adopters.

Sequencing: depends on AISDLC-774 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] An adapter interface is defined and documented, with a fixture CSV adapter implementing it (test).
- [ ] Each ingested signal becomes an entry with source, observed date and decay (test).
- [ ] The PPA priority computation accepts the entries as an input and a fixture signal changes the score in the expected direction (test).
- [ ] With no adapter configured the PPA output is unchanged (test).
