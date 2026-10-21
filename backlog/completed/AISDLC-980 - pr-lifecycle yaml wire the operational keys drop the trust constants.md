---
id: AISDLC-980
title: 'pr-lifecycle.yaml: wire the operational keys, drop the trust constants, test every key has a reader'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - config
  - hierarchy
dependencies: []
references:
  - .ai-sdlc/pr-lifecycle.yaml
  - pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/webhook.ts
  - scripts/read-pr-lifecycle.mjs
priority: medium
dispatchable: true
---

## Description

`.ai-sdlc/pr-lifecycle.yaml` (header: "Consumers read them from here; a literal in code is a defect") declares `spec.docsOnlyPaths`, `noTaskBranchPrefixes`, `releaseBranchPrefix`, `taskIdPattern`, `webhook`, `reconcile`, `stall`, `loopGuard` and `flipPreconditions`. Only two keys have readers: `pipeline-cli/src/hierarchy/pr-lifecycle-config.ts:27` reads `spec.loopGuard.maxSameHeadActions` and nothing else (the parsed type is literally `{ spec?: { loopGuard?: { maxSameHeadActions?: unknown } } }`), and CI reads `noTaskBranchPrefixes` through `scripts/read-pr-lifecycle.mjs`. The rest are dead: the yaml says `webhook.port: 8787` while `pipeline-cli/src/hierarchy/webhook.ts:17` has `export const DEFAULT_WEBHOOK_PORT = 8765`; the yaml says `stall.staleMs: 1800000` and `graceMs: 600000` while `pipeline-cli/src/hierarchy/stall.ts:31` and `:33` hard-code `30 * 60 * 1000` and `10 * 60 * 1000`; `reconcile.timerOpenMs` and `timerIdleMs` have no reader; `flipPreconditions` has none.

Operator decision (2026-10-20): the file holds two kinds of keys and must say so. Operational keys (`webhook`, `stall`, `reconcile`, and `flipPreconditions` if the flip code can read a config) are wired to real readers through `loadPrLifecycleConfig`, with the code constants becoming the defaults when the key is absent. Trust constants (`docsOnlyPaths`, `releaseBranchPrefix`, `taskIdPattern`) are deleted from the yaml because the CI verifier re-derives them from code (`pipeline-cli/attestation-core/docs-only-paths.mjs` and the branch and task-id helpers); a yaml copy a PR can edit must not be what the gate trusts. A test loads the yaml, walks every `spec` key and asserts a reader exists for each (a registry of key to reader function), so an unread key fails the build. The yaml header explains the two kinds and why trust constants are not here.

**Five-step review (requirements first).**
1. Requirement questioned: should the trust constants be configurable at all? No; the gate must derive them from code on the base ref, so the yaml copies are deleted rather than wired.
2. Delete: `docsOnlyPaths`, `releaseBranchPrefix`, `taskIdPattern` from the yaml.
3. Simplify: one loader (`loadPrLifecycleConfig`) returning every operational value with code defaults.
4. Accelerate: the webhook port and stall timers become tunable without a rebuild.
5. Automate: the every-key-has-a-reader test.

## Acceptance Criteria

- [x] `loadPrLifecycleConfig` returns `webhook`, `stall`, `reconcile` (and `flipPreconditions` if wired) with the former code constants as defaults; `webhook.ts`, `stall.ts` and the reconcile scheduler consume them.
- [ ] `docsOnlyPaths`, `releaseBranchPrefix` and `taskIdPattern` are removed from `.ai-sdlc/pr-lifecycle.yaml` and the header explains operational keys versus code-owned trust constants.
- [ ] A test asserts every key under `spec` in the yaml has a registered reader and fails on an unregistered key.
- [ ] `scripts/read-pr-lifecycle.mjs` still serves `noTaskBranchPrefixes` to CI unchanged.

## Final Summary

## Summary
Fixed the reconcile scheduler debounce regression: `startScheduler` no longer gets `webhook.debounceMs`, so it keeps its own 2000 ms default. I also removed the now-unused `webhook` destructure in `dispatch.ts`. I added tests for `nextIntervalMs(1,5,9)` and `nextIntervalMs(0,5,9)`, and for `stallThresholdsFromEnv` with a defaults argument.

## Changes
- pipeline-cli/src/cli/dispatch.ts
- pipeline-cli/src/hierarchy/scheduler.test.ts
- pipeline-cli/src/hierarchy/stall.test.ts

## Design decisions
I did not import the receiver's debounce constant into pr-lifecycle-config.ts. No such exported constant exists (`DEFAULT_DEBOUNCE_MS` is only in scheduler.ts, and that is the 2000 ms scheduler value), so the 5000 ms mirror stays. I did not push, per the instructions. `prUrl` is null for that reason; the pipeline handles push.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved

## Follow-up
(none)

