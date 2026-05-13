---
id: RFC-0024
title: Emergent Issue Capture + Triage Pattern
status: Draft
lifecycle: Draft
author: dominique@reliablegenius.io
created: 2026-05-03
updated: 2026-05-03
targetSpecVersion: v1alpha1
requires: [RFC-0011, RFC-0015]
requiresDocs: []
---

# RFC-0024: Emergent Issue Capture + Triage Pattern

**Status:** Draft v0.2 — abstraction pass: terminology lifted from ai-sdlc-internal (backlog tasks, RFCs) to framework-level (Issues via configured adapter, Feature Issues for upstream-design-work).
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-03
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
    "operator": "dominique@reliablegenius.io|null",
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
    { "action": "captured", "by": "dominique@reliablegenius.io", "at": "2026-05-03T17:42:03Z" }
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
  { "action": "triaged", "by": "dominique@reliablegenius.io", "to": "new-issue", "at": "2026-05-03T17:45:11Z" },
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

## 15. Open questions

> **Partial Implementation Status (2026-05-13):** Detection substrate shipped; capture authoring + main triage flow pending.
>
> **What ships:**
> - `pipeline-cli/src/tui/blockers/detector.ts` — Rule 3 detects `triage: tbd` captures and surfaces them as TUI blockers (citing RFC-0024 directly).
> - `pipeline-cli/src/tui/corpus/aggregate.ts` — `TuiCaptureFiled` event aggregation tied to RFC-0024 capture IDs.
>
> **What's pending:** capture authoring CLI (`cli-capture`, `cli-emergent`) per §5.1, triage-decision flow per §7, backlog Issue creation from captures per §9.2, in-code marker linter (§5.3), AI-agent direct-capture path (§5.4), DoR integration (§8).
>
> Lifecycle remains `Draft` — the 12 OQs below still need operator walkthrough before the capture authoring layer can land. A follow-up backlog task (`chore: complete RFC-0024 capture authoring + triage flow`) should track the unbuilt portion.

These need operator walkthrough before Lifecycle: Draft → Ready for Review.

**OQ-1 — Capture privacy:** Should capture records be operator-private by default (only visible to the capturer) or team-shared? Trade-off: privacy lowers capture friction (operator might capture half-formed thoughts) but team-shared makes the audit trail richer. Recommendation: team-shared (matches the rest of the framework's transparency contract).

**OQ-2 — AI-agent auto-triage threshold:** Should AI agents auto-set the `triage` field, or always default to `tbd` and require operator confirmation? Recommendation: agents auto-set triage with confidence score; operator confirms in TUI. Forces operator awareness without losing the agent's signal.

**OQ-3 — Capture-vs-comment for in-PR findings:** When a reviewer finds something in a PR review, should the framework prefer a GitHub PR review comment (visible in standard PR UI) OR a capture record (typed, triaged)? Recommendation: both — the PR comment includes the capture marker (§5.2), so it's visible in GitHub UI AND in the capture corpus.

**OQ-4 — In-code marker syntax:** Match the `// TODO:` ergonomic ("operators already type this") or use a distinctive prefix to make linting unambiguous? Recommendation: `// ai-sdlc:capture` prefix — distinctive, lint-able, doesn't collide with existing TODO conventions that the operator might use for other purposes.

**OQ-5 — Severity inference:** When the capturer doesn't supply `severity`, should the framework infer (based on agent role, finding text classifier, etc.) or leave as `unknown`? Recommendation: leave as `unknown`; operator triages with severity in mind.

**OQ-6 — Capture quota / rate-limiting:** AI agents could theoretically capture excessively (every minor lint observation). Should the framework rate-limit? Recommendation: no hard limit, but corpus aggregator surfaces "agent X captured Y findings/day" so operator can adjust agent prompts if needed.

**OQ-7 — Capture deletion:** Records are immutable per §11. Can the operator EVER delete a capture (e.g., accidentally captured PII)? Recommendation: yes via `cli-capture redact <id> --reason <text>` which scrubs the `finding` field but preserves the audit trail. Hard delete is operator-only via filesystem (not a CLI affordance).

**OQ-8 — Issue labeling on auto-created Issues:** Should auto-created Issues carry a label distinguishing them from operator-curated Issues (e.g., `emergent-capture`)? Recommendation: yes — useful for analytics + lets operator filter "Issues I personally framed" vs "Issues the framework surfaced." Adapter implementations MUST surface a `kind: emergent-capture` label or equivalent in the tracker's native label space.

**OQ-9 — Decision-deferred timeout:** An Issue gated on a `tbd` capture stays in `Needs Clarification`. Should there be a timeout (e.g., capture sits >14 days → escalate notification)? Recommendation: yes, surfaces in TUI with growing-louder visual treatment but no auto-action.

**OQ-10 — Multi-capture from one source:** When an agent finds 5 things in one PR review, are those 5 captures or 1 capture with 5 findings? Recommendation: 5 captures — each must be independently triageable (one might be quick-fix, one new-feature-issue).

**OQ-11 — Capture during DoR refinement:** When the refinement reviewer (RFC-0011 Stage B) asks an operator question and the operator's answer reveals a NEW concern, is that a capture or a DoR comment edit? Recommendation: capture — preserves the audit trail across the DoR + capture corpora.

**OQ-12 — CLI ergonomics for "capture against current PR":** When the operator is mid-PR-review, `cli-capture --against-current-pr` should auto-detect the PR from cwd / branch context. Worth shipping in Phase 1 or defer? Recommendation: ship in Phase 1 — the convenience drives adoption.

## 16. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ⏳ Pending walkthrough | — |
| Alexander Kline | Product Lead | ✅ Signed v0.2 | 2026-05-04 |

Lifecycle: Draft → Ready for Review (after OQ walkthrough) → Signed Off (after all owners sign).

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
| v0.1 | 2026-05-03 | dominique@reliablegenius.io | Initial draft seed; 12 open questions |
| v0.2 | 2026-05-04 | dominique@reliablegenius.io | Abstraction pass: lifted ai-sdlc-internal terminology (backlog tasks, RFCs) to framework-level (Issue, Feature Issue, Bug Issue) routed through the configured issue-tracker adapter (RFC-0003). Triage values renamed: `new-task` → `new-issue`; `new-rfc` → `new-feature-issue`. Capture record schema fields renamed: `relatedTaskId/extensionTargetTaskId/blocksTaskId/createdTaskId/createdRfcId/rfcCarvePath` → `relatedIssueId/extensionTargetIssueId/blocksIssueId/createdIssueId/createdFeatureIssueId/featureIssueCarveRef`. Added §1.1 framework-vs-ai-sdlc-internal terminology table. Added two-step Feature Issue → execution Issue lifecycle clarification in §8. Added RFC-0003 reference. ai-sdlc-internal examples (AISDLC-NNN) preserved as illustrative only. |
