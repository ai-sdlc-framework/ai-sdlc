---
id: AISDLC-1191
title: 'Usage ingest runs at most once at a time and is spaced out'
status: In Progress
assignee: []
created_date: '2026-11-05'
labels:
  - usage
  - hierarchy
  - performance
  - fix
dependencies: []
references:
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/usage/launch.ts
  - pipeline-cli/src/usage/ingest-claude.ts
  - ai-sdlc-plugin/hooks/usage-ingest.js
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator in the planner session, 2026-11-05: the executor cap sat at 0 (limited by load headroom) while PRs waited to land. Load average was 14 to 23 on a 12-core machine.

**Today.** Every dispatch tick starts `cli-usage ingest --max-seconds 25` detached (`cli/hierarchy.ts`, the `usageIngest` dependency, AISDLC-1122). The tick launch has no debounce and no single-instance guard. The Stop hook (`ai-sdlc-plugin/hooks/usage-ingest.js`) debounces with a 20-second stamp file, but the tick ignores that stamp. On 2026-11-05 a sample showed one ingester at 90% CPU past 32 seconds while a second one had already started. The ingester ran almost without pause, costing close to one full core. The transcript store it scans is about 13,000 files, 6.9 GB.

The load headroom (`hierarchy/executor-cap.ts`, cores minus the 1-minute load average) counts this cost, so the ingester directly reduces how many executors can run.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the budget pacer needs a ledger that is minutes fresh, not seconds fresh; a launch every tick is more than the requirement. 2. Deleted: the unguarded per-tick launch. 3. Simplified: one shared launcher with one stamp and one lock for both the tick and the Stop hook. 4. Accelerated: no second ingester ever waits on or duplicates the first. 5. Automated: tests below.

1. **One instance.** The ingester takes an exclusive lock file in the usage directory at start (`O_EXCL`, with the pid; a lock whose pid is dead or older than twice `--max-seconds` is stale and taken over). A second ingester that finds a live lock exits 0 at once.
2. **Spacing.** The tick launches through `usage/launch.ts` and honours the same stamp file as the Stop hook, with a minimum interval of 5 minutes for both, configurable by `AI_SDLC_USAGE_INGEST_INTERVAL_MS`. The budget status reads the ledger as it is; it never forces an ingest.
3. **Hard stop.** The ingester honours `--max-seconds` as a wall-clock limit checked between files, saving cursors before it exits, so a run cannot exceed it by more than one file.
4. **Docs.** `docs/operations/cli-hierarchy.md` states how often usage is ingested and how to change it.

## Acceptance Criteria

- [ ] AC-1: Two ingesters started together: one runs, the other exits 0 without reading files. Tested.
- [ ] AC-2: A stale lock (dead pid or too old) is taken over. Tested.
- [ ] AC-3: A tick within the interval of the last launch (from tick or hook) does not spawn; one after it does. Tested with an injected clock.
- [ ] AC-4: The interval comes from `AI_SDLC_USAGE_INGEST_INTERVAL_MS` when set. Tested.
- [ ] AC-5: A run stops within one file of `--max-seconds` and its cursors are saved. Tested.
- [ ] AC-6: Docs updated.
