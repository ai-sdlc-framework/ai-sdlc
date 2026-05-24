---
id: AISDLC-330
title: 'feat: RFC-0036 Phase 5 — DoR Gate at import time (strict default; analyze auto-resolve)'
status: Done
assignee: []
created_date: '2026-05-16'
updated_date: '2026-05-24'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-5
dependencies:
  - AISDLC-329
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0036 §13. Wires DoR Gate (RFC-0011) into the import path with strict default + analyze-metadata-aware auto-resolution.

## Scope (OQ-3 + OQ-7 + OQ-10)

- DoR Gate runs at import time (strict default per OQ-3).
- `--rubric warn` opt-out flag for adopters who explicitly want warnings instead of refuse.
- **Analyze-metadata auto-resolution (OQ-7):** when `.specify/analyze.json` is present, each DoR gate decision auto-resolves via the catalog if analyze covered it. Only NEW gaps reach the operator.
- **OQ-10 rejection routing:** failed DoR → `Decision: import-blocked-on-dor` → emit clarification task back to spec-kit project (refuse import; do not create a stub task in the backlog).
- Failure surfacing with structured upstream-clarification hints (so adopter can fix in spec-kit + re-import).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 DoR Gate runs at import time; strict default
- [x] #2 `--rubric warn` opt-out flag respected
- [x] #3 Analyze metadata at `.specify/analyze.json` auto-resolves matching DoR gates via catalog
- [x] #4 Falls back to full DoR rubric when analyze metadata absent
- [x] #5 Failed DoR refuses import (no stub task in backlog); emits upstream clarification task
- [x] #6 Structured clarification hints in the emitted upstream task (which gates failed + why)
- [x] #7 Composes with RFC-0035 Stage A/B/C for Decision routing
<!-- AC:END -->

## Final Summary

### Summary

Phase 5 of RFC-0036 §13 wires the RFC-0011 DoR Gate into the `cli-import-spec` flow. Every generated spec-kit task is rendered to a temp file under `<workDir>/.ai-sdlc/import-spec-tmp/`, run through `refineBacklogTask()`, and admitted / refused based on the per-org `dorStrictness` config (strict default per OQ-3, `--rubric warn` opt-out). Failing tasks under strict mode REFUSE import (no stub task lands in the backlog, per OQ-10) and emit a clarification task back to spec-kit with structured per-gate hints. `.specify/analyze.json` metadata auto-resolves matching DoR gates via the Decision Catalog per OQ-7 — each covered finding gets a `decision-opened` + `operator-answered` pair (rationale: "Auto-resolved by RFC-0036 OQ-7") so only NEW gaps reach the operator.

### Changes

- `pipeline-cli/src/import-spec/dor-at-import.ts` (new): full Phase-5 wiring — temp-file rendering, analyze-metadata reader, `classifyAnalyzeCoverage`, auto-resolution Decision emitter, `emitImportBlocked` (refuse-strict path), `runDorAtImport` entry point.
- `pipeline-cli/src/import-spec/dor-at-import.test.ts` (new): 22 tests across helper-level + entry-point + importSpec-e2e behaviours.
- `pipeline-cli/src/import-spec/import.ts` (modified): orchestrator now awaits `runDorAtImport()` per upstream entry, surfaces `perTaskDor` + `refusedTasks` + `strictness` on `ImportOutcome.imported`. `importSpec()` is now async.
- `pipeline-cli/src/import-spec/import.test.ts` (modified): callers updated to `await importSpec()` + inject `evaluateDor: admitStub()` so Phase-4 read-parse-write assertions stay decoupled from the seven-gate rubric.
- `pipeline-cli/src/cli/import-spec.ts` (modified): `--rubric strict|warn` flag added (per OQ-3); `--analyze-metadata` override (per OQ-7); awaits the now-async `importSpec()`; renderer surfaces warnings + refusals + auto-resolved counts.
- `pipeline-cli/src/cli/import-spec.test.ts` (modified): renderer tests cover the new outcome shape (warnings, refusals, analyze auto-resolved count).
- `pipeline-cli/src/import-spec/index.ts` (modified): re-exports the new `dor-at-import` module.

### Design decisions

- **Temp-file rendering before DoR**: generated task content is written to `<workDir>/.ai-sdlc/import-spec-tmp/` and removed in a `finally` block. Lets `refineBacklogTask()` work unchanged via its existing `taskFilePathOverride` knob; ensures no stub task lands in `backlog/tasks/` on refused imports (OQ-10).
- **Analyze.json shape kept tight**: v1 supports `coveredGates: GateId[]` + `coveredQuestionHashes: string[]` + `rationale?`. Future expansion (verbatim `coveredQuestions` array, per-gate question-text matching) is trivial; tighter v1 surface matches the OQ-6 convention ("single documented BYO translator pattern + spec-kit first-party adapter only").
- **No inline OQ resolution**: all 12 RFC-0036 OQs were resolved at the 2026-05-16 operator walkthrough; this task implements them. The CLAUDE.md prohibition on developer subagents adding `**Resolution:**` markers was not invoked.
- **Auto-resolve emits BOTH `decision-opened` and `operator-answered`**: AC#7 (catalog composition) is satisfied by recording the analyze coverage as a real Decision pair so the audit trail is complete. Decision summary `Spec-kit import (auto-resolved by analyze): T-NNN gate <id>` makes the auto-resolve visible without contaminating the operator's triage queue (already `lifecycle: 'answered'` at projection time).

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 4815 passed (74 in `import-spec/*` + `cli/import-spec.test.ts`)
- `pnpm test` (full workspace) — exit 0
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- Phase 6 (AISDLC-331): `--reconcile` for drift handling per OQ-2.
- AISDLC-298 prohibition: no inline OQ resolution required for this task; all OQs were operator-resolved 2026-05-16.
