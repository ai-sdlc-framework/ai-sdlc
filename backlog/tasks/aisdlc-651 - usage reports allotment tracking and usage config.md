---
id: AISDLC-651
title: >-
  RFC-0050 Part A: cli-usage report, window/task/context views, weighted units, snapshots, allotment change detection
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - cli
  - subscription
  - adopter
dependencies:
  - AISDLC-649
  - AISDLC-642
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/cli/cost-report.ts
  - orchestrator/src/scheduling/ledger.ts
  - orchestrator/src/scheduling/tier-analysis.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Turns the ledger into the reports the operator asked for: usage per model, where the
allotment is going, how much is left, and whether what the plan provides has changed.
RFC-0050 sections A4 and A5.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Files under `.ai-sdlc/` are never written by the developer agent
The governance hook refuses every agent `Write`/`Edit` under `.ai-sdlc/**`, and policy
is read from the base branch only. Templates are shipped from
`orchestrator/src/cli/commands/init-templates.ts` (the map that already carries
`framework-bug-report.md`), not as files under `.ai-sdlc/templates/`. Any change to
this repository's own `.ai-sdlc/*.yaml` is an operator step, listed separately below,
and is never an acceptance criterion the developer must satisfy.

## Scope
1. **Usage config:** `spec/schemas/usage-config.v1.schema.json` for kind `UsageConfig`:
   plan name, monthly price, windows (name and length), unit weights per token class
   and per model family, and the allotment-change tolerance. Loaded from
   `.ai-sdlc/usage-config.yaml` on the base ref, with a machine-level file in the usage
   directory taking precedence when present. Register with AJV and regenerate the
   generated schemas. Defaults apply with no file. Ship a commented init template through the template map in `orchestrator/src/cli/commands/init-templates.ts` (keyed `.ai-sdlc/templates/usage-config.yaml`); the developer agent never writes under `.ai-sdlc/` directly.
2. **Weighted units:** `unitsForCall(record, weights)`. Default weights are derived
   from the current rows of the price history (ratios between token classes and
   between models), so they follow the price feed; explicit weights in the usage
   config override them.
   Every report that shows units states that the weights are a proxy.
3. **`cli-usage report`** with `--group-by` any of `model`, `role`, `task`, `repo`,
   `pool`, `day`, `window` (repeatable), `--since`, `--until`, `--scope`, and `--format`
   `text`, `json` or `csv`. Columns: calls, input, cache write (5-minute and 1-hour),
   cache read, output, units, API-equivalent cost. A model with no price row shows
   `unpriced` in the cost column and is excluded from cost totals, which are labelled
   as partial when that happens.
4. **Fixed views:** `cli-usage window` (units used in the current session and weekly
   windows, implied allotment, projected time to the limit at the trailing rate),
   `cli-usage task <id>` (tokens and units for one task split by role), and
   `cli-usage context` (per session: tokens in the first call, number of turns, total
   cache read; sorted by total).
5. **Snapshots:** `cli-usage snapshot --window <name> --used-pct <n>` appends a
   calibration point to `snapshots.jsonl` with the units consumed in that window at
   that moment. Window observations already captured in `limit-events.jsonl` are used
   as snapshots too.
6. **Implied allotment and change detection:** for each snapshot, units divided by the
   fraction used. `cli-usage allotment` prints the series per window. When two
   consecutive snapshots of the same window differ by more than the tolerance while
   their model mix is similar, emit `AllotmentChangeSuspected` and mark the row. Add
   that event and `UsageLimitObserved` to the event type union and the events schema.
7. **`cli-cost-report`:** accept the usage ledger as an input source and prefer it;
   the existing inputs keep working.
8. **Capability:** register `usage.ingest` in the capability registry from AISDLC-642
   and report `live` on a successful ingest and `degraded` with a reason otherwise.
   Add a doctor line showing the time of the last successful ingest. Any new capability id must also be
   added to `KNOWN_CAPABILITY_IDS` in `scripts/check-rfc-docs.mjs`, or the RFC linter
   fails on the `runtimeEvidence` entry that later names it.

## Acceptance Criteria
- [ ] `cli-usage report --group-by model` over a synthetic ledger prints one row per model with each token class in its own column, and the JSON and CSV outputs carry the same numbers.
- [ ] Grouping by `role`, `task`, `pool`, `day` and `window`, alone and combined, produces totals that each sum to the ungrouped total.
- [ ] An unpriced model shows `unpriced`, is left out of the cost total, and the total is labelled partial.
- [ ] `cli-usage window` reports units in the current session window and the weekly window from a ledger with a known distribution, and the projection matches a hand calculation.
- [ ] `cli-usage context` lists sessions with first-call tokens and turn counts and contains no path for `other`-scope sessions.
- [ ] `cli-usage snapshot` appends a calibration point, and `cli-usage allotment` prints implied allotment for it equal to units divided by the fraction used.
- [ ] Two snapshots whose implied allotments differ beyond the tolerance with a similar model mix emit `AllotmentChangeSuspected`; two within tolerance do not.
- [ ] The config schema is registered, `generated-schemas.ts` is regenerated and committed, and running with no config file uses the documented defaults.
- [ ] `cli-cost-report` produces a unified view from the usage ledger alone.
- [ ] `usage.ingest` appears in the capability state as `live` after a successful ingest and `degraded` after a failed one, and is listed in `KNOWN_CAPABILITY_IDS`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
