---
id: AISDLC-1304
title: 'Python SDK has the cost and token metrics and telemetry keys of the reference'
status: In Progress
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-parity
dependencies: []
references:
  - reference/src/metrics/types.ts
  - reference/src/telemetry/semantic-conventions.ts
  - sdk-python/src/ai_sdlc/metrics/types.py
  - sdk-python/src/ai_sdlc/telemetry/semantic_conventions.py
priority: low
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: file the three mechanical SDK parity tasks of the survey. The survey counted: the Python SDK has 22 of the 27 standard metrics and 34 of the 46 telemetry keys of the TypeScript reference. Every change here is an addition.'
---

## Description

**Gap.** The standard metric list of the reference (`reference/src/metrics/types.ts`, lines 209 to 233) has 27 entries; `sdk-python/src/ai_sdlc/metrics/types.py` has 22. Missing: `total-cost-usd`, `total-input-tokens`, `total-output-tokens`, `cost-per-run`, `tokens-per-run`. The telemetry key list of the reference (`reference/src/telemetry/semantic-conventions.ts`) has 46 keys; `sdk-python/src/ai_sdlc/telemetry/semantic_conventions.py` has 34. Missing: the `ai_sdlc.cost.*` and `ai_sdlc.tokens.*` keys, `ai_sdlc.model`, the run id key and the complexity band key. A Python agent cannot report cost or tokens under the names the dashboards and the reference use.

**Shape.** The Python SDK defines every standard metric and every telemetry key that the reference defines, with the same string values.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: does the Python SDK need these names? Yes: its role is the agent runner, and cost and tokens are reported by agent runs. 2. Deleted: nothing; no existing Python name is renamed or removed. 3. Simplified or optimised: constants only; no new computation, store or exporter. 4. Accelerated: not applicable. 5. Automated: a Python test lists the names of the reference and asserts each is defined.

- **Metrics.** Add the five missing standard metrics to `sdk-python/src/ai_sdlc/metrics/types.py` with the name, unit and description of the reference.
- **Telemetry.** Add the twelve missing keys to `sdk-python/src/ai_sdlc/telemetry/semantic_conventions.py` with the string values of the reference, and export them where the existing keys are exported.
- **Tests.** One Python test asserts that the set of standard metric names equals the 27 names of the reference; one asserts that the set of telemetry key values contains the 46 values of the reference. The expected names are written out in the test, with the reference file named in a comment.
- **Stop rule.** If a name that exists in Python has a different string value from the reference, do not rename it; list it in the PR body.

Out of scope: the Go SDK (its names differ and a rename breaks its public API; an operator decision); computing cost; the usage module.

## Acceptance Criteria

- [ ] #1 The Python standard metric names equal the 27 names of `reference/src/metrics/types.ts`, and a test asserts the full set.
- [ ] #2 The Python telemetry keys include all 46 key values of `reference/src/telemetry/semantic-conventions.ts`, and a test asserts it.
- [ ] #3 No existing Python metric name or telemetry key changed its value or was removed.
- [ ] #4 The PR body lists any existing Python name whose value differs from the reference, or states that there is none.
- [ ] #5 The Python suite passes, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
