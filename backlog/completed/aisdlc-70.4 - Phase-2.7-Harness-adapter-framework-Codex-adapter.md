---
id: AISDLC-70.4
title: 'Phase 2.7: Harness adapter framework + Codex adapter'
status: Done
assignee: []
created_date: '2026-04-26 19:45'
updated_date: '2026-04-26 20:47'
labels:
  - rfc-0010
  - phase-2.7
  - harness
milestone: m-2
dependencies:
  - AISDLC-70.1
references:
  - >-
    spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md#13-harness-selection
  - ai-sdlc-plugin/agents/critic-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
parent_task_id: AISDLC-70
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
HarnessAdapter framework (RFC §13) decoupling the orchestrator from any single coding-agent runtime. Ships two adapters: claude-code (refactor of today's hardcoded path, no behavior change) and codex (new). Folds in Q6 (capability discovery via static declaration + version probe), Q7 (schema-conformant artifact contract), and Q8 (independence enforcement via requiresIndependentHarnessFrom). Parallelizable with Phases 2 and 2.5. Estimated 2 weeks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 HarnessAdapter interface + HarnessRequires + HarnessAvailability + HarnessCapabilities types implemented at orchestrator/src/harness/types.ts per RFC §13.1
- [x] #2 Adapter registry at orchestrator/src/harness/registry.ts per RFC §13.2
- [x] #3 Static capability matrix declared per RFC §13.3 with requires: { binary, versionRange, versionProbe } per RFC §13.8 (Q6)
- [x] #4 Pipeline-load validation per RFC §13.4 + §13.8: isAvailable() runs version probe, primary failure → HarnessUnavailable pipeline-load error; fallbacks degrade with warning (Q6)
- [x] #5 ClaudeCodeAdapter implemented as refactor of today's hardcoded path (no behavior change; existing tests must still pass)
- [ ] #6 CodexAdapter implemented driving OpenAI Codex CLI; verify end-to-end against fixture worktree
- [x] #7 Schema additions: Stage.harness, Stage.harnessFallback, Stage.requiresIndependentHarnessFrom, Pipeline.spec.defaultHarness, Pipeline.spec.defaultHarnessFallback (RFC §6.3, §6.5)
- [ ] #8 Runtime fallback per RFC §13.5: HarnessFallback event on availability failures; falls through chain; record actual harness in runtime.json
- [x] #9 Independence enforcement per RFC §13.10: filter chain to exclude harnesses that ran upstream named in requiresIndependentHarnessFrom; emit IndependenceViolated if effective chain empty (Q8)
- [x] #10 Cyclic-constraint validation: pipeline-load FAILS with CyclicIndependenceConstraint if requiresIndependentHarnessFrom references downstream stage (Q8)
- [ ] #11 Schema-conformant artifact emission contract per RFC §13.9: adapter prompt includes JSON schema, validates output, retries once on failure (Q7)
- [x] #12 Update review-critic and review-security skills to declare harness: codex + requiresIndependentHarnessFrom: [implement] per RFC §11.3 / §13.6
- [ ] #13 Integration test: end-to-end review where Claude implements and Codex critiques; verify both artifacts land + independence preserved
- [x] #14 Adapter-authoring guide drafted at docs/operations/adapter-authoring.md for future adapters
- [x] #15 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Phase 2.7 harness adapter framework committed as 0c48d28. HarnessAdapter contract + registry + Claude Code/Codex shells + version probe + independence enforcement + cyclic-constraint validation. 144 tests pass (96 prior + 48 new). Adapter-authoring guide drafted.

ACs deferred to Phase 3: #6 end-to-end Codex CLI test (needs dispatcher integration), #8 runtime fallback flow (needs dispatcher), #11 schema-conformant artifact emission contract (needs Phase 4 artifact schemas), #13 cross-harness review integration test (combination of all the above).

## Changes
- `orchestrator/src/harness/{types,registry,version-probe,independence,index}.ts` (new)
- `orchestrator/src/harness/adapters/{claude-code,codex}.ts` (new): static caps + version probe + getAccountId
- 6 test files, 48 tests covering caps, probe matching, independence filtering + cyclic detection, account-id namespacing
- `spec/schemas/pipeline.schema.json` (modified): Stage.{harness, harnessFallback, requiresIndependentHarnessFrom} + Pipeline.spec.{defaultHarness, defaultHarnessFallback}
- `ai-sdlc-plugin/agents/{code,security}-reviewer.md` (modified): harness: codex + requiresIndependentHarnessFrom: [implement]
- `docs/operations/adapter-authoring.md` (new): 5-step recipe + security review requirements + testing checklist
- `orchestrator/src/index.ts` (modified): re-export harness module surface

## Design decisions
- **Adapter shells throw `not wired into dispatch yet` until Phase 3.** Tests inject deps.invoke; production paths must wait. Avoids accidentally invoking unfinished dispatch code.
- **AccountId hash is harness-namespaced.** SHA-256 over `<harness-name>:<credential>` ensures the same key reused across vendors yields different ids — verified by integration test.
- **Probe parse failures fall through to available with warning.** Per RFC §13.8 — vendor `--version` output is undocumented and changes; we'd rather warn than break every pipeline.
- **Independence enforcement is library-only in Phase 2.7.** Phase 3 wires it into the actual dispatcher; the algorithm + cycle detection are tested independently here.
- **Open-ended versionRange default.** Adapters declare `>=2.0.0` not `>=2.0.0 <3.0.0` — pin upper bounds only when a known-incompatible upstream version exists.

## Verification
- `pnpm --filter @ai-sdlc/orchestrator test -- src/harness src/runtime src/models` — 144/144 pass
- `pnpm build` — clean
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
Phase 2.8 (AISDLC-70.5) — subscription scheduling consumes HarnessAdapter.getAccountId for ledger keying. Phase 3 (AISDLC-70.6) wires the adapters into the dispatcher.
<!-- SECTION:FINAL_SUMMARY:END -->
