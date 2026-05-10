---
id: AISDLC-245.1
title: 'Phase 1: Publish + bundle @ai-sdlc/pipeline-cli as plugin npm runtime dep'
status: To Do
assignee: []
created_date: '2026-05-08 12:10'
labels:
  - adoption
  - plugin
  - phase-1
parentTaskId: AISDLC-245
dependencies: []
priority: high
references:
  - pipeline-cli/package.json
  - ai-sdlc-plugin/package.json
  - .github/workflows/release.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem
The plugin invokes `node pipeline-cli/bin/cli-*.mjs` which only resolves in the
framework monorepo. Adopters need these bins reachable via
`node_modules/.bin/cli-*`.

## Acceptance Criteria

- [ ] #1 `pipeline-cli/package.json` declares `bin` entries for every CLI the slash command bodies invoke (cli-classify-pr, cli-deps, cli-incremental-decide, ai-sdlc-pipeline, cli-orchestrator, cli-task-complete — verify against current `ai-sdlc-plugin/commands/*.md` invocations)
- [ ] #2 `pipeline-cli/package.json` carries `publishConfig.access: public` per CLAUDE.md release rules; `pnpm lint:publishable` passes
- [ ] #3 `release-please-config.json` tracks pipeline-cli for version bumps
- [ ] #4 First publish lands on npmjs.org as `@ai-sdlc/pipeline-cli@X.Y.Z`
- [ ] #5 `ai-sdlc-plugin/package.json` adds `dependencies: { "@ai-sdlc/pipeline-cli": "^X.Y.Z" }` pinned to the published version
- [ ] #6 Adopter `npm install` of the plugin pulls pipeline-cli; `node_modules/.bin/cli-classify-pr --version` resolves
- [ ] #7 Hermetic test: spin up an empty fixture project, install plugin via local link, verify all bins resolve from node_modules
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 pipeline-cli package.json declares bin entries for every CLI the slash commands invoke
- [ ] #2 publishConfig.access:public; pnpm lint:publishable passes
- [ ] #3 release-please-config.json tracks pipeline-cli
- [ ] #4 Published as @ai-sdlc/pipeline-cli@X.Y.Z on npmjs.org
- [ ] #5 ai-sdlc-plugin/package.json pinned dep on @ai-sdlc/pipeline-cli
- [ ] #6 Adopter npm install pulls pipeline-cli; bins resolve from node_modules/.bin
- [ ] #7 Hermetic test on fixture project verifies bin resolution
<!-- SECTION:ACCEPTANCE:END -->
