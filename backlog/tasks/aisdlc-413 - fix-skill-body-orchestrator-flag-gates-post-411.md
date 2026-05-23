---
id: AISDLC-413
title: 'fix(plugin): update orchestrator-tick + dispatch-worker skill-body env gates to match AISDLC-411 default-ON polarity'
status: In Progress
labels: [plugin, rfc-0015, post-411, operator-merge]
references:
  - ai-sdlc-plugin/commands/dispatch-worker.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - pipeline-cli/src/orchestrator/feature-flag.ts
priority: high
permittedExternalPaths: []
---

## Description

AISDLC-411 (PR #644, 2026-05-23) flipped `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` to default-ON via the TypeScript `isOrchestratorEnabled()` parser. The promotion missed two shell-script Step 1 gates embedded directly in plugin skill bodies:

- `ai-sdlc-plugin/commands/dispatch-worker.md` line 81: `if [ -z "$AI_SDLC_AUTONOMOUS_ORCHESTRATOR" ]; then exit 1; fi`
- `ai-sdlc-plugin/commands/orchestrator-tick.md` line 137: same pattern

These gates still require the env var to be SET, contradicting the new default-ON convention. Operators who try `/ai-sdlc:dispatch-worker` or `/ai-sdlc:orchestrator-tick` post-cutover see "ERROR: AI_SDLC_AUTONOMOUS_ORCHESTRATOR is not set" even though the parser would say "enabled" for an unset env.

Symptom (observed 2026-05-23 immediately after AISDLC-411 merge): the operator's worker session refused to start with the stale message; manifest AISDLC-412 queued but no Worker could claim it.

## Acceptance criteria

- [x] AC-1: Update both skill-body Step 1 gates to mirror the FALSY-set opt-out polarity (off / 0 / false / no, case-insensitive). Default-ON when env is unset.
- [x] AC-2: Updated error message names the new semantic ("explicitly disabled" + "default-ON since AISDLC-411").
- [ ] AC-3: Hermetic test (deferred — skill bodies are markdown executed inline by Claude Code; no test framework hooks them. The TypeScript parser already has 5-case-group coverage from AISDLC-411).
- [x] AC-4: Operator unblock path: `unset AI_SDLC_AUTONOMOUS_ORCHESTRATOR && /ai-sdlc:dispatch-worker` works post-merge.

## Out of scope

- Restructuring the skill bodies to invoke `isOrchestratorEnabled()` via the CLI (cleaner but bigger change; the shell-case approach is minimal-diff + matches the parser's semantic exactly).
- Sweeping other skill bodies for similar env-gate patterns (none found in `/ai-sdlc execute`, etc — those don't gate on this flag).

## Estimated effort

15-30 min.
