---
id: AISDLC-1279
title: '`ai-sdlc health` reports an invalid or missing config instead of printing `Config: valid`'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - orchestrator
  - adopter
  - bug
dependencies: []
references:
  - orchestrator/src/orchestrator.ts
  - orchestrator/src/orchestrator.test.ts
  - orchestrator/src/validate-config.ts
  - orchestrator/src/config.ts
  - orchestrator/src/cli/commands/health.ts
  - orchestrator/src/cli/commands/validate.ts
  - docs/operations/init.md
priority: medium
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2678). Verified by the planner in source at main 1ffab4a1: `health()` sets `configValid = true` unless `loadConfig` throws, and `loadConfig` turns a missing folder, a YAML parse error and a schema failure into warnings. The operator ordered the filing on 2026-11-16.'
---

## Description

**Gap (issue #2678).** `ai-sdlc health` prints `Config:      valid` and exits 0 in three states where `ai-sdlc validate` reports INVALID and exits 1:

- a file in `.ai-sdlc/` is not parseable YAML;
- a resource file fails schema validation;
- there is no `.ai-sdlc/` folder.

`Orchestrator.health()` (`orchestrator/src/orchestrator.ts`, about line 295) sets `configValid = true` unless `loadConfig` throws. `loadConfig` (`orchestrator/src/config.ts`) returns `{}` for a missing folder and records parse and schema failures as warnings, on purpose, so that one bad file does not stop the rest of the config from loading. `health()` never reads those warnings.

`ai-sdlc init` ends with "Run 'ai-sdlc health' to verify your configuration." and `docs/operations/init.md` describes health as the command that validates config files, so an adopter with a broken file is told it is fine.

**Shape.** `health()` uses the per-file validation that `ai-sdlc validate` already uses (`validateConfigFiles` in `orchestrator/src/validate-config.ts`). The tolerant behaviour of `loadConfig` does not change.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does health need to judge config validity at all? Yes: init and the init guide send the adopter to it for exactly that. 2. Deleted: the assumption that "the loader did not throw" means valid. 3. Simplified or optimised: reuse `validateConfigFiles`; no second validator. 4. Accelerated: n/a. 5. Automated: tests for the three states and for a fresh scaffold.

- `health()` calls `validateConfigFiles(configDir)`. For each result with `valid: false` it sets `configValid` to false and adds one entry to `errors` naming the file and the messages.
- A missing config folder is reported the same way: `configValid` false and an error saying the config directory was not found. The command exits non-zero, as `ai-sdlc validate` does for the same state (planner decision; the reporter left the exit code open).
- `loadConfig` is not changed and still does not throw on these states.
- `orchestrator/src/cli/commands/health.ts` already exits 1 when `errors` is not empty; keep that, and make sure the text output shows the file names.

## Acceptance Criteria

- [ ] #1 With `.ai-sdlc/pipeline.yaml` holding unparseable YAML, `ai-sdlc health` does not print `Config:      valid`, names that file, and exits non-zero; a test covers it.
- [ ] #2 With a resource file that `ai-sdlc validate` reports INVALID for a schema violation, `ai-sdlc health` does not print `Config:      valid`, names that file, and exits non-zero; a test covers it.
- [ ] #3 With no config directory, `ai-sdlc health` does not print `Config:      valid`, says the config directory was not found, and exits non-zero; a test covers it.
- [ ] #4 On an unmodified `ai-sdlc init` scaffold, `ai-sdlc health` prints `Config:      valid` and exits 0; a test covers it.
- [ ] #5 `loadConfig` behaviour is unchanged: its existing tests pass unchanged.
- [ ] #6 The PR body carries `Closes #2678`.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
