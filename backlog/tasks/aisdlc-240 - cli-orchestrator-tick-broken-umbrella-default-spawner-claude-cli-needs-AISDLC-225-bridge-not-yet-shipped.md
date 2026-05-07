---
id: AISDLC-240
title: >-
  cli-orchestrator tick broken — umbrella default spawner claude-cli needs
  AISDLC-225 bridge (not yet shipped)
status: To Do
assignee: []
created_date: '2026-05-07 22:55'
labels:
  - bug
  - regression
  - orchestrator
  - rfc-0015
  - framework-bug
  - dogfood
  - p0
dependencies: []
priority: high
references:
  - pipeline-cli/src/orchestrator/loop.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

After AISDLC-229 merged (PR #391), `cli-orchestrator tick` is broken: every dispatch fails with `developer-json-contract-violated` and empty raw output, regardless of whether `--max-concurrent` is 1 or 2.

Root cause: AISDLC-229 changed the orchestrator's dispatch path from the direct `ShellClaudePSpawner` (legacy `buildDefaultDispatch`) to the AISDLC-182 umbrella (`buildDefaultUmbrellaDispatch`), with `claude-cli` as the default spawner kind. The `claude-cli` spawner emits a manifest to `$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json` and expects a consumer-side bridge to read it and invoke the Agent tool. **That consumer bridge is AISDLC-225, which was not implemented** — only the helper module (`dispatch-result.ts`) shipped; the slash command body that consumes the manifest is non-functional (4 majors blocked PR #390, which is still draft/deferred).

So today's dispatch flow:

1. `cli-orchestrator tick` → `runExecuteCommand` umbrella (per AISDLC-229)
2. Umbrella uses `--spawner claude-cli`
3. `claude-cli` spawner emits manifest to `dispatch-manifest.json`
4. **No consumer reads the manifest** (AISDLC-225 gap)
5. Subprocess `completes` with empty stdout
6. Orchestrator's parser → `Unexpected end of JSON input` → `developer-json-contract-violated`
7. AISDLC-176 retry path fires → empty output again → same outcome

AISDLC-229's fallback to `--spawner api-key` is gated by `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`, but the operator has intentionally zeroed Anthropic API credits as a cost-discipline measure (see operator instruction 2026-05-07). So the fallback is unusable.

## Witnessed empirically 2026-05-07

After PR #393 (AISDLC-230) merged unblocking the queue:

```
$ cli-orchestrator tick --max-concurrent 2
dispatched: [AISDLC-178.7, AISDLC-202.2]
outcomes:
  - {taskId: AISDLC-178.7, outcome: developer-json-contract-violated, ...empty raw output...}
  - {taskId: AISDLC-202.2, outcome: developer-json-contract-violated, ...empty raw output...}

$ cli-orchestrator tick --max-concurrent 1
dispatched: [AISDLC-178.7]
outcome: developer-json-contract-violated, empty raw output

$ echo "..." | claude --print --output-format json --permission-mode bypassPermissions --agent developer
result: "agent works", cost $0.11
```

So `claude --print --agent developer` itself works in isolation. The breakage is specifically the orchestrator's tick → umbrella → claude-cli-spawner path.

## Fix shipped in this PR

`pipeline-cli/src/orchestrator/loop.ts` — the dispatch-adapter selection now defaults to the legacy `buildDefaultDispatch` path (which uses `ShellClaudePSpawner` directly, the same path that successfully drove AISDLC-178.5, 178.6, and 229 itself through the queue). The umbrella path becomes opt-in via `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1`.

When AISDLC-225's consumer bridge ships AND the operator wants the full Step 0-13 pipeline run by the umbrella subprocess (rather than by orchestrator's TS code calling `executePipeline` directly), they flip the env to opt in.

The behaviour change is **default-only**: tests that explicitly inject `adapters.umbrellaDispatch` or `adapters.dispatch` are unaffected. `buildDefaultUmbrellaDispatch` still exists; it's just no longer the default.

## Composes with

- **AISDLC-225** (claude-cli consumer bridge) — once that ships, operators can flip `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1` and the umbrella path works end-to-end. This task's revert is the bridge between "229 shipped" and "225 ships".
- **AISDLC-229** (orchestrator tick → umbrella wiring) — this task does NOT revert 229. It only makes the umbrella opt-in instead of default until 225 closes the loop.
- **AISDLC-239** (spawner diagnostics) — once 239 lands, future failures of this class are diagnosed with stderr + exit code instead of guessed.

## Acceptance Criteria

- [x] #1 `pipeline-cli/src/orchestrator/loop.ts` defaults the dispatch adapter to `buildDefaultDispatch` (legacy direct-spawner path) wrapped in the rich envelope when no test-injected adapter is present
- [x] #2 New env override `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1` opts INTO the umbrella path (`buildDefaultUmbrellaDispatch`)
- [x] #3 Source comment documents the regression rationale + the AISDLC-225 dependency
- [ ] #4 Regression test: with default env, dispatch runs via legacy path; with `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1`, dispatch runs via umbrella (verify by injecting recording adapters)
- [ ] #5 Manual verification: `cli-orchestrator tick --max-concurrent 1` against a real frontier task produces non-empty dev output (no `developer-json-contract-violated` empty-output failure)
- [ ] #6 No regression on existing 279+ unit tests in `pipeline-cli/src/orchestrator/loop*.test.ts`
- [ ] #7 Operator runbook updated at `docs/operations/orchestrator-runbook.md` documenting the new env + when to flip it (after AISDLC-225 ships)

## References

- `pipeline-cli/src/orchestrator/loop.ts` (the fix surface)
- `pipeline-cli/src/orchestrator/loop.umbrella.test.ts` (existing AISDLC-229 tests)
- AISDLC-225 (the unimplemented consumer bridge — blocks the umbrella path)
- AISDLC-229 (the wiring that exposed the regression)
- AISDLC-239 (spawner diagnostics — would have surfaced this earlier)
- Operator decision 2026-05-07: API credits intentionally unfunded (subscription-only)
- Witnessed: `cli-orchestrator tick --max-concurrent 1` + `--max-concurrent 2` both fail with empty raw output for AISDLC-178.7 + AISDLC-202.2
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 loop.ts defaults dispatch to legacy buildDefaultDispatch when no test adapter present
- [x] #2 AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1 opts INTO the umbrella path
- [x] #3 Source comment documents the regression + AISDLC-225 dependency
- [ ] #4 Regression test verifies default-vs-opt-in behaviour
- [ ] #5 Manual verification: real cli-orchestrator tick produces non-empty dev output
- [ ] #6 No regression on existing 279+ orchestrator unit tests
- [ ] #7 Operator runbook updated with the new env + when to flip
<!-- SECTION:ACCEPTANCE:END -->
