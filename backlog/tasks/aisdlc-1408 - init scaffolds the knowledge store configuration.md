---
id: AISDLC-1408
title: 'Init scaffolds the knowledge store configuration'
status: In Progress
assignee: []
created_date: '2026-11-24'
labels:
  - adopter
  - knowledge
  - pipeline-cli
dependencies:
  - AISDLC-1407
references:
  - pipeline-cli/src/config-manifest/manifest.ts
  - pipeline-cli/src/knowledge/config.ts
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - docs/operations/knowledge-store.md
priority: medium
---

## Description

**Five-step review (requirements first).** Does an adopter need a `context.yaml` at all? The engine runs on built-in defaults when the file is absent (`loadKnowledgeConfig`, `loadRetrievalConfig`), so the file is not required to run. What is required is that an adopter can see that the knowledge store exists and where its keys go: an adopter (arcana-website, 2026-11-24) built a second "company memory" partly because nothing in a fresh install shows the RFC-0053 store. Keep it minimal: one optional file with the defaults written out, no new behaviour.

**Gap.** The manifest entry list (`manifest.ts`, about lines 262-303) has `review-policy`, `agent-role`, `pipeline` and `workflow` only. No init path writes `.ai-sdlc/context.yaml` or the `.ai-sdlc/knowledge/` folder. Reads return nothing for a missing folder; writes create folders on the fly.

## Fix

- Add an optional manifest entry for `.ai-sdlc/context.yaml` that writes the current default keys with a one-line comment each. A re-run adds the file only when absent and never rewrites an existing one.
- Create `.ai-sdlc/knowledge/` with a short README naming the tracked root, the protected root and `cli-context`. Do not write a starter ontology: the built-in one applies when `ontology.yaml` is absent.
- The written defaults must equal the code defaults; a test compares them so they cannot drift.
- `docs/operations/knowledge-store.md`: one paragraph on what init creates.

## Acceptance Criteria

- [ ] #1 Test: init on an empty project writes `.ai-sdlc/context.yaml` and `.ai-sdlc/knowledge/README.md`; a re-run leaves an edited `context.yaml` unchanged.
- [ ] #2 Test: loading the scaffolded `context.yaml` yields the same config as loading with no file.
- [ ] #3 `docs/operations/knowledge-store.md` describes the scaffold.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
