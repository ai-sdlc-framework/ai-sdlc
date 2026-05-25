# Adopter Translators — BYO Upstream for the Spec-Kit Bridge

> RFC-0036 Phase 10 (AISDLC-335). Companion to [`docs/concepts/spec-driven.md`](spec-driven.md) and [Tutorial 10 — Spec-Kit Bridge](../tutorials/10-spec-kit-bridge.md). Normative reference: [RFC-0036 §14 OQ-6](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md).

AI-SDLC's spec-kit bridge (`cli-import-spec` / `/ai-sdlc import-spec`) ships with **one first-party upstream adapter — [GitHub Spec Kit](https://github.com/github/spec-kit)**. Every other upstream (Linear, Notion, Jira, Confluence, plain markdown, an internal RFC repo, a custom proposal tracker) feeds the bridge via the **bring-your-own translator** pattern: the adopter writes a small translator that emits the spec-kit-compatible `tasks.md` format, and the bridge consumes the output unchanged.

This document explains why the framework chose BYO over N first-party adapters, names the canonical task-import format the translator must produce, points at the reference scaffold + worked Linear example, and describes the path from BYO → first-party promotion via the [RFC-0035 Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md).

---

## Table of Contents

1. [Why BYO instead of N first-party adapters](#1-why-byo-instead-of-n-first-party-adapters)
2. [The canonical task-import format](#2-the-canonical-task-import-format)
3. [Translator contract](#3-translator-contract)
4. [Reference scaffold and worked example](#4-reference-scaffold-and-worked-example)
5. [Wiring the translator into your workflow](#5-wiring-the-translator-into-your-workflow)
6. [BYO → first-party promotion path](#6-byo--first-party-promotion-path)
7. [Cross-references](#7-cross-references)

---

## 1. Why BYO instead of N first-party adapters

[RFC-0036 OQ-6](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) considered three options for handling non-spec-kit upstreams:

1. Ship a first-party adapter per upstream (Linear, Notion, Jira, etc.).
2. Refuse non-spec-kit upstreams entirely.
3. Ship a single documented BYO translator pattern + the spec-kit first-party adapter.

Option 3 won for three reasons:

- **Long-tail of upstreams.** "Where do adopters author specs?" has dozens of valid answers and the long tail dominates. First-party coverage of N tools couples our release cadence to N upstream API shapes; a single seam contract decouples both sides cleanly.
- **The seam already exists.** Spec-kit's `tasks.md` is a documented, stable artifact format. Treating it as the canonical task-import format (rather than inventing a new ai-sdlc-specific format) means a translator that emits valid `tasks.md` automatically composes with spec-kit's `/speckit.analyze` and other front-of-funnel tooling — adopters get the ecosystem benefits even when not using spec-kit directly.
- **Demand-signal capture.** When a new upstream genuinely earns first-party status (multiple adopters maintain near-identical translators, the translator stabilises, the upstream API is stable enough to support without constant maintenance), the [Decision Catalog (RFC-0035)](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) captures the demand signal as a `Decision` record so the operator can graduate it on the framework's release cadence — without blocking adopter use in the meantime.

The framework's contract with adopters is the **DoR Gate**. Whatever feeds the gate is the adopter's choice — directly authored backlog tasks, spec-kit `tasks.md`, or a BYO translator output that conforms to the same format.

---

## 2. The canonical task-import format

The translator's output is a **spec-kit-compatible `tasks.md` file**. This is the same format `cli-import-spec` consumes today; the bridge does not care whether spec-kit, a translator, or a hand-typed editor produced it.

### 2.1 Schema versions

Two `tasks.md` layouts are recognised (`pipeline-cli/src/import-spec/parser.ts`):

- **`v0.8-headings`** (recommended for new translators) — one `### T-NNN — <title>` heading per task.
- **`v0.7-checkboxes`** — legacy `- [ ] T-NNN — <title>` checkbox-list layout, preserved for backward compatibility with older spec-kit projects.

The parser auto-detects the layout by scanning for the first task-shaped line. Translators should emit the `v0.8-headings` form unless an existing upstream already produces checkbox output.

### 2.2 `v0.8-headings` layout (canonical)

```markdown
# <feature title> — Tasks

> Optional preamble (free-form; ignored by the parser).

## Tasks

### T-001 — Implement bearer-token validator

Multi-line body describing the task. The body is preserved verbatim
in the imported backlog task under `## Description`.

- AC: POST /auth/validate returns 200 when token is well-formed and unexpired
- AC: POST /auth/validate returns 401 when token is malformed
- AC: POST /auth/validate returns 401 when token is expired

### T-002 — Wire validator into auth middleware

Body for the second task.

- AC: Middleware short-circuits when validation fails
- AC: Middleware sets `req.auth` when validation succeeds
```

### 2.3 Required fields per task

| Field | Source in `tasks.md` | Required? | Notes |
|---|---|---|---|
| `taskId` | The `T-NNN` token in the heading or checkbox row | Yes | Stable identifier; the bridge persists it in the imported task's `specRef.taskId`. |
| `title` | The text after the `—` / `-` / `:` separator | Yes | Used as the imported backlog task's title; also drives the slugified filename. |
| `body` | Lines between the heading and the next heading or `AC:` lines | Optional | Preserved as `## Description` content. |
| `acceptanceCriteria` | Lines matching `^\s*(?:-\s*)?AC:\s*(.+)$` | Optional, but strongly recommended | Each AC becomes a numbered checkbox under the imported task's `## Acceptance Criteria`. Without ACs the import succeeds but DoR Gate 1 (binary-testable ACs) will fail and the task will be refused at import time per OQ-3 + OQ-10. |

### 2.4 What the bridge adds

For each parsed entry the bridge writes a backlog task with:

- A monotonically-allocated id under the configured prefix (default `IMP-N`; see `pipeline-cli/src/import-spec/task-writer.ts`).
- A `specRef:` frontmatter block pointing back to the source `tasks.md` for drift detection (Phase 6 reconcile path).
- Standard backlog labels (`imported-from-spec-kit`, `rfc-0036`) so operators can filter imported work.

The shape adopters see in `backlog/tasks/`:

```yaml
---
id: IMP-7
title: 'Implement bearer-token validator'
status: 'To Do'
assignee: []
labels:
  - imported-from-spec-kit
  - rfc-0036
dependencies: []
references:
  - .specify/specs/auth-feature/tasks.md
specRef:
  source: spec-kit
  featureId: auth-feature
  taskId: T-001
  artifactPath: .specify/specs/auth-feature/tasks.md
  importedAt: '2026-05-24T20:15:00.000Z'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Multi-line body describing the task. The body is preserved verbatim
in the imported backlog task under `## Description`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 POST /auth/validate returns 200 when token is well-formed and unexpired
- [ ] #2 POST /auth/validate returns 401 when token is malformed
- [ ] #3 POST /auth/validate returns 401 when token is expired
<!-- AC:END -->
```

The `source: spec-kit` value in `specRef` is honest about the seam: from the bridge's perspective, anything that produced spec-kit-format `tasks.md` IS a spec-kit upstream for the purposes of drift detection and reconcile. If you want to distinguish your translator output downstream (for analytics, reporting, or selective drift handling), add a second label in your translator output and post-process the imported tasks accordingly.

---

## 3. Translator contract

A translator is **any program** that reads from an upstream source and writes a `tasks.md` file at a path `cli-import-spec --from <path>` can consume. The bridge does not constrain language, runtime, or invocation pattern.

### 3.1 The minimum viable shape

```text
upstream source ──[translator]──▶ .specify/specs/<feature>/tasks.md ──[cli-import-spec]──▶ backlog/tasks/IMP-*.md
```

The translator's job ends at writing the `tasks.md`. Everything downstream (parsing, DoR Gate, drift detection, backlog write) is the bridge's job.

### 3.2 Conventions worth following

These aren't enforced, but match the patterns adopters report success with:

- **One `tasks.md` per upstream "feature" / "epic" / "project"**, written to `.specify/specs/<slug>/tasks.md` so the bridge's `--from <path>` accepts the feature directory directly.
- **Stable `T-NNN` ids** derived from the upstream's own identifier (Linear issue number, Jira ticket key, Notion page id). This keeps the `specRef.taskId` round-trip stable across re-imports.
- **At least one AC per task** so DoR Gate 1 passes at import time. If your upstream doesn't capture ACs explicitly, surface that as upstream feedback rather than synthesising fake ACs in the translator (the synthesised ACs will not survive review and you'll get the upstream-clarification loop right back).
- **Run the translator idempotently.** Re-running over an unchanged upstream should produce a byte-identical `tasks.md` — this is what makes the Phase 6 reconcile loop tractable.
- **Emit the `## Tasks` section header.** It's optional but the parser uses it to skip preamble cleanly.

### 3.3 Failure modes the translator should handle

- **Upstream record without a clear deliverable.** Surface as a translator warning + skip — don't write a `T-NNN` entry that will fail DoR. The adopter's upstream process needs to clarify the record before it can flow through the bridge.
- **Upstream record marked archived / cancelled.** Skip silently. The bridge's reconcile loop (Phase 6) will mark previously imported tasks as `superseded` if they disappear from the translator output.
- **Upstream API throttling / outage.** Bubble the error up rather than emitting a partial `tasks.md`. A partial output would look like upstream deletions to the reconcile loop and trigger `superseded` markings on tasks that are actually still live.

---

## 4. Reference scaffold and worked example

The framework ships two reference TypeScript files under [`docs/examples/translators/`](../examples/translators/):

| File | Purpose |
|---|---|
| [`example-adopter.ts`](../examples/translators/example-adopter.ts) | A typed scaffold with `// TODO:` markers calling out where adopter-specific upstream fetching, mapping, and AC extraction wire in. Copy this into your repo as `.ai-sdlc/translators/<adopter>.ts` and fill the TODOs. |
| [`linear-translator.ts`](../examples/translators/linear-translator.ts) | A minimal worked Linear → ai-sdlc translator. Reads a Linear project's issues via the GraphQL API, maps each issue to a `T-NNN` entry, extracts AC checklist items from the issue description, and writes `.specify/specs/<project-slug>/tasks.md`. |

Both files are dependency-free TypeScript (no framework imports) — they document the **shape** of a translator, not a runtime contract. Adopters copy the file into their own repo, install whatever upstream-specific dependencies they need, and adapt the mapping logic to their conventions.

### 4.1 Where the translator lives in adopter repos

Per RFC-0036 §14.1 (`cross-tool.byoTranslatorPath`), the convention is:

```text
<adopter-repo>/
  .ai-sdlc/
    translators/
      linear.ts          ← BYO translator (one per upstream)
      notion.ts          ← another upstream, another translator
  .specify/
    specs/
      auth-feature/
        tasks.md         ← translator output; what cli-import-spec consumes
  backlog/
    tasks/
      imp-7 - ...md      ← what cli-import-spec produces
```

The `.ai-sdlc/translators/` path is **convention, not framework code**. The bridge doesn't load translators from there — it only reads the `tasks.md` the translator wrote. The path is documented so adopters with multiple translators have an obvious place to keep them under version control alongside the rest of their `.ai-sdlc/` config.

### 4.2 Running the translator

A translator is just a script. Run it however your team prefers:

```bash
# Direct invocation
npx tsx .ai-sdlc/translators/linear.ts --project auth-feature

# Behind a CI hook on upstream change
gh workflow run "Sync from Linear" --field project=auth-feature

# As a periodic cron
*/30 * * * * cd /repo && npx tsx .ai-sdlc/translators/linear.ts --all-projects
```

The framework doesn't prescribe — your team owns the cadence and trigger. Once the translator has written the `tasks.md`, run the bridge:

```bash
cli-import-spec --from .specify/specs/auth-feature/
# or, inside Claude Code:
/ai-sdlc import-spec --from .specify/specs/auth-feature/
```

---

## 5. Wiring the translator into your workflow

### 5.1 Configuration knob

`.ai-sdlc/adopter-authoring.yaml` (RFC-0036 §14.1) documents the BYO translator path convention:

```yaml
adopter-authoring:
  cross-tool:
    firstPartyAdapters: [speckit]
    byoTranslatorPath: '.ai-sdlc/translators/<adopter>.ts'
```

The `byoTranslatorPath` field is **informational** in v1 — it documents the convention so multi-translator adopters keep their translators in one place. The bridge doesn't enforce or load from this path; it only reads the `tasks.md` the translator produced.

### 5.2 The full loop

1. **Upstream** (Linear / Notion / Jira / etc.) — adopter authors a feature in their existing tool.
2. **Translator** (`.ai-sdlc/translators/<adopter>.ts`) — adopter-owned script that reads the upstream and writes `.specify/specs/<feature>/tasks.md`.
3. **`cli-import-spec`** — the bridge parses the `tasks.md`, runs DoR Gate per task, and writes `backlog/tasks/IMP-*.md` with `specRef:` back-pointers.
4. **DoR-failed tasks** — refused at import per OQ-3 + OQ-10; the bridge emits a clarification task back upstream so the adopter knows what to tighten in step 1.
5. **DoR-passed tasks** — flow through the autonomous orchestrator like any other backlog task.

The translator is the **only** new code the adopter writes. Everything downstream of step 2 is identical to a first-party spec-kit workflow.

---

## 6. BYO → first-party promotion path

The BYO pattern is not a permanent ceiling. When a translator matures (stable upstream API, multiple adopters running near-identical code, low-maintenance), the operator can graduate it to first-party status. The mechanism is a **`Decision` record in the [RFC-0035 Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)**.

### 6.1 How adopters signal demand

Adopters who want their upstream graduated to first-party file a decision with the catalog:

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Promote Linear translator to first-party adapter" \
  --scope spec-kit-bridge \
  --option "promote:graduate the BYO Linear translator under pipeline-cli/src/import-spec/adapters/linear/" \
  --option "defer:keep as BYO; revisit after N more adopter requests"
```

The operator reviews the catalog in batch (the standard RFC-0035 cadence). When demand for a particular upstream accumulates — multiple adopters, mature translator implementations, no major API churn risk — the operator promotes the decision to `promote` and a follow-up backlog task ships the first-party adapter.

### 6.2 What promotion actually changes

A first-party adapter is **functionally identical** to a BYO translator from the bridge's perspective — both produce `tasks.md`. The differences are:

| Aspect | BYO translator | First-party adapter |
|---|---|---|
| Location | `.ai-sdlc/translators/<adopter>.ts` in adopter repo | `pipeline-cli/src/import-spec/adapters/<name>/` in framework repo |
| Maintenance | Adopter | Framework maintainers |
| Versioning | Adopter's repo | Framework release cycle |
| Tests | Adopter's CI | Framework test suite |
| Discoverability | Documented in adopter's runbook | Listed in `cli-import-spec --list-adapters` (future), shipped with the framework |
| API stability | Adopter accepts upstream API churn risk | Framework absorbs the maintenance burden |

The cost asymmetry is real — first-party support means the framework team owns API churn, security patches, and breaking-change migrations for the lifetime of the adapter. The promotion gate is intentionally high.

### 6.3 Composing with G0 (non-blocking pipeline)

Per RFC-0036 OQ-6 + [RFC-0035 G0](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md), the promotion mechanism is **non-blocking**: adopter demand accumulates in the catalog without halting framework releases. If a translator is in heavy use as BYO and the operator hasn't yet promoted it, the framework keeps shipping — the BYO pattern is the steady-state for tools that don't yet warrant first-party maintenance.

This is the explicit shape of "voting with your voice on which adapters should graduate to first-party": every adopter who writes a translator AND files a `Decision: promote-translator` is contributing a demand-signal data point. The operator graduates upstreams when the signal is strong enough to justify the maintenance contract, not when the first adopter asks.

---

## 7. Cross-references

| Resource | What it covers |
|---|---|
| [RFC-0036 §14 OQ-6](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) | Normative resolution: single BYO pattern + spec-kit first-party adapter only |
| [RFC-0036 §14.1](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) | `cross-tool.byoTranslatorPath` config schema |
| [RFC-0035: Decision Catalog](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) | The mechanism for adopter demand signal → first-party promotion |
| [`docs/concepts/spec-driven.md`](spec-driven.md) | The three-tier authoring model; spec-kit bridge sits at the Spec → Task seam |
| [`docs/tutorials/10-spec-kit-bridge.md`](../tutorials/10-spec-kit-bridge.md) | End-to-end walkthrough: install spec-kit → author spec → import → dispatch → ship |
| [`docs/examples/translators/example-adopter.ts`](../examples/translators/example-adopter.ts) | Reference translator scaffold; copy + adapt |
| [`docs/examples/translators/linear-translator.ts`](../examples/translators/linear-translator.ts) | Worked example: minimal Linear → ai-sdlc translator |
| [`pipeline-cli/src/import-spec/parser.ts`](../../pipeline-cli/src/import-spec/parser.ts) | The canonical reader the translator must satisfy; defines the supported `tasks.md` shapes |
| [GitHub Spec Kit](https://github.com/github/spec-kit) | The first-party upstream; reference implementation of the `tasks.md` format |

---

*This document covers Phase 10 of RFC-0036 §13. Phase 11 (hybrid promotion runbook) tracks operator-side rollout of the adopter-authoring feature flag.*
