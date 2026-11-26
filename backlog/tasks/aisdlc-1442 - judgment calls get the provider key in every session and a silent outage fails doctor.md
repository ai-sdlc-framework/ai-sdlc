---
id: AISDLC-1442
title: "The judgment provider finds its key in the repo .env, and capability liveness runs on the live dispatch path"
status: To Do
priority: high
labels:
  - judgment
  - rfc-0049
  - capability-liveness
dependencies: []
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/jev-provider.ts
  - reference/src/judgment/types.ts
  - reference/src/capabilities/state.ts
  - pipeline-cli/src/orchestrator/capability-liveness.ts
  - pipeline-cli/src/cli/orchestrator.ts
  - pipeline-cli/src/hierarchy
  - orchestrator/src/cli/commands/doctor-checks.ts
  - .ai-sdlc/capabilities.yaml
  - docs/operations/judgment-promotion.md
  - docs/operations/doctor.md
---

## Description

**Five-step review (requirements first).**
1. Question: the operator put `TYPESAFE_API_KEY` in the git-ignored repo-root `.env` and expected the RFC-0049 judgment layer to run. Nothing loads `.env` into a process (the only reader, `ai-sdlc-plugin/hooks/session-start.js:354`, lints its format); `jev-provider.ts:66` reads `process.env.TYPESAFE_API_KEY` at call time, so a process has the key only if its launching shell exported it. The judgment log shows the last real provider call at 2026-11-21T20:34:26Z (`review.routing`, abstain/shadow, 105 ms); on 2026-11-26, 203 of 265 records are abstain/`disabled` and the 62 `act` records are all config decisions (`review.reviewer-set.selection`, mode `off`, `decidedBy: config:...`). Nobody was told for five days because RFC-0049 section 9 capability liveness never runs on the live path: `runCapabilityLiveness` is wired only into `pipeline-cli/src/cli/orchestrator.ts` (the retired Conductor tick, AISDLC-763), not the hierarchy dispatch loop; `.ai-sdlc/artifacts/_capabilities/state.json` tracks only `hierarchy.board` and `routing.table`, none of the 8 `required` capabilities in `.ai-sdlc/capabilities.yaml` has ever been observed, and no `capability:` Decision exists in the catalog. The doctor check (`doctor-checks.ts:2648`) should fail on never-observed; what it prints today is unchecked and is verified first by this task.
2. Delete: nothing. (Operator exporting the key by hand was considered and rejected: it breaks silently on the next machine.)
3. Simplify: the key is resolved in one place, the provider. `jev-provider.ts` reads its own `requires.envVar` (`TYPESAFE_API_KEY`, `types.ts:55`) from `process.env`, and only when unset falls back to that one variable in the repo-root `.env` (project root resolved the way the judgment runtime already resolves `.ai-sdlc/`). No general dotenv loading, no other variable read, nothing exported into `process.env` for children, and the key never goes on a command line. This covers hooks, CLIs and the dispatch tick alike, not just hierarchy-launched sessions. Operator decision 2026-11-26 (planner rubric review of this draft).
4. Accelerate: none.
5. Automate: capability liveness runs on the hierarchy dispatch tick, so the next outage surfaces within a tick, not when someone reads the log.

## Acceptance Criteria
- [ ] #1 `jev-provider` resolves its key from `process.env[requires.envVar]`, else from that single key in `<projectRoot>/.env`; an exported value wins. Test: a fixture `.env` with `TYPESAFE_API_KEY` and an unrelated variable → the provider gets the key, `process.env` is unchanged afterwards, the unrelated variable is never read into any object. A missing or unreadable `.env` yields today's `disabled` abstain, no throw. The `.env` read is cached per process.
- [ ] #2 The key value never appears in logs, judgment-log records, error messages or thrown errors (test asserts the fixture value is absent from captured output and from the judgment log written during the test).
- [ ] #3 Root cause recorded first: the PR body states what `doctor`'s `checkCapabilityLiveness` reports on this repo today and why no `capability:` Decision was ever filed, with the command output.
- [ ] #4 `runCapabilityLiveness` runs on the hierarchy dispatch tick (the loop the host session runs), at most once per tick, never blocking; it files the one-per-UTC-day Decision RFC-0049 section 9.3 requires for each degraded or never-observed required capability. Test: a fixture with a required capability absent from `state.json` files one Decision per day and no duplicate while one is open. If wiring it reveals that the 8 required capabilities have no emitter writing `state.json` at all, the PR says so and the missing emitters are named in the PR body (follow-up filed by the planner, not this task).
- [ ] #5 `cli-hierarchy status` prints one line `judgment: live (last provider call <age>)` or `judgment: DOWN since <timestamp> (<reason>)`, computed from the judgment log, where a provider call is a record with `latencyMs > 0`, `cacheHit` false, and an outcome reason other than `disabled` or `provider-error`. Config-decided records (`decidedBy: config:*`) never count as live (test with a fixture log holding only config `act` records → DOWN).
- [ ] #6 `docs/operations/judgment-promotion.md` (or the runbook it links) states where the key is read from (exported env, else repo-root `.env`, that variable only) and how to check the layer is live (`cli-hierarchy status` line).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
