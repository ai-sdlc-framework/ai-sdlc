# `decisions-config.yaml` — adopter reference

The Decision Catalog (RFC-0035) reads per-organization configuration from
`<project-root>/.ai-sdlc/decisions-config.yaml`. Every field is optional;
missing values fall back to the RFC-0035 §7 / §15.1 defaults.

This page is the **adopter-facing schema reference** for that file
(AISDLC-291 AC#6). It documents the schema, defaults, and how each block
composes with the framework.

## Quick reference

```yaml
# .ai-sdlc/decisions-config.yaml — every field optional

# RFC-0029 pillar-owner mapping (Stage B actor-routing rubric).
pillarOwners:
  engineering: alice@example.com
  product:     bob@example.com
  design:      carol@example.com
  operator:    alice@example.com         # cross-pillar fallback

# Notification surfaces fired when a Decision is resolved.
notification:
  tui:
    enabled: true                        # default true
  slack:
    enabled: false                       # default false
    webhookUrl: ""                       # required when enabled
  email:
    enabled: false                       # default false
    recipients: []                       # required when enabled

# OQ-14 audit digest mode for auto-decisions.
auditDigest:
  mode: overridden-only                  # overridden-only (default) | all | anomalous

# OQ-3 — auto-applied recommendations stay overridable for this window.
overrideWindowHours: 24                  # default 24

# §5.3 — Stage C LLM auto-apply confidence threshold.
stageCConfidenceThreshold: 0.7           # default 0.7

# §7.1 — capacity model composing with RFC-0016 t-shirt sizes (OQ-6).
capacity:
  xs: { perDay: 30, estMinutes: 2 }
  s:  { perDay: 15, estMinutes: 5 }
  m:  { perDay: 6,  estMinutes: 10 }
  l:  { perDay: 2,  estMinutes: 20 }
  xl: { perDay: 1,  estMinutes: 30 }
  loadBearingFormula: log-blocked-count  # log-blocked-count (default) | linear

# §7.2 — fatigue signal. Explicit declaration is the default (OQ-8);
# inferred fatigue is opt-in.
fatigue:
  inferFromBehavior: false               # default false (OQ-8 explicit-only)
  overrideRateThreshold: 0.5             # default 0.5 (50%)
  throughputDropThreshold: 0.4           # default 0.4 (60% drop)
  measurementWindowHours: 1              # default 1.0
```

## Field reference

### `pillarOwners` — RFC-0029 actor-routing rubric

Maps each pillar to the email/login of its owner. The Stage B routing
rubric uses these to route Engineering / Product / Design / cross-pillar
decisions. The `operator` slot is the cross-pillar fallback (multi-pillar
decisions per §6.2).

AC#4 contract: the rubric only ever surfaces actors that appear in this
map. It does NOT auto-fill missing entries.

### `notification.*`

Drives per-surface notification on Decision resolution (AC#6 of AISDLC-292).
The `tui` surface is enabled by default because it's free (no external IO);
`slack` and `email` are off by default because they require operator wiring
(webhook URL or SMTP relay).

### `auditDigest.mode` — OQ-14

Controls which auto-decisions land in the operator's periodic digest:

- `overridden-only` (default) — only auto-decisions the operator later
  overrode. The actionable signal in the smallest payload.
- `all` — every auto-decision. Appropriate for compliance-heavy orgs.
- `anomalous` — only auto-decisions whose chosen option diverged from the
  rubric's expected output. Requires calibration data to be meaningful.

### `overrideWindowHours` — OQ-3 / §5.3

How many hours after a reversible auto-decision lands the operator has to
override it. After the window the decision is "settled" — override still
possible but requires explicit re-decision. Default `24`.

### `stageCConfidenceThreshold` — §5.3

Per-org Stage C LLM auto-apply threshold. Stage C auto-applies a
recommendation when:
1. The LLM's self-reported confidence ≥ this value, AND
2. The decision is reversible (`Decision.spec.reversible: true`).

Default `0.7`. Independent of the global classifier substrate threshold
(`capture-config.yaml: classifier.confidenceThreshold`) so operators can
tune Decision Catalog caution separately from capture-triage caution.

### `capacity.*` — RFC-0035 §7.1 (Phase 7 / AISDLC-291)

Per-day decision budgets, keyed by RFC-0016 t-shirt size buckets. OQ-6
chose to compose with RFC-0016 rather than invent a parallel sizing
taxonomy, so a Decision tagged `m` consumes the same `m` slot the
RFC-0016 calibration loop tunes.

Defaults from §7.1:

| Tier | perDay | estMinutes |
|------|--------|------------|
| `xs` | 30     | 2          |
| `s`  | 15     | 5          |
| `m`  | 6      | 10         |
| `l`  | 2      | 20         |
| `xl` | 1      | 30         |

Override any subset; unspecified tiers retain defaults. When an actor's
budget is full for a tier, new decisions of that tier are **deferred to
the next day** (§7.1).

#### `capacity.loadBearingFormula` — OQ-2 selector

- `log-blocked-count` (default) — `loadBearing = max(taskPriority(t)) +
  log(blockedTaskCount)`. Diminishing returns means blocking 100 tasks
  isn't 10× more load-bearing than blocking 10.
- `linear` — naive `taskCount × tier-weight`. Choose only when your dep
  graph is shallow enough that diminishing returns aren't appropriate.

### `fatigue.*` — RFC-0035 §7.2 (Phase 7 / AISDLC-291)

The fatigue signal switches the framework into **mechanical-only mode**:
m/l/xl decisions defer to tomorrow, only small + reversible + LLM-eligible
decisions auto-decide, and walkthrough-style multi-question prompts are
suppressed.

OQ-8 chose **explicit operator declaration as the default contract** —
the operator's manual signal is always honored, inferred fatigue (from
override rate / throughput drop) is opt-in.

#### `fatigue.inferFromBehavior`

Default `false`. When `true`, the framework ALSO trips fatigue when:

- The operator override rate exceeds `overrideRateThreshold` over
  `measurementWindowHours`, OR
- Decision throughput drops below `throughputDropThreshold` of the
  rolling baseline.

Even with `inferFromBehavior: true`, the explicit signal (operator-set via
`cli-decisions fatigue set`) always overrides — inferred is purely an
*additional* trigger.

#### Explicit fatigue CLI surface

```bash
# Set explicit operator fatigue with an optional reason.
node pipeline-cli/bin/cli-decisions.mjs fatigue set --reason "long walkthrough day"

# Show current fatigue status (explicit + inferred when opted in).
node pipeline-cli/bin/cli-decisions.mjs fatigue status

# Clear explicit fatigue (audit fields are preserved).
node pipeline-cli/bin/cli-decisions.mjs fatigue clear
```

The explicit state lives at `<project-root>/.ai-sdlc/operator-state.yaml`:

```yaml
fatigueActive: true
fatigueDeclaredAt: 2026-05-24T19:42:00Z
fatigueReason: "long walkthrough day"
```

Per the [decisions-degrade-gracefully convention][1] and §15.1 Design
Pattern 7, **fatigue never halts the pipeline** — auto-defaults still
fire under fatigue, and the operator catches up retroactively via the
24h override window (Phase 5).

### `overrideWindowHours` and the §7.2 mechanical-only policy

Under fatigue, the per-decision dispatch disposition is computed by
`dispatchUnderFatigue()` in `pipeline-cli/src/decisions/fatigue.ts`:

| Tier | Reversible + LLM-eligible | Blocking-critical | Disposition       |
|------|---------------------------|-------------------|-------------------|
| any  | -                         | yes (xs/s only)   | `surface-blocking`|
| xs/s | yes                       | no                | `auto-decide`     |
| m/l/xl | -                       | -                 | `defer`           |
| other | -                        | -                 | `dispatch`        |

The TUI decisions-pending pane consults this disposition and routes the
surface accordingly. The orchestrator tick honors `defer` by skipping
admission of deferred decisions until the next day.

## Composition with other framework modules

- **RFC-0016 calibration loop** — the same `tShirtSize` field powers both
  the estimation rubric and the Decision Catalog capacity tier (OQ-6
  resolution: compose, don't duplicate).
- **RFC-0014 dep graph** — the load-bearing scorer reads
  `maxBlockedTaskPriority` from the shipped `cli-deps frontier` output.
- **RFC-0015 events.jsonl** — the Decision Catalog event log lives at
  `.ai-sdlc/_decisions/events.jsonl` (sibling to the orchestrator events
  substrate; see §15.1 Design Pattern 1).
- **RFC-0023 operator TUI** — the decisions-pending pane reads the same
  projected Decision view this CLI exposes via `cli-decisions list`.

## Feature flag

The Decision Catalog is **default-ON** since AISDLC-392 (2026-05-22). To
opt out:

```bash
AI_SDLC_DECISION_CATALOG=off node pipeline-cli/bin/cli-decisions.mjs list
```

The fatigue commands work regardless of the catalog flag — they manage
session state (operator-state.yaml), not Decision records.

[1]: ../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
