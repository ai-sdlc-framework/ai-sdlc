# Tutorial 10: Spec-Kit Bridge — Author Specs Upstream, Ship with AI-SDLC

> See [RFC-0036](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) for the normative spec and [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) for the three-tier authoring model.

AI-SDLC is the **contract-to-shipped** half of a spec-driven development stack. The recommended front-of-funnel companion is [GitHub Spec Kit](https://github.com/github/spec-kit) — a mature, 30+ AI-tool-integration toolkit that takes an idea through `/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks`. AI-SDLC's `cli-import-spec` (also available as `/ai-sdlc import-spec` inside Claude Code) translates the resulting `tasks.md` into backlog tasks that pass the DoR Gate, dispatch through the autonomous orchestrator, and merge with attestations.

This tutorial walks the full loop end-to-end: install spec-kit, author a feature spec, import to ai-sdlc, dispatch, and ship.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Install spec-kit](#step-1--install-spec-kit)
3. [Step 2 — Author a feature spec upstream](#step-2--author-a-feature-spec-upstream)
4. [Step 3 — Import into the AI-SDLC backlog](#step-3--import-into-the-ai-sdlc-backlog)
5. [Step 4 — DoR Gate at import time](#step-4--dor-gate-at-import-time)
6. [Step 5 — The upstream-clarification feedback loop](#step-5--the-upstream-clarification-feedback-loop)
7. [Step 6 — Dispatch and ship](#step-6--dispatch-and-ship)
8. [Step 7 — Handling spec drift after import](#step-7--handling-spec-drift-after-import)
9. [Configuration reference (`.ai-sdlc/adopter-authoring.yaml`)](#configuration-reference-ai-sdlcadopter-authoringyaml)
10. [Troubleshooting](#troubleshooting)
11. [Why these defaults? — design rationale and RFC-0036 OQ resolutions](#why-these-defaults--design-rationale-and-rfc-0036-oq-resolutions)
12. [Further reading](#further-reading)

---

## 1. Prerequisites

- AI-SDLC installed (`npm install -g @ai-sdlc/orchestrator`) — see [Getting Started](../getting-started/README.md).
- A repo initialised with `ai-sdlc init` (gives you `backlog/`, `.ai-sdlc/`, and the plugin scaffolding).
- The [GitHub Spec Kit](https://github.com/github/spec-kit) CLI installed (instructions in step 1 below).
- Node.js ≥ 20 and a working `claude` (Claude Code) install if you want to use the `/ai-sdlc import-spec` slash-command surface alongside the CLI.

This tutorial assumes you've read [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) and understand the three-tier authoring model (RFC → Spec → Task). The spec-kit bridge sits at the Spec → Task seam.

---

## Step 1 — Install spec-kit

Spec-kit ships as a Python CLI and as Claude Code slash commands. Follow the [upstream install instructions](https://github.com/github/spec-kit#installation); the quickest path is:

```bash
pipx install specify-cli
```

Then, inside your project repo, initialise spec-kit's directory layout:

```bash
specify init
```

This creates a `.specify/` directory at the repo root with `constitution.md` and (eventually) `specs/<feature>/` per feature you author.

> **Spec-kit is recommended, not required.** Any front-of-funnel tool (Linear, Notion, plain markdown) that produces a spec-kit-style `tasks.md` can feed `cli-import-spec`. The bridge's seam contract is the `tasks.md` format itself — bring your own translator, or use spec-kit's first-party output directly.

### Constitution vs CLAUDE.md

Spec-kit's `constitution.md` and AI-SDLC's `CLAUDE.md` cover overlapping ground (rebase-vs-merge policy, branch-naming convention, review cadence). **Keep them separate.** RFC-0036 OQ-8 resolved that each tool owns its constitution surface; the bridge's drift detector surfaces shared-norm-section divergence as a Decision in the catalog (never blocks). The pattern means the spec-kit project can evolve `constitution.md` on its own cadence and AI-SDLC continues to honour `CLAUDE.md` as the framework-norm source of truth.

---

## Step 2 — Author a feature spec upstream

Open Claude Code (or your spec-kit-integrated agent) inside the repo and run the canonical spec-kit flow against a real feature. Use `auth-feature` as the running example:

```text
/speckit.specify
  → "Add bearer-token validation to the public API.
     The validator should accept HS256 + RS256 tokens, return 401 on
     malformed or expired tokens, and return 200 on valid ones."

/speckit.clarify
  → walks through ambiguity (rotation? KMS keys? rate limits?)
  → updates spec.md with resolved clarifications

/speckit.plan
  → emits plan.md naming the implementation approach + contract surfaces

/speckit.tasks
  → emits tasks.md with one entry per binary-testable deliverable:
       T-001: Wire bearer-token validator at POST /auth/validate
       T-002: Reject malformed tokens with 401
       T-003: Reject expired tokens with 401
       ...

(optional) /speckit.analyze
  → cross-artifact consistency check; writes .specify/analyze.json
    with per-gate coverage metadata that AI-SDLC's DoR Gate can
    auto-consume (see Step 4).
```

Result on disk:

```
.specify/
├── constitution.md
├── analyze.json                         (optional, from /speckit.analyze)
└── specs/
    └── auth-feature/
        ├── spec.md
        ├── plan.md
        ├── tasks.md
        └── contracts/
            └── auth-api.yaml
```

The seam between spec-kit and AI-SDLC is the **`tasks.md`** file. Everything above the seam is spec-kit's concern; everything below is AI-SDLC's. The other artifacts (`spec.md`, `plan.md`, `contracts/`) are imported as context but the per-task admission decision rides on `tasks.md`.

---

## Step 3 — Import into the AI-SDLC backlog

Run the import command from your repo root:

```bash
node pipeline-cli/bin/cli-import-spec.mjs --from .specify/specs/auth-feature/
```

Equivalent slash-command form (inside Claude Code):

```text
/ai-sdlc import-spec --from .specify/specs/auth-feature/
```

Either form accepts the feature directory (containing `tasks.md`) or the `tasks.md` file directly. On a clean import you'll see:

```text
Imported 7 task(s) from .specify/specs/auth-feature/tasks.md (feature: auth-feature, rubric: strict)
  - AISDLC-512 (upstream T-001) → backlog/tasks/aisdlc-512 - wire-bearer-token-validator.md
  - AISDLC-513 (upstream T-002) → backlog/tasks/aisdlc-513 - reject-malformed-tokens-with-401.md
  - AISDLC-514 (upstream T-003) → backlog/tasks/aisdlc-514 - reject-expired-tokens-with-401.md
  ...
```

Each generated task carries a `specRef:` frontmatter block pointing back upstream:

```yaml
---
id: AISDLC-512
title: 'Wire bearer-token validator at POST /auth/validate'
status: To Do
specRef:
  source: spec-kit
  featureId: auth-feature
  taskId: T-001
  artifactPath: .specify/specs/auth-feature/tasks.md
  contractsPath: .specify/specs/auth-feature/contracts/auth-api.yaml
  importedAt: 2026-05-24T15:42:00Z
acceptanceCriteria:
  - 'POST /auth/validate returns 200 when token is well-formed and unexpired'
  - 'POST /auth/validate returns 401 when token is malformed'
  - 'POST /auth/validate returns 401 when token is expired'
---
```

The `specRef:` block is what powers later [reconcile / drift handling](#step-7--handling-spec-drift-after-import); the framework knows which upstream artifact produced this task and can re-evaluate it if upstream changes.

### Useful flags

| Flag | What it does |
|---|---|
| `--rubric strict\|warn` | Override DoR strictness at import (default: `strict` per OQ-3). |
| `--analyze-metadata <path>` | Override path to spec-kit `analyze.json` (default: `.specify/analyze.json`). |
| `--format json\|text` | JSON output for CI scripting; `text` is the human-readable default. |
| `--work-dir <path>` | Project root override (defaults to `process.cwd()`). |
| `--reconcile [--task <id>]` | Phase 6 drift handling — see [Step 7](#step-7--handling-spec-drift-after-import). |

---

## Step 4 — DoR Gate at import time

Every generated task runs through the [Definition of Ready Gate (RFC-0011)](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) **at import time, before landing in the backlog**. This is RFC-0036 OQ-3's resolution: strict by default, because the DoR rubric is the framework's quality contract — loosening it by default contradicts the contract.

Three outcomes per task:

### Outcome A — admitted (DoR passed)

The task lands in `backlog/tasks/` and is dispatchable. The autonomous orchestrator picks it up on the next tick (see [Step 6](#step-6--dispatch-and-ship)).

### Outcome B — admitted-with-warnings (DoR failed, `--rubric warn` opt-in)

The task lands in `backlog/tasks/` but the import output surfaces which gates failed:

```text
Admitted with warnings (1):
  - T-005: failing gates: G3 (named-thing references), G5 (affected surface)
```

Use `--rubric warn` only when you're explicitly running an exploratory import and want to see what spec-kit produced before tightening upstream. Production adopters should leave the default at `strict`.

### Outcome C — refused (DoR failed under strict mode)

Per RFC-0036 OQ-10, a failed-DoR task under strict mode **does NOT land** as a stub in the backlog (placeholders contaminate the dispatchable queue with non-dispatchable noise). Instead, the framework:

1. Opens `Decision: import-blocked-on-dor` in the Decision Catalog ([RFC-0035](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)) with per-gate failure rationale.
2. Emits a **clarification task back upstream** — a markdown file in the spec-kit project naming exactly which acceptance criteria need tightening, which named-things need resolution, etc.
3. The pipeline continues running on whatever else is dispatchable (G0 non-blocking contract).

You'll see something like:

```text
Refused (strict DoR, OQ-3 + OQ-10): 2 upstream task(s)
  - T-005: failing gates: G3 (named-thing references), G5 (affected surface)
      Decision: dec-0042
      Clarification task: .specify/specs/auth-feature/clarifications/T-005-needs-clarification.md
  - T-006: failing gates: G1 (binary-testable ACs)
      Decision: dec-0043
      Clarification task: .specify/specs/auth-feature/clarifications/T-006-needs-clarification.md
```

The operator's loop is: fix upstream → re-run `cli-import-spec --from <path>` → previously-refused tasks now pass and land.

### Analyze-metadata auto-resolution (OQ-7)

When `.specify/analyze.json` is present (produced by `/speckit.analyze`), each DoR gate that the analyze pass already covered **auto-resolves via the Decision Catalog** instead of prompting the operator. Only NEW gaps reach the operator. This is the OQ-7 resolution: DoR is the framework's quality contract (no skip), but spec-kit's upstream cross-artifact analysis composes cleanly via catalog-mediated trust-transitivity rather than being duplicated downstream.

The import output surfaces the auto-resolution count:

```text
Auto-resolved by analyze metadata: 5 decision(s) (OQ-7)
```

Each auto-resolved decision still produces a full `decision-opened` + `operator-answered` pair in the catalog log (rationale: "Auto-resolved by RFC-0036 OQ-7") so the audit trail is complete.

---

## Step 5 — The upstream-clarification feedback loop

The bridge is **a quality gate at the seam, not just a translator**. When DoR refuses a task at import, the clarification task it emits back upstream is the feedback signal that spec-driven tooling exists to create.

The pattern (per RFC-0036 §2.3):

```text
spec-kit author → tasks.md → cli-import-spec → DoR Gate
                                                  │
                                       ┌──────────┴──────────┐
                                       │                     │
                              admitted (lands)        refused (clarification
                                                       task back upstream)
                                                                │
                                                                ▼
                                               spec-kit author tightens spec.md / tasks.md
                                                                │
                                                                ▼
                                                  re-run cli-import-spec
                                                                │
                                                                ▼
                                                      admitted ✓
```

A clarification task looks like this (auto-generated by the bridge):

```markdown
# Clarification needed for T-005

## Source
- Upstream: `.specify/specs/auth-feature/tasks.md` entry T-005
- Triggered by: AI-SDLC DoR Gate refusal during `cli-import-spec` on 2026-05-24

## Failed gates

### G3 — Named-thing references unresolved
The task refers to `the token validator` without a file path or
module identifier. AI-SDLC's DoR Gate requires named things to
resolve to a specific surface so the autonomous orchestrator can
locate them.

**Suggested fix:** name the file (e.g. `src/auth/token-validator.ts`)
or the route (`POST /auth/validate`).

### G5 — Affected surface not declared
T-005 doesn't name a primary surface. Add a `Surface:` line under
the task entry in `tasks.md` or include a file path / module / route.

## Next step

Update `.specify/specs/auth-feature/tasks.md` entry T-005 and
re-run `cli-import-spec --from .specify/specs/auth-feature/`. The
Decision Catalog tracks this clarification at `dec-0042`.
```

The operator (or the spec-kit author) opens the file, sees exactly what to tighten, updates `tasks.md`, and re-imports. No silent admission of low-quality tasks, no manual hunt through DoR documentation — the gate explains itself at the point of failure.

> **Why this matters.** A common failure mode in autonomous AI dev systems is admitting underspecified work and watching agents wander. The strict DoR + upstream-clarification pattern shifts that work back to the highest-leverage point in the pipeline (the spec author), where the cost of fixing it is small. The cost asymmetry (`VISION.md` §2) is real: a 5-minute spec tightening saves hours of agent-loop divergence downstream.

---

## Step 6 — Dispatch and ship

Once the imported tasks are in `backlog/tasks/` (passing DoR), the rest of the AI-SDLC pipeline runs as usual:

```bash
# Pick a specific task and dispatch it
/ai-sdlc execute AISDLC-512

# Or, drive the autonomous loop and let the orchestrator drain the frontier
/ai-sdlc orchestrator-tick
```

The autonomous orchestrator's admission chain (RFC-0015) admits the imported tasks just like any other task. Each task carries its `specRef:` back-reference; the developer subagent can read `spec.md`, `plan.md`, and `contracts/auth-api.yaml` for context when implementing.

When the PR opens, the standard pipeline applies:

- Three reviewer subagents (code, test, security)
- DSSE attestation envelope signed locally
- `ai-sdlc/pr-ready` rollup check evaluated
- Auto-merge fires once the rollup is green

Nothing about the spec-kit-imported tasks short-circuits any quality gate downstream. The seam contract is the DoR Gate; everything past it is the framework's normal contract.

---

## Step 7 — Handling spec drift after import

Real-world specs change. The spec-kit author runs `/speckit.clarify` again, tightens an AC, adds a task, removes one. Meanwhile, some imported tasks are already In Progress. **What happens?**

Per RFC-0036 OQ-2, drift is **catalog-routed**, never auto-applied to in-progress tasks, never halts the pipeline.

Run reconcile to detect and route drift:

```bash
node pipeline-cli/bin/cli-import-spec.mjs --reconcile
```

Optionally narrow to a single imported task:

```bash
node pipeline-cli/bin/cli-import-spec.mjs --reconcile --task AISDLC-512
```

### Drift severity classifier

The Stage-A classifier (RFC-0035) maps each drift to a severity tier:

| Tier | Examples | Action |
|---|---|---|
| `no-change` | Bytes identical to dispatched version | No-op |
| `cosmetic` | Whitespace, formatting, typo fixes | **Auto-sync** — bridge applies the change to the task body and records an auto-resolved Decision in the catalog. No operator interrupt. |
| `semantic` | AC reworded, surface narrowed, behaviour clarified | **Defer 24h** — `Decision: spec-drift-detected` opens with a 24h operator-override window. **In-progress task continues against its dispatched version.** |
| `scope` | AC count changed, new AC added, AC removed | **Defer 24h** — same as semantic; the AC contract surface (DoR G1) shifted, operator decides whether the in-flight implementation still covers it. |
| `removed-upstream` | Upstream task no longer in `tasks.md` | Bridge marks the imported task `superseded` (never auto-deletes — per RFC §6.4). |

### Default-on-silence (24h)

Per RFC-0024 §15.1, deferred Decisions that aren't resolved within 24 hours **default to no-fork** (the in-progress task continues against the dispatched version). The operator can override during the window. This is the OQ-2 contract: rigor preserved (drift is an explicit Decision, not silent overwrite) + zero blocking (no real-time pipeline interrupt).

Example reconcile output:

```text
Reconciled 12 imported task(s) in /Users/me/my-repo
  - AISDLC-512 (upstream T-001): no-change → noop
  - AISDLC-513 (upstream T-002): cosmetic → auto-sync [dec-0044]
  - AISDLC-514 (upstream T-003): semantic → defer-24h [dec-0045]
  - AISDLC-515 (upstream T-004): scope → defer-24h [dec-0046]
  - AISDLC-516 (upstream T-005): removed-upstream → mark-superseded [dec-0047]
  - AISDLC-517 (upstream T-006): no-change → noop
  ...
```

Run reconcile on a cron or pre-tick hook to keep drift visible without manual prompts.

---

## Configuration reference (`.ai-sdlc/adopter-authoring.yaml`)

Per-org defaults for the bridge live in `.ai-sdlc/adopter-authoring.yaml`. Every key is optional and falls back to the §14.1 default; you only need to author the file if you want to override something.

```yaml
adopter-authoring:
  import:
    artifactGranularity: tasks-md-only        # OQ-1 — no fallback (only supported value)
    dorStrictness: strict                     # OQ-3 — strict | warn (default: strict)
    dorRejection: refuse-emit-clarification   # OQ-10 — refuse + emit upstream task

  drift-handling:
    severityThresholds:
      typoCosmetic: auto-sync                 # OQ-2 low tier — auto-sync | defer-24h-window
      semanticScope: defer-24h-window         # OQ-2 high tier — auto-sync | defer-24h-window

  speckit-bridge:
    analyzeMetadataPath: '.specify/analyze.json'
    schemaDetection: auto                     # OQ-11 — auto-detect; refuse unknown
    refuseOnUnknown: true                     # OQ-11 strict default

  cross-tool:
    firstPartyAdapters: [speckit]             # OQ-6 — speckit only in v1
    byoTranslatorPath: '.ai-sdlc/translators/<adopter>.ts'

  constitution-drift:
    detectionMode: shared-norm-sections       # OQ-8 — separate + drift detection
    rules:
      - rebase-vs-merge
      - branch-naming-convention
      - review-cadence
    driftAction: decision-batch               # surface as Decision; never block
```

CLI flags (`--rubric`, `--analyze-metadata`) override the per-org config for a single invocation. Per-org config overrides the §14.1 defaults.

---

## Troubleshooting

### `incomplete-spec-detected` — `tasks.md` missing

The bridge requires `tasks.md` (OQ-1: no fallback to `spec.md`). When it's absent, you'll see:

```text
incomplete-spec-detected (no tasks.md at .specify/specs/auth-feature/)
  Decision: dec-0050
  Clarification task: .specify/specs/auth-feature/clarifications/needs-speckit-tasks.md
```

**Fix:** run `/speckit.tasks` upstream to produce `tasks.md`, then re-import. The pipeline doesn't halt — other dispatchable work continues; this single feature is parked until the operator addresses the clarification.

### `upstream-schema-unknown` — spec-kit version mismatch

When the parser sees a `tasks.md` layout it doesn't recognise (OQ-11), it refuses the import and opens a Decision asking for parser support:

```text
upstream-schema-unknown (.specify/specs/auth-feature/tasks.md)
  Decision: dec-0051
  Clarification task: backlog/tasks/aisdlc-NNN - upgrade-import-spec-parser-for-spec-kit-vX.md
```

**Fix:** check the spec-kit version (`spec-kit --version`) and either pin to a supported version or wait for the framework to ship parser support. Auto-detect + Decision-routing handles the long tail of spec-kit version drift without forcing a framework release for every spec-kit minor version.

### DoR refusals after every import

If every import refuses every task, the spec-kit project is producing tasks too vague to clear DoR. Common culprits:

- ACs aren't binary-testable ("should be fast" instead of "returns under 200ms p95")
- Named things don't resolve ("the validator" instead of `src/auth/token-validator.ts`)
- No primary surface declared (no file path, route, or module identifier)

Run `/speckit.clarify` upstream and tighten the spec. The clarification tasks the bridge emits name exactly which gates failed — use them as a checklist when editing `spec.md`.

### `--reconcile` shows everything as `no-change` but I know upstream changed

The reconciler compares the imported task body (which captures the upstream state at import time) against the current `tasks.md`. If the imported task's body has been **manually edited** since import (e.g. you tightened an AC after import without re-running the bridge), the snapshot may still match the original upstream and miss the drift.

**Fix:** run `cli-import-spec --from <path>` once to refresh the imported snapshot, then `--reconcile` from there forward.

### My non-spec-kit upstream (Linear / Notion / plain markdown) can't feed the bridge

Per OQ-6, v1 ships a first-party adapter for spec-kit only. Other upstreams need a translator that emits a spec-kit-compatible `tasks.md`. Write the translator under `.ai-sdlc/translators/<adopter>.ts` and point `cli-import-spec` at its output directory. The seam contract is the `tasks.md` format — any tool that can emit it can feed the bridge.

First-party adapter demand for additional upstreams becomes a Decision in the catalog over time; the operator weighs adopter signal before the framework commits to maintaining a new adapter.

### A clarification task back upstream sits ignored

The Decision Catalog (`/ai-sdlc decisions list`) shows every open `import-blocked-on-dor` Decision. If a clarification has been ignored for too long, the catalog's batch-review surface will flag it. The framework deliberately does not auto-close ignored clarifications — silent closure would mask spec quality regressions.

### Two PRs touching `tasks.md` create conflict during import

Per CLAUDE.md "Git Flow", always rebase. If you imported in branch A and rebased the spec-kit project in branch B, the reconciler will see the rebase as drift on the next tick. Most cases auto-sync (cosmetic); semantic / scope drift opens a Decision per the [Step 7](#step-7--handling-spec-drift-after-import) flow.

---

## Why these defaults? — design rationale and RFC-0036 OQ resolutions

Every default in this tutorial maps back to an Open Question resolution captured in the operator walkthrough on 2026-05-16 (RFC-0036 §14). The full rationale lives in the RFC; the short version per OQ:

| OQ | Topic | Resolution | Lives in |
|---|---|---|---|
| OQ-1 | Seam artifact granularity | `tasks.md` only — no fallback. Spec-kit project lacking `tasks.md` → `Decision: incomplete-spec-detected` → emit clarification back upstream. Selected over fallback because incomplete-spec fallbacks cause incomplete implementations. | [Step 3](#step-3--import-into-the-ai-sdlc-backlog) + [Troubleshooting](#incomplete-spec-detected--tasksmd-missing) |
| OQ-2 | Drift severity policy | Catalog-routed via RFC-0035 Stage A/B/C; low-severity auto-syncs, high-severity defers 24h with operator-override window; in-progress tasks NEVER halt. | [Step 7](#step-7--handling-spec-drift-after-import) |
| OQ-3 | DoR strictness at import | Strict default; `--rubric warn` opt-out flag. The DoR rubric is the framework's quality contract; loosening it by default contradicts the contract. | [Step 4](#step-4--dor-gate-at-import-time) |
| OQ-4 | RFC storage convention | `<adopter-repo>/rfcs/` default; per-org override via `adopter-authoring.yaml`. | [Adopter RFC tutorial (companion piece)](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) |
| OQ-5 | RFC template variants | One template in v1. Demand for variants becomes a future Decision. | (companion tutorial) |
| OQ-6 | Cross-tool bridges | Spec-kit first-party adapter only; non-spec-kit upstreams write their own translator under `.ai-sdlc/translators/`. | [Troubleshooting](#my-non-spec-kit-upstream-linear--notion--plain-markdown-cant-feed-the-bridge) |
| OQ-7 | Analyze overlap with DoR | Full DoR runs; analyze metadata auto-resolves matching gates via catalog. Only NEW gaps reach the operator. | [Step 4 — analyze auto-resolution](#analyze-metadata-auto-resolution-oq-7) |
| OQ-8 | Constitution composition | Separate (`constitution.md` ↔ `CLAUDE.md`); drift detection on shared-norm sections via Decision Catalog; never blocks. | [Step 1 — Constitution vs CLAUDE.md](#constitution-vs-claudemd) |
| OQ-9 | Positioning leadership | "Decision Engine" primary; "spec-driven AI workflows" secondary. | [Concepts: spec-driven development](../concepts/spec-driven.md) |
| OQ-10 | DoR rejection path | Refuse import (no stub task); emit clarification back upstream; log Decision. | [Step 4 — Outcome C](#outcome-c--refused-dor-failed-under-strict-mode) + [Step 5](#step-5--the-upstream-clarification-feedback-loop) |
| OQ-11 | Versioning the seam | Auto-detect schema; refuse unknown via Decision routing. | [Troubleshooting](#upstream-schema-unknown--spec-kit-version-mismatch) |
| OQ-12 | CLI vs slash command | Both. CLI for scripting; `/ai-sdlc import-spec` slash command for in-Claude-Code use. | [Step 3](#step-3--import-into-the-ai-sdlc-backlog) |

All twelve resolutions compose with the [RFC-0035 G0 non-blocking pipeline contract](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md): rigor preserved (every quality contract intact, every gate strict by default), zero blocking (Decisions accumulate in the catalog; the autonomous pipeline continues running on whatever else is dispatchable).

---

## Further reading

| Resource | What it covers |
|---|---|
| [Concepts: spec-driven development](../concepts/spec-driven.md) | The three-tier authoring model (RFC → Spec → Task), Decision-Engine framing, and the seam contract |
| [RFC-0036](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) | The full normative spec — OQ resolutions, schema, config, phase plan |
| [RFC-0011: DoR Gate](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) | Seven-point quality rubric every imported task must pass |
| [RFC-0035: Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) | How DoR refusals, drift Decisions, and clarification routing compose |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | The recommended front-of-funnel toolkit — install + slash command reference |
| [Getting Started](../getting-started/README.md) | First-run installation + the bridge's place in the recommended authoring path |
| `node pipeline-cli/bin/cli-import-spec.mjs --help` | Authoritative CLI flag reference |
