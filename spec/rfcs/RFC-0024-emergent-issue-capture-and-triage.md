---
id: RFC-0024
title: Emergent Issue Capture + Triage Pattern
status: Draft
lifecycle: Implemented
author: Dominique Legault
created: 2026-05-03
updated: 2026-05-26
targetSpecVersion: v1alpha1
requires: [RFC-0011, RFC-0015]
requiresDocs: []
---

# RFC-0024: Emergent Issue Capture + Triage Pattern

**Status:** Implemented v0.5 — all Refit phases shipped (AISDLC-320 / 321 / 275-278). AISDLC-278 (Refit Phase 6) closed the final §15.1 gap: lifecycle timebox service (`cli-capture-lifecycle`), OQ-6 rate ceiling, OQ-9 stale ladder, archive support, and `capture-config.yaml` template.
**Lifecycle:** Implemented
**Author:** Dominique Legault
**Created:** 2026-05-03
**Updated:** 2026-05-26
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0011 (DoR gate), RFC-0015 (autonomous orchestrator)
**Anchor:** [VISION.md §5](../../VISION.md) — emergent-work gap

> The bold-status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

## 1. Summary

The Decision Engine ([VISION.md](../../VISION.md)) frontloads decisions through the DoR gate so the autonomous orchestrator can execute deterministically. But not every issue surfaces in advance — operators and AI agents discover new issues mid-work: a refactor surfaces a latent bug, a code review uncovers a missing edge case, a UX walkthrough reveals an unstated requirement.

Today, the framework has no formal pattern for capturing these. The operator either:

- **Drops what they're doing** to file a new Issue or Feature Issue in the configured tracker (breaks flow, loses context on the original work)
- **Mentally bookmarks** the finding and hopes to remember (often forgotten)
- **Inlines a fix** into the current work (scope creep; violates "one Issue = one contract")
- **Leaves a TODO comment** in the code (technical debt that nobody schedules)

This RFC defines a first-class **emergent issue capture pattern** that lets the operator (or an AI agent) record a finding with minimal context-switching, triages it to the right destination (quick-fix Issue, scope-extension to current work, new Feature Issue, or "not actionable"), and integrates with the DoR + orchestrator loop so emergent work flows into the pipeline without manual translation.

### 1.1 Terminology — framework-level vs. ai-sdlc-internal

This RFC defines a framework-level pattern. Operators of the framework can configure ANY issue-tracker adapter (per RFC-0003 Infrastructure Adapters) — Linear, Jira, GitHub Issues, backlog.md, etc. The pattern uses these abstract terms:

| Framework-level term | Meaning | ai-sdlc-internal example |
|---|---|---|
| **Issue** | A unit of work tracked by the configured issue-tracker adapter | A backlog.md task at `backlog/tasks/aisdlc-NNN-*.md` |
| **Feature Issue** | An Issue kind that requires upstream design work before execution can be scoped (analogous to a design doc / RFC / spec) | An RFC at `spec/rfcs/RFC-NNNN-*.md` |
| **Bug Issue** | An Issue kind for framework-quality findings (per RFC-0025 taxonomy) | A bug-labeled task in `backlog/tasks/` |

Adopters' issue trackers may use different vocabulary (Linear has Issues + Projects; Jira has Issues + Epics + Stories; backlog.md has Tasks + Milestones). The framework's adapter contract translates between framework-level terms and the tracker's native vocabulary. Examples in this RFC sometimes show the ai-sdlc-internal incarnation (AISDLC-NNN, RFC-NNNN) but the **normative pattern is adapter-agnostic**.

## 2. Motivation

### 2.1 The Decision Engine's known gap

VISION.md §5 explicitly acknowledges that not all complexity can be frontloaded:

> Some emerges only during execution: performance characteristics revealed under realistic load, integration interactions between systems that look orthogonal on paper, scaling thresholds invisible at small N, user behavior that doesn't match any operator's mental model.

The framework needs explicit support for this — capturing these findings is the input to the next round of frontloading.

### 2.2 Today's emergent-issue patterns are lossy

Observations from dogfood (the witness test of `cli-orchestrator tick` on 2026-05-03 alone surfaced 4 emergent issues, AISDLC-174 through 177):

| Capture path | Loss mode |
|---|---|
| Operator manually files an Issue in the configured tracker | Breaks flow; operator forgets details by the time they get to the form; references to the source context are weak |
| Operator types into Slack/scratch file | Captured but invisible to pipeline; no auto-triage; manually translated later |
| AI agent observes problem in passing | No mechanism to surface; observation evaporates with the session |
| Inline `// TODO:` comment | Captured in code, but invisible to issue tracker; severity unknown; no owner |
| GitHub PR comment "we should also..." | Visible but trapped in PR thread; rarely converted to a tracked Issue |

Each of these loses **either context (the why), urgency (the cost of not fixing), or visibility (does anyone know about it?)**. The framework's quality contract (VISION.md §4) requires self-improvement loops; lossy capture breaks those loops.

### 2.3 Triage decisions belong upfront, but require context

When an emergent issue is captured, the next decision is what to do with it:

- **Quick fix**: small scope, can ship with current work or as a tiny standalone PR
- **Scope extension to current work**: this is genuinely the same contract, expand the AC list
- **New Issue**: separate contract, will be scheduled by PPA + DoR
- **New Feature Issue**: design decision needed before any execution Issue can be scoped
- **Not actionable**: known limitation, expected behavior, won't fix

This triage is itself a decision — and per the Decision Engine, decisions should be made by the operator with full context. But the operator only has full context **at the moment of capture** (deep in the original work). Asking them to re-derive the context days later in a triage meeting is exactly the kind of cost-asymmetry violation the framework is supposed to eliminate.

The capture pattern must therefore include a **lightweight triage rubric** that the operator (or AI agent) applies AT capture time, not later.

### 2.4 The orchestrator can't block on indefinite human input

When a captured issue blocks the current pipeline run (e.g., "this PR depends on resolving the captured finding"), the orchestrator needs a clean way to express that dependency. Today, it would either stall the PR indefinitely (waiting for human resolution) or merge in a degraded state. Neither matches the Decision Engine's contract.

The pattern must define a **decision-pending → decision-deferred handoff** so the orchestrator records the dependency, marks the current PR as gated on it, and continues with other work — surfacing the gating decision as a blocker in the operator TUI (RFC-0023).

## 3. Goals

1. **Lossless capture** — emergent findings recorded with full context (source, observer, evidence, suspected severity)
2. **Capture-time triage** — operator (or AI agent) applies a lightweight rubric at the moment of finding
3. **No flow break for the operator** — capture takes < 30 seconds when the operator is mid-work
4. **AI-agent capture surface** — review/dev subagents can capture findings programmatically
5. **Pipeline integration** — captured items flow into the configured issue tracker with appropriate kind (Issue / Feature Issue / scope-extension); the orchestrator recognizes them
6. **Decision-pending handoff** — when an emergent finding gates the current work, the orchestrator records it as a deferred decision and surfaces it as an operator blocker
7. **Audit trail** — every capture is traceable: who captured what, when, from what context, with what triage decision

## 4. Non-goals

1. **Not a project management tool** — this isn't replacing Jira or Linear; capture is the entry point, not the lifecycle manager
2. **Not a brainstorming surface** — captures are findings, not ideas (idea capture is a separate concern; consider a follow-on Feature Issue if needed)
3. **Not a real-time collaboration surface** — captures are operator-individual; multi-operator merge is out of scope for v1
4. **Not a change in DoR semantics** — emergent findings that become Issues STILL pass through DoR; this RFC is about the on-ramp, not the gate

## 5. Capture sources

The pattern supports four capture paths, each with its own surface:

### 5.1 CLI capture: `cli-capture`

For operators in a terminal (the primary path):

```bash
# Inline capture from anywhere in the repo
cli-capture "auth middleware doesn't refresh tokens before expiry" \
  --severity major \
  --triage new-issue \
  --context "found while reviewing PR #234, src/auth/middleware.ts:142"

# With deferred triage (operator captures now, decides later in the TUI)
cli-capture "consider extracting cookie-handling into shared util" \
  --triage tbd

# AI-agent capture (machine-readable arguments)
cli-capture --json '{"finding":"unused export in foo.ts","severity":"minor","triage":"new-issue","source":"code-reviewer-agent","evidenceFile":"foo.ts","evidenceLine":42}'
```

The CLI writes a capture record to `$ARTIFACTS_DIR/_captures/<timestamp>-<random>.jsonl` (one record per file; never modified after write). Records are never auto-deleted; `cli-capture gc` operates on age + triage-status.

### 5.2 PR-comment marker

Operator can capture from a GitHub PR review comment by including a marker:

```
<!-- ai-sdlc:capture severity=major triage=new-issue -->
The session-token rotation logic doesn't handle clock-skew between
nodes. We should fix this in a follow-up; not blocking this PR.
```

A polling job (or webhook in v2) reads PR comments containing the marker, converts them to capture records (preserving comment URL, author, PR number), and queues them.

### 5.3 In-code marker (formalized TODO)

Replaces the unstructured `// TODO:` with a triage-bearing marker:

```typescript
// ai-sdlc:capture severity=minor triage=new-issue
// The retry loop here doesn't apply jitter; could thunder-herd on broad outage.
function retryWithBackoff(...) { ... }
```

A linting pass (`pnpm lint:captures`) extracts all such markers in a PR and surfaces them to the capture queue. Avoids the silent-rot problem of unstructured TODOs.

### 5.4 AI-agent direct capture

Review subagents, the developer subagent, and the orchestrator itself can write capture records directly to `$ARTIFACTS_DIR/_captures/` via the `cli-capture --json` interface. The agent's prompt is updated to instruct it to capture (not silently absorb) findings that match capture criteria.

Examples of agent-driven captures:

- **code-reviewer**: "I noticed unrelated cleanup that would simplify this file" → captures with `triage: new-issue`
- **test-reviewer**: "Test coverage is good but the test name doesn't match its assertion" → captures with `triage: new-issue severity: minor`
- **developer**: "I had to work around an undocumented behavior in dep X" → captures with `triage: new-feature-issue severity: major` (the workaround is technical debt; needs upstream design decision before an execution Issue can be scoped)
- **orchestrator**: "Failure mode 'developer-failed' triggered, work was quarantined" → captures with `triage: framework-bug` (routes to RFC-0025 framework-quality flow)

## 6. Capture record schema

Every capture is a JSON object conforming to `spec/schemas/capture-record.v1.schema.json`:

```jsonc
{
  "id": "cap_2026-05-03T17-42-03_abc123",          // monotonic + random suffix
  "schemaVersion": "v1",
  "timestamp": "2026-05-03T17:42:03Z",
  "finding": "auth middleware doesn't refresh tokens before expiry",
  "severity": "critical|major|minor|suggestion|unknown",
  "triage": "new-issue|new-feature-issue|scope-extension|quick-fix|framework-bug|not-actionable|tbd",
  "source": {
    "type": "operator|ai-agent",
    "agentRole": "code-reviewer|test-reviewer|security-reviewer|developer|orchestrator|null",
    "operator": "Dominique Legault|null",
    "context": "free-text — what the source was doing when this surfaced"
  },
  "evidence": {
    "filePath": "src/auth/middleware.ts|null",
    "line": 142,
    "prNumber": 234,
    "commentUrl": "https://github.com/.../pull/234#discussion_r999|null",
    "commitSha": "abc123|null",
    "additionalContext": "free-text"
  },
  "relatedIssueId": "AISDLC-176|LIN-1234|null",       // if this captures-against an in-flight Issue (adapter-native ID)
  "extensionTargetIssueId": "AISDLC-167|null",        // if triage=scope-extension
  "featureIssueCarveRef": "spec/rfcs/RFC-0024-…|null",// if triage=new-feature-issue and Feature Issue has been drafted (path / URL / adapter-native ref)
  "blocksIssueId": "AISDLC-178|null",                 // if this finding gates another Issue's progress
  "createdIssueId": null,                             // populated when an Issue is created from this capture
  "createdFeatureIssueId": null,                      // populated when a Feature Issue is reserved from this capture
  "resolvedAt": null,                                 // populated when triage flips from tbd to a terminal value
  "resolvedBy": null,
  "auditTrail": [
    { "action": "captured", "by": "Dominique Legault", "at": "2026-05-03T17:42:03Z" }
  ]
}
```

The schema is intentionally rich — capture-time cost is low if the agent fills most fields and the operator only confirms. **Issue ID format is adapter-native**: AISDLC-NNN for backlog.md, LIN-NNN for Linear, ABC-NNN for Jira, `org/repo#NNN` for GitHub Issues, etc. The framework's adapter contract translates between framework-level capture records and the tracker's native ID space.

## 7. Triage rubric

Each triage value has a precise meaning that the framework can act on:

| Triage | Meaning | Framework action (issue-tracker-adapter delegates the create/edit calls) |
|---|---|---|
| `tbd` | Captured but operator hasn't decided | Surfaced in TUI Blockers pane until resolved |
| `quick-fix` | Small scope, ships standalone or with current work | Adapter creates an Issue with `priority: low`, labels `quick-fix` + source-context label |
| `new-issue` | Separate contract, normal scope | Adapter creates an Issue in Draft state; operator refines + flips to ready-for-execution |
| `scope-extension` | Belongs in current Issue's AC list | Adapter appends AC to `extensionTargetIssueId`; emits `CaptureScopeExtended` event |
| `new-feature-issue` | Upstream design decision required before any execution Issue can be scoped | Adapter creates a Feature Issue (kind=feature, lifecycle=Draft) in the configured tracker; surfaces in TUI for operator drafting. ai-sdlc-internal: reserves next RFC slot + creates placeholder `spec/rfcs/RFC-NNNN-*.md`. |
| `framework-bug` | Framework misbehaved (per RFC-0025 taxonomy) | Adapter creates a Bug Issue (kind=bug, label=framework-bug); auto-fills evidence |
| `not-actionable` | Known limitation, expected behavior, won't fix | Records reasoning in capture, archives to `_captures/_archive/` |

The rubric is **fixed enum** (not free-form) so the framework can route deterministically. Adding triage values requires a spec change to RFC-0024 itself.

The issue-tracker adapter contract (per RFC-0003 Infrastructure Adapters) MUST implement the create/edit calls for Issue + Feature Issue + Bug Issue kinds. Adapter-native vocabulary is invisible to the capture pattern — the framework only sees the abstract kinds.

## 8. Integration with DoR (RFC-0011)

Captures with `triage: new-issue` create Issues in Draft state via the issue-tracker adapter. These Issues must still pass DoR Stage A + Stage B before the orchestrator dispatches them. The capture record's `evidence` + `source` fields populate the initial Issue description, but the operator (or refinement reviewer) must add open questions, ACs, and dependencies as part of the standard DoR refinement.

This means **emergent capture is the on-ramp, not a bypass**. The Decision Engine's frontloading contract is preserved.

For `triage: scope-extension`, the appended AC must itself satisfy the DoR criteria for AC quality (testable, single-purpose, etc.). The DoR re-check fires automatically when an AC is appended (already supported by RFC-0011 Phase 4 / AISDLC-115.5).

For `triage: new-feature-issue`, the resulting Feature Issue itself does not pass through standard DoR (Feature Issues are upstream design work, not execution Issues). Once the Feature Issue resolves to a concrete design, the operator drafts one or more execution Issues that DO pass through DoR. This two-step lifecycle (Feature Issue → execution Issue(s)) preserves DoR's frontloading contract while accommodating designs that aren't fully scoped at capture time.

## 9. Integration with the autonomous orchestrator (RFC-0015)

### 9.1 Capture as a side-effect of orchestrator runs

The orchestrator's playbook handlers (RFC-0015 Phase 2 / AISDLC-169.2) emit captures for:

- Failure-mode escalations that are framework bugs (per RFC-0025 routing)
- Repeated failures of the same kind (calibration drift, infinite-iteration mode)
- Stuck-candidate counter exceeded (>5 ticks without progress)

These captures land in `$ARTIFACTS_DIR/_captures/` with `triage: framework-bug` and route to Bug Issues in the configured tracker automatically.

### 9.2 Decision-pending → decision-deferred handoff

When a captured finding **gates** an in-flight pipeline run (the `blocksIssueId` field is populated), the orchestrator:

1. Marks the gated Issue with `Needs Clarification` status via the issue-tracker adapter (RFC-0011 Phase 4) — pointing at the capture record
2. Stops dispatching that Issue; moves to the next frontier candidate
3. Emits `CaptureBlockedIssue` event so the TUI can surface the dependency
4. Resumes the gated Issue automatically once the capture's triage becomes terminal AND the resulting Issue (or Feature Issue → execution Issue chain) reaches Done/Implemented in the tracker

This is the **decision-deferred** pattern — the operator doesn't have to manually un-stick the original work; the framework reconnects the dependency once the deferred decision lands.

### 9.3 Capture-pending in dispatch filtering

A new pre-dispatch filter (`filters/captures-pending.ts`) refuses to dispatch an Issue if it has any unresolved capture (triage=tbd) referencing it. This prevents the orchestrator from re-dispatching work that the operator hasn't yet finished triaging.

## 10. Integration with the operator TUI (RFC-0023)

The TUI's Blockers pane surfaces captures with `triage: tbd` as the highest-priority signal (per VISION.md §3 — operator's bottleneck is decisions). Each row offers one-keystroke triage actions:

- `t` → set `triage: new-issue` (adapter creates draft Issue immediately)
- `e` → set `triage: scope-extension` (prompts for target Issue ID)
- `r` → set `triage: new-feature-issue` (adapter creates Feature Issue / reserves Feature Issue slot)
- `q` → set `triage: quick-fix`
- `f` → set `triage: framework-bug`
- `n` → set `triage: not-actionable` (prompts for reason)
- `?` → expand evidence + context inline

Captures with terminal triage values render in a separate "recently triaged" pane for audit (last 24h).

## 11. Capture ownership + audit

The framework treats captures as immutable records once written. The `auditTrail` field accumulates state transitions:

```jsonc
"auditTrail": [
  { "action": "captured", "by": "code-reviewer", "at": "2026-05-03T17:42:03Z" },
  { "action": "triaged", "by": "Dominique Legault", "to": "new-issue", "at": "2026-05-03T17:45:11Z" },
  { "action": "issue-created", "by": "framework", "issueId": "AISDLC-178", "via-adapter": "backlog-md", "at": "2026-05-03T17:45:11Z" }
]
```

This satisfies the framework's quality contract (VISION.md §4 — "self-improvement loop"): every capture-to-resolution path is traceable, and the corpus aggregator can compute capture-throughput metrics for the operator analytics surface (RFC-0023 §10).

## 12. Capture corpus + aggregator

`cli-capture-corpus aggregate` produces summary statistics for operator review:

- Capture rate (per day / per source / per agent)
- Triage decision distribution
- Median time-from-capture-to-triage
- "Stale captures" (triage=tbd > 7 days) — drives operator nudge
- Capture-to-Issue conversion rate (how many captures actually become Issues vs not-actionable)

These metrics inform operator throughput optimization (RFC-0023 §10) and surface framework-quality signals (e.g., a spike in `framework-bug` captures from a specific playbook handler is a signal to re-tune that handler — closes the RFC-0025 self-improvement loop).

## 13. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 — Schema + capture writer | `capture-record.v1.schema.json`, `cli-capture` binary, JSONL writer to `_captures/`, validator | 4–5 days |
| 2 — Triage rubric + actions | Triage enum, capture → adapter Issue creation, capture → adapter Feature Issue creation, capture → AC append for scope-extension via adapter | 1 week |
| 3 — Pre-dispatch filter | `filters/captures-pending.ts` wired into orchestrator, `CaptureBlockedIssue` event, decision-deferred handoff | 4–5 days |
| 4 — Capture sources beyond CLI | PR-comment marker poller, `lint:captures` rule for in-code markers, agent prompt updates | 1 week |
| 5 — Operator TUI integration | Blockers pane shows tbd captures with triage actions, recently-triaged pane | 4 days (depends on RFC-0023 progress) |
| 6 — Corpus aggregator + promotion | `cli-capture-corpus aggregate`, hybrid promotion runbook, soak window | 1 week soak + 3 days runbook |

Total: ~5–6 weeks wall-clock, parallelizable phases 4 + 5.

## 14. Feature flag

`AI_SDLC_EMERGENT_CAPTURE=experimental` (mirrors RFC-0014 / RFC-0015 pattern). When unset, `cli-capture` exits with a "not enabled" message + pointer to the promotion runbook. Phase 6 promotion runbook drives the default-on flip.

## 15. Open questions — resolved (initial 2026-05-13; revised 2026-05-15)

> **Implementation Status (2026-05-15):** AISDLC-269 / PR #483 shipped capture authoring + triage flow against the **2026-05-13 first-pass OQ resolutions**. The **2026-05-15 walkthrough revised** OQ-1 / OQ-2 / OQ-3 / OQ-5 / OQ-7 / OQ-9 / OQ-11 and added §15.1 Capture Lifecycle Defaults — leaving a real gap between shipped behavior and the resolved design. **Lifecycle rolled back to `Ready for Review`**; gap closed by **RFC-0024 Refit (AISDLC-320 / 321 + 275-278)** — flips back to `Implemented` after Refit Phase 6 (AISDLC-278) ships.
>
> **What ships (AISDLC-269):**
> - `spec/schemas/capture-record.v1.schema.json` — formal JSON Schema for capture records.
> - `pipeline-cli/src/capture/` — capture record types, writer, reader, triage rubric, PR-comment parser, in-code marker linter.
> - `pipeline-cli/src/cli/capture.ts` + `pipeline-cli/bin/cli-capture.mjs` — `cli-capture` CLI (file, list, redact, against-current-pr, triage, parse-pr-comments, lint-file, help-triage).
> - `pipeline-cli/src/orchestrator/filters/captures-pending.ts` — pre-dispatch filter that blocks dispatch when unresolved `tbd` captures reference the candidate issue (RFC-0024 §9.3).
> - `pipeline-cli/src/tui/blockers/detector.ts` Rule 3 + `pipeline-cli/src/tui/corpus/aggregate.ts` `TuiCaptureFiled` aggregation (landed earlier; part of detector + aggregator slice).
> - Feature-flagged behind `AI_SDLC_EMERGENT_CAPTURE=experimental`. Filter is degrade-open (passes when flag is unset).
>
> **What remains for follow-up:** Adapter calls (Issue creation, Feature Issue reservation, scope-extension AC append) require RFC-0003 adapter implementations. TUI triage keystrokes (§10) depend on RFC-0023 Blockers pane interactive layer. Corpus aggregator CLI (`cli-capture-corpus`) is a Phase 6 item.

The following normative answers were established across two operator walkthroughs. The **2026-05-13 walkthrough** (during AISDLC-269 development) settled OQ-1..OQ-12 with first-pass resolutions. The **2026-05-15 walkthrough resolved all 12 OQs again** — substantively revising OQ-1 / OQ-2 / OQ-3 / OQ-5 / OQ-7 / OQ-9 / OQ-11, and affirming-as-recommended OQ-4 / OQ-6 / OQ-8 / OQ-10 / OQ-12 — and added §15.1 Capture Lifecycle Defaults. Each OQ below shows the 2026-05-13 first-pass inline and a `Resolution (2026-05-15)` marker for the current normative answer. The shipped implementation (AISDLC-269) reflects the 2026-05-13 first-pass; the **RFC-0024 Refit (AISDLC-320 / 321 + 275-278)** closes the gap to the 2026-05-15 revisions (the 5 affirmed-as-recommended OQs already match shipped behavior).

**OQ-1 — Capture privacy → RESOLVED: team-shared.**
Records are written to `$ARTIFACTS_DIR/_captures/` — a directory within the operator's artifact store, not encrypted or ACL-gated. Team-shared matches the framework's transparency contract and makes the audit trail queryable by all collaborators. Private captures (e.g. half-formed thoughts) are out of scope for v1.

   **Resolution (2026-05-15):** **Draft → Shared state machine** (Linear's pattern). Captures start as drafts in `.ai-sdlc/captures-drafts/<id>.md` (operator-local, gitignored); explicit `cli-capture submit <id>` transitions to team-shared `backlog/captures/<id>.md`. Bulk action: `cli-capture submit-all`. AI-agent captures honor the same state via OQ-2's threshold gate (high-confidence → auto-submit; low-confidence → draft). **Selected over team-shared-by-default** because team-visibility friction recreates the "half-formed thought" failure mode §2.2 explicitly names — operators self-censor when every capture is immediately team-visible. Per §15.1 lifecycle defaults: drafts auto-submit after 7d (per-org configurable; reversible via `cli-capture redact`).

**OQ-2 — AI-agent auto-triage threshold:** Should AI agents auto-set the `triage` field, or always default to `tbd` and require operator confirmation? Recommendation: agents auto-set triage with confidence score; operator confirms in TUI. Forces operator awareness without losing the agent's signal.

   **Resolution (2026-05-15):** **Threshold-gated dual axis** (Datadog/PagerDuty pattern). Single confidence threshold (default **0.7**) gates BOTH auto-triage AND auto-submit. High-confidence (≥ threshold): agent's triage auto-applied; capture auto-submitted to team; TUI shows "AI auto-triaged this; confirm?" badge. Low-confidence (< threshold): `triage: pending`, draft state; surfaces in operator review queue. Per-agent threshold override allowed in agent role config (e.g. security-reviewer stricter, code-reviewer looser). Calibration loop via RFC-0025 corpus: operator-overrides of auto-triages feed back as signal; threshold adjusts. Per §15.1 lifecycle defaults: pending triage auto-classifies via OQ-3 classifier after 14d (per-org configurable; reversible via re-triage).

**OQ-3 — Capture-vs-comment for in-PR findings:** When a reviewer finds something in a PR review, should the framework prefer a GitHub PR review comment (visible in standard PR UI) OR a capture record (typed, triaged)? Recommendation: both — the PR comment includes the capture marker (§5.2), so it's visible in GitHub UI AND in the capture corpus.

   **Resolution (2026-05-15):** **Bidirectional sync + LLM auto-classifier** (Linear AI / Jira Service Management AI pattern). PR review comments stay in GitHub as the source of truth; a Haiku-class classifier evaluates each comment for "is this a capture?" with confidence; classified-yes comments are indexed in the RFC-0024 capture corpus with a reference to the GitHub comment URL. Capture marker syntax (OQ-4) becomes optional refinement, not the only signal. Threshold: confidence ≥ 0.5 indexed; < 0.5 ignored. Conflict resolution: GitHub-edit-wins; capture re-syncs on next webhook. AI-agent captures from reviewers bypass the classifier (they're already typed). **Selected over marker-only** because busy reviewers won't reliably tag — without the auto-classifier the corpus would have ~20% of actual review signal.

**OQ-4 — In-code marker syntax:** Match the `// TODO:` ergonomic ("operators already type this") or use a distinctive prefix to make linting unambiguous? Recommendation: `// ai-sdlc:capture` prefix — distinctive, lint-able, doesn't collide with existing TODO conventions that the operator might use for other purposes.

   **Resolution (2026-05-15):** **`// ai-sdlc:capture` distinctive prefix** (matches `@ts-`, `// eslint-`, `// prettier-`, BMad's `@bmad-capture` industry-standard pattern). Default form: `// ai-sdlc:capture <triage?> <finding>` where `<triage>` is optional and matches OQ-2's threshold-gated triage values; without it, defaults to `pending`. Case-insensitive parser. Brownfield migration handled separately via `cli-capture migrate-todos --pattern <regex>` tooling (not a syntax concern). Selected over hybrid `// TODO(capture):` because greenfield clarity outweighs brownfield-migration friction, and the prefix pattern is unambiguous for the parser.

**OQ-5 — Severity inference:** When the capturer doesn't supply `severity`, should the framework infer (based on agent role, finding text classifier, etc.) or leave as `unknown`? Recommendation: leave as `unknown`; operator triages with severity in mind.

   **Resolution (2026-05-15):** **Threshold-gated severity** (same pattern as OQ-2). Shared 0.7 threshold and corpus with OQ-2 / OQ-3 / OQ-11. Above threshold: severity auto-set with "AI suggested" badge in TUI; operator confirms at triage. Below threshold: severity stays `unknown` until operator sets at triage time. Calibration via RFC-0025 corpus. **Selected over leaving `unknown` as final state** for architectural consistency with OQ-2 and because `unknown` would become a useless filter dimension if it persisted. Per §15.1 lifecycle defaults: unknown severity auto-classifies via OQ-3 classifier after 14d (per-org configurable; reversible via re-classify).

**OQ-6 — Capture quota / rate-limiting:** AI agents could theoretically capture excessively (every minor lint observation). Should the framework rate-limit? Recommendation: no hard limit, but corpus aggregator surfaces "agent X captured Y findings/day" so operator can adjust agent prompts if needed.

   **Resolution (2026-05-15):** **Soft warning + multi-surface notification at per-agent ceiling** (composes with OQ-9). Default ceiling **50 submitted captures/day/agent role**; configurable per role in `.ai-sdlc/capture-config.yaml`. Threshold notification surfaces via Slack DM + TUI; full volume continues to corpus (no drops). Volume is naturally bounded by OQ-1 D (low-confidence drafts stay operator-local) and OQ-2 C (threshold gates team-shared volume); OQ-6 catches anomalies above natural baseline. Cost-rail integration via RFC-0004 `CostPolicy` deferred to RFC-0037 Phase 3+. **Selected over hard-ceiling-with-drops** because silent drops contaminate trust; selected over no-limit-with-analytics because the operator-saved cost-cap incident showed passive analytics-only fails the active-notification test.

**OQ-7 — Capture deletion:** Records are immutable per §11. Can the operator EVER delete a capture (e.g., accidentally captured PII)? Recommendation: yes via `cli-capture redact <id> --reason <text>` which scrubs the `finding` field but preserves the audit trail. Hard delete is operator-only via filesystem (not a CLI affordance).

   **Resolution (2026-05-15):** **Tiered deletion** (composes with OQ-1 D state machine). Drafts (operator-local in `.ai-sdlc/captures-drafts/`) are hard-deletable via `cli-capture discard <id> --reason <text>` — clean removal, no audit footprint because the draft was never team-shared. Submitted captures (team-shared in `backlog/captures/`) get `cli-capture redact <id> --reason <text>` — scrubs the `finding` field but preserves the shell + audit trail per §11's immutability contract. Hard delete of submitted captures is operator-only via filesystem (not a CLI affordance) for irreversible-action safety. Selected over redact-only because draft `discard` is honest (operator hasn't shared yet, no audit obligation) and the asymmetry mirrors OQ-1's draft/submit state-machine boundary.

**OQ-8 — Issue labeling on auto-created Issues:** Should auto-created Issues carry a label distinguishing them from operator-curated Issues (e.g., `emergent-capture`)? Recommendation: yes — useful for analytics + lets operator filter "Issues I personally framed" vs "Issues the framework surfaced." Adapter implementations MUST surface a `kind: emergent-capture` label or equivalent in the tracker's native label space.

   **Resolution (2026-05-15):** **Single `emergent-capture` label + `source-agent-<role>` label when AI-originated.** Every auto-created Issue from a capture gets the `emergent-capture` label (filterable; analytics-friendly). When the source was an AI agent (vs operator-authored), an additional `source-agent-<role>` label is applied (e.g. `source-agent-code-reviewer`, `source-agent-security-reviewer`). Adapter implementations MUST surface both via the tracker's native label space. Selected over single-label-only because AI-attribution is a real analytics dimension (operator wants to know "is the framework's auto-classification getting better over time?"); kept to ≤ 2 labels to avoid the label-sprawl problem operators tune out.

**OQ-9 — Decision-deferred timeout:** An Issue gated on a `tbd` capture stays in `Needs Clarification`. Should there be a timeout (e.g., capture sits >14 days → escalate notification)? Recommendation: yes, surfaces in TUI with growing-louder visual treatment but no auto-action.

   **Resolution (2026-05-15):** **Multi-surface notification ladder + auto-resolve** (composes with [Slack integration intent](memory:project_slack_integration)). Ladder: day 3 TUI highlight → day 7 Slack DM → day 14 email digest (weekly Sunday) → day 21 classify-via-OQ-3-classifier + archive to `backlog/captures/archived/<id>.md`. Each threshold configurable per `.ai-sdlc/capture-config.yaml`. Auto-resolve at 21d preserves audit (archived, not deleted) + signal (classifier guess attached for searchability) while removing from operator's active queue. **Selected over indefinite-pending** because "not making a decision is a decision" — the cumulative cost of N pending captures exceeds the cost of being wrong on any single auto-resolve. Per §15.1 lifecycle defaults.

**OQ-10 — Multi-capture from one source:** When an agent finds 5 things in one PR review, are those 5 captures or 1 capture with 5 findings? Recommendation: 5 captures — each must be independently triageable (one might be quick-fix, one new-feature-issue).

   **Resolution (2026-05-15):** **One capture per finding (N captures from one source).** When an agent finds 5 things in one PR review, the framework files 5 capture records — each independently triageable, each with its own confidence/severity/triage state. Volume bounded by OQ-6's per-agent rate ceiling (50/day default) and OQ-1's draft state (low-confidence drafts stay operator-local). Selected over bundling because bundling kills independent triage — one of the 5 findings might be `quick-fix-task`, one `new-feature-issue`, one `scope-creep-into-current-work`; collapsing them into a bullet list inside one record forces a single triage decision on multiple actual decisions. LLM-classifier-bundling considered but deferred — the rate ceiling already addresses flood risk; classifier-driven grouping can be added later if the corpus shows operators routinely manually-grouping related captures.

**OQ-11 — Capture during DoR refinement:** When the refinement reviewer (RFC-0011 Stage B) asks an operator question and the operator's answer reveals a NEW concern, is that a capture or a DoR comment edit? Recommendation: capture — preserves the audit trail across the DoR + capture corpora.

   **Resolution (2026-05-15):** **Reuse the OQ-3 LLM classifier on DoR clarification answers.** When the operator answers a DoR Stage B refinement question, the classifier (single-corpus, same model as OQ-3) evaluates each segment of the answer for `clarification | new-concern | ambiguous` with confidence; new-concern segments auto-extract to capture records referencing the DoR thread by ID. Same 0.7 threshold as OQ-2 / OQ-3 / OQ-5 (shared corpus calibration). Operator confirms in TUI before commit; multi-segment answers can split capture from clarification. **Selected over operator-flagged-inline-syntax** for the same reason as OQ-3 — busy operators won't reliably tag, and reusing the classifier maintains architectural coherence. RFC-0011 (Implemented) gains a side-effect (classifier on clarification responses) but its rubric and admission semantics stay unchanged.

**OQ-12 — CLI ergonomics for "capture against current PR":** When the operator is mid-PR-review, `cli-capture --against-current-pr` should auto-detect the PR from cwd / branch context. Worth shipping in Phase 1 or defer? Recommendation: ship in Phase 1 — the convenience drives adoption.

   **Resolution (2026-05-15):** **Ship in Phase 1 with auto-detect.** `cli-capture file --against-current-pr "<finding>"` auto-detects the current PR via `gh pr view --json number` (cwd → branch → PR). Explicit `--pr=<N>` flag remains available as override. Matches the modern dev-CLI convention (`gh pr ...`, Linear CLI, Jira CLI all auto-detect from branch). Selected over deferring to Phase 2 because auto-detection is table-stakes UX for the capture flow — without it, operators have to copy-paste the PR number while mid-review, defeating the "low-friction capture" motivation in §2.2. Implementation cost is small (one `gh` shell-out + a fallback "no PR detected; specify `--pr` explicitly" error path).

### 15.1 Capture Lifecycle Defaults (Timebox + Default-on-Silence Convention)

The framework's contract: **"not making a decision is a decision; the framework keeps work moving while respecting operator authority."** Every capture-lifecycle state with operator-decision-pending carries an explicit timebox + default-on-silence auto-action. Auto-actions fire even under operator fatigue — the operator catches up retroactively rather than blocking the pipeline.

| State | Default timebox | Default action on expiry | Reversibility |
|---|---|---|---|
| Draft (OQ-1) | 7d | Auto-submit to team-shared | Reversible via `cli-capture redact` |
| `triage: pending` (OQ-2) | 14d | Auto-run OQ-3 classifier; apply highest-confidence triage | Reversible via re-triage |
| `severity: unknown` (OQ-5) | 14d | Auto-run OQ-3 classifier; apply highest-confidence severity | Reversible via re-classify |
| Stale capture ladder (OQ-9) | 21d (after 3d TUI / 7d Slack / 14d email tiers) | Classify + archive to `backlog/captures/archived/` | Archived, not deleted (audit preserved) |

**Per-organization configurability is mandatory.** Organizations process captures at different velocities — a 100-issues/day team's draft is "ancient" after a day; a few-issues/day team's draft is "fresh" after a week. Each timebox is overridable in `.ai-sdlc/capture-config.yaml`:

```yaml
capture:
  lifecycle:
    draftAutoSubmitDays: 7        # OQ-1 — default 7
    pendingTriageDays: 14         # OQ-2 — default 14
    unknownSeverityDays: 14       # OQ-5 — default 14
    staleNotificationLadder:      # OQ-9
      tuiHighlightDays: 3
      slackDmDays: 7
      emailDigestDays: 14
      autoArchiveDays: 21
```

Default constants ship in the `ai-sdlc init` capture-config template. Auto-tuning from observed corpus throughput is future work (composes with RFC-0014 dep-graph signal + RFC-0025 quality monitoring substrate); operator-configurable from day one.

When fatigue is active (per RFC-0035 §7 once that ships), timeboxes continue to fire — the operator catches up retroactively. The whole point of the timebox is that it's non-blocking.

## 16. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ✅ Signed v0.3 (OQs resolved, implementation shipped) | 2026-05-13 |
| Alexander Kline | Product Lead | ✅ Signed v0.2 | 2026-05-04 |

Lifecycle: Implemented (AISDLC-269 landed capture authoring + triage flow; all 12 OQs resolved).

### Product Authority review

**Endorse with PPA integration**: emergent issues bypass DoR (findings from in-flight work, not authored issues) and enter PPA admission directly via `sourceType: emergent` on AdmissionInput. This composition is correct and load-bearing.

**Three-way triage** (quick-fix vs scope-extension vs new strategic Issue) is the right shape. **Suggested fourth disposition**: `parked-as-finding` (or "not actionable but worth recording") — operators discover findings that are real but not work-shaped (e.g., "this whole approach is wrong, file a new RFC instead"). Treating these as "new strategic" creates noise; treating them as "discard" loses the signal. A structured findings log preserves the signal without admission overhead.

**Composition with RFC-0033 governance reporting**: emergent captures feed RFC-0033's `rd.uncertaintiesAddressed` section directly — the synthesis between "what we discovered we didn't know" and "what we addressed" is exactly the shape an emergent capture log produces.

**Composition with RFC-0026 exploration workstreams**: exploration captures (per RFC-0026) are emergent-by-construction — the entire point of an exploration is to convert unknowns into capturable findings. RFC-0024's mechanism IS the on-ramp for RFC-0026's outputs.

**Composition with RFC-0030 Signal Ingestion**: when a captured finding correlates with existing demand-cluster signal (per RFC-0030), the capture should reference the cluster ID. Cross-reference recommended once 0030 lands.

Position grounded in RFC-0029 Part II + Principle 5 (governance by composition).

## 17. References

- [VISION.md](../../VISION.md) §4 (quality contract), §5 (emergent gap) — anchoring philosophy
- [RFC-0003 — Infrastructure Adapters](RFC-0003-infrastructure-adapters.md) — issue-tracker adapter contract that translates between framework-level Issue/Feature Issue/Bug Issue kinds and the tracker's native vocabulary
- [RFC-0011 — Definition of Ready Gate](RFC-0011-definition-of-ready-gate.md) — captures-as-on-ramp, not bypass
- [RFC-0015 — Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — playbook handler integration, decision-deferred
- [RFC-0023 — Operator TUI](RFC-0023-operator-tui-pipeline-monitoring.md) — Blockers pane, triage actions
- [RFC-0025 — Framework Quality Monitoring](RFC-0025-framework-quality-monitoring.md) — `triage: framework-bug` routing
- [RFC-0026 — Exploration Workstream Pattern](RFC-0026-exploration-workstream-pattern.md) — captures during exploration are first-class

## 18. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-03 | Dominique Legault | Initial draft seed; 12 open questions |
| v0.2 | 2026-05-04 | Dominique Legault | Abstraction pass: lifted ai-sdlc-internal terminology (backlog tasks, RFCs) to framework-level (Issue, Feature Issue, Bug Issue) routed through the configured issue-tracker adapter (RFC-0003). Triage values renamed: `new-task` → `new-issue`; `new-rfc` → `new-feature-issue`. Capture record schema fields renamed: `relatedTaskId/extensionTargetTaskId/blocksTaskId/createdTaskId/createdRfcId/rfcCarvePath` → `relatedIssueId/extensionTargetIssueId/blocksIssueId/createdIssueId/createdFeatureIssueId/featureIssueCarveRef`. Added §1.1 framework-vs-ai-sdlc-internal terminology table. Added two-step Feature Issue → execution Issue lifecycle clarification in §8. Added RFC-0003 reference. ai-sdlc-internal examples (AISDLC-NNN) preserved as illustrative only. |
| v0.3 | 2026-05-13 | Dominique Legault | Implementation shipped (AISDLC-269). `spec/schemas/capture-record.v1.schema.json` formalizes §6 schema. `pipeline-cli/src/capture/` implements capture writer, reader, triage rubric, PR-comment parser, in-code marker linter. `cli-capture` CLI ships §5.1/§5.2/§5.3/§5.4 surfaces. `captures-pending.ts` filter implements §9.3 pre-dispatch guard. All 12 OQs resolved with normative answers in §15 (first-pass). Lifecycle flipped to Implemented. |
| v0.4 | 2026-05-15 | Dominique Legault | Second OQ walkthrough revised OQ-1 (team-shared → Draft → Shared state machine) / OQ-2 (operator-confirms → threshold-gated dual axis) / OQ-3 (marker-only → bidirectional sync + LLM auto-classifier) / OQ-5 (leave-unknown → threshold-gated severity) / OQ-7 (redact-only → tiered deletion with draft `discard`) / OQ-9 (TUI-only → multi-surface 3d/7d/14d/21d ladder + auto-archive) / OQ-11 (manual → DoR-classifier integration) and added §15.1 Capture Lifecycle Defaults (4 timeboxes + per-org `capture-config.yaml`). Revealed gap between shipped behavior (AISDLC-269, against 2026-05-13 first-pass) and revised design. **Lifecycle rolled back from Implemented to Ready for Review.** Refit tasks AISDLC-320 / 321 + 275-278 file the gap closure; lifecycle flips back to Implemented after Refit Phase 6 (AISDLC-278) ships. |
