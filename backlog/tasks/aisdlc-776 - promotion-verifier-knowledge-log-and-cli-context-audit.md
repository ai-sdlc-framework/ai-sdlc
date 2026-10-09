---
id: AISDLC-776
title: >-
  promotion verifier, knowledge log and cli-context audit
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
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the write-authority rules from RFC-0053 OQ-3. Agents write at `inferred` only. A framework verifier (code, not a model) may promote an entry to `specialist` by re-running an attached proof from a closed vocabulary declared in the ontology: a test id that passes from the committed tree, a decision record id present on `main`, a path present in the tracked tree, or a command from an allowlisted set whose output matches. Arbitrary commands are not in the vocabulary. `canonical` requires a human. Promotion, supersession and refutation are events in a knowledge log. `cli-context promote --proof` runs the verifier, `cli-context audit` lists every promotion with its proof, and re-observation moves confidence 30 percent toward the new value without changing authority.

Sequencing: depends on the knowledge store task (AISDLC-773) in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A proof kind outside the closed vocabulary is refused by `cli-context promote` and the entry stays `inferred` (test).
- [ ] A test-id proof that names a test which fails or does not exist does not promote the entry (test with a forged id).
- [ ] A decision-id proof promotes only when the record is present on `main` (test).
- [ ] A path proof promotes only when the path is present in the tracked tree (test).
- [ ] A command proof promotes only for a command in the allowlist whose output matches (test).
- [ ] Promotion to `canonical` is refused when requested by an agent role (test).
- [ ] Promotion, supersession and refutation append events to the knowledge log; `cli-context audit` lists each promotion with its proof (test).
- [ ] Re-observation moves confidence 30 percent toward the new value and leaves authority unchanged (test).
