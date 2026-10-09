---
id: AISDLC-777
title: >-
  ported capture and hygiene commands for the context engine
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-1
dependencies:
  - AISDLC-773
  - AISDLC-776
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - ai-sdlc-plugin/commands/cleanup.md
  - ai-sdlc-plugin/commands/detect-patterns.md
  - ai-sdlc-plugin/commands/model-pins.test.mjs
  - pipeline-cli/bin/cli-decisions.mjs
priority: high
dispatchable: true
blocked:
  reason: "RFC-0053 OQ-4 to OQ-8 open; phase 1 depends only on OQ-1 to OQ-3, resolved 2026-10-09 by operator rubric"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the plugin commands `/ai-sdlc context-capture` and `/ai-sdlc context-hygiene`, adapted from the mechanics of the data-room kit's capture-knowledge and knowledge-hygiene skills (confidence bands, supersede on correction, a contradiction raised as a Decision Catalog item, at most 3 contradictions per run, a monthly audit). Both write only at `inferred`. The command files follow the shape of `ai-sdlc-plugin/commands/cleanup.md` and `ai-sdlc-plugin/commands/detect-patterns.md`, and the model pin follows the repository rules (sonnet) enforced by `ai-sdlc-plugin/commands/model-pins.test.mjs`. Contradictions are filed with `node pipeline-cli/bin/cli-decisions.mjs add`.

Sequencing: depends on the knowledge store task (AISDLC-773) and the promotion verifier task (AISDLC-776) in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `ai-sdlc-plugin/commands/context-capture.md` and `context-hygiene.md` exist with frontmatter matching the house shape and a sonnet model pin (model-pins test passes).
- [ ] Capture writes entries only at authority `inferred` with a `reverify:` note and a confidence band (test).
- [ ] A correction supersedes the earlier entry instead of deleting it (test).
- [ ] Hygiene raises a detected contradiction through `cli-decisions add` and raises at most 3 per run (test).
- [ ] Hygiene reports stale entries (freshness below 0.3) as questions, not facts (test).
- [ ] Hygiene never changes authority and never deletes an entry (test).
