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

**Status:** Draft (initial seed; structure may shift)
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

- **Drops what they're doing** to file a backlog task or RFC (breaks flow, loses context on the original work)
- **Mentally bookmarks** the finding and hopes to remember (often forgotten)
- **Inlines a fix** into the current work (scope creep; violates "one issue = one contract")
- **Leaves a TODO comment** in the code (technical debt that nobody schedules)

This RFC defines a first-class **emergent issue capture pattern** that lets the operator (or an AI agent) record a finding with minimal context-switching, triages it to the right destination (quick-fix task, scope-extension to current work, new RFC, or "not actionable"), and integrates with the DoR + orchestrator loop so emergent work flows into the pipeline without manual translation.

## 2. Motivation

### 2.1 The Decision Engine's known gap

VISION.md §5 explicitly acknowledges that not all complexity can be frontloaded:

> Some emerges only during execution: performance characteristics revealed under realistic load, integration interactions between systems that look orthogonal on paper, scaling thresholds invisible at small N, user behavior that doesn't match any operator's mental model.

The framework needs explicit support for this — capturing these findings is the input to the next round of frontloading.

### 2.2 Today's emergent-issue patterns are lossy

Observations from dogfood (the witness test of `cli-orchestrator tick` on 2026-05-03 alone surfaced 4 emergent issues, AISDLC-174 through 177):

| Capture path | Loss mode |
|---|---|
| Operator manually files backlog task | Breaks flow; operator forgets details by the time they get to the form; references to the source context are weak |
| Operator types into Slack/scratch file | Captured but invisible to pipeline; no auto-triage; manually translated later |
| AI agent observes problem in passing | No mechanism to surface; observation evaporates with the session |
| Inline `// TODO:` comment | Captured in code, but invisible to backlog; severity unknown; no owner |
| GitHub PR comment "we should also..." | Visible but trapped in PR thread; rarely converted to backlog item |

Each of these loses **either context (the why), urgency (the cost of not fixing), or visibility (does anyone know about it?)**. The framework's quality contract (VISION.md §4) requires self-improvement loops; lossy capture breaks those loops.

### 2.3 Triage decisions belong upfront, but require context

When an emergent issue is captured, the next decision is what to do with it:

- **Quick fix**: small scope, can ship with current work or as a tiny standalone PR
- **Scope extension to current work**: this is genuinely the same contract, expand the AC list
- **New backlog task**: separate contract, will be scheduled by PPA + DoR
- **New RFC**: design decision needed before any task can be scoped
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
5. **Pipeline integration** — captured items flow into backlog with appropriate type (task / RFC / extension); the orchestrator recognizes them
6. **Decision-pending handoff** — when an emergent finding gates the current work, the orchestrator records it as a deferred decision and surfaces it as an operator blocker
7. **Audit trail** — every capture is traceable: who captured what, when, from what context, with what triage decision

## 4. Non-goals

1. **Not a project management tool** — this isn't replacing Jira or Linear; capture is the entry point, not the lifecycle manager
2. **Not a brainstorming surface** — captures are findings, not ideas (idea capture is a separate concern; consider future RFC if needed)
3. **Not a real-time collaboration surface** — captures are operator-individual; multi-operator merge is out of scope for v1
4. **Not a change in DoR semantics** — emergent issues that become tasks STILL pass through DoR; this RFC is about the on-ramp, not the gate

## 5. Capture sources

The pattern supports four capture paths, each with its own surface:

### 5.1 CLI capture: `cli-capture`

For operators in a terminal (the primary path):

```bash
# Inline capture from anywhere in the repo
cli-capture "auth middleware doesn't refresh tokens before expiry" \
  --severity major \
  --triage new-task \
  --context "found while reviewing PR #234, src/auth/middleware.ts:142"

# With deferred triage (operator captures now, decides later in the TUI)
cli-capture "consider extracting cookie-handling into shared util" \
  --triage tbd

# AI-agent capture (machine-readable arguments)
cli-capture --json '{"finding":"unused export in foo.ts","severity":"minor","triage":"new-task","source":"code-reviewer-agent","evidenceFile":"foo.ts","evidenceLine":42}'
```

The CLI writes a capture record to `$ARTIFACTS_DIR/_captures/<timestamp>-<random>.jsonl` (one record per file; never modified after write). Records are never auto-deleted; `cli-capture gc` operates on age + triage-status.

### 5.2 PR-comment marker

Operator can capture from a GitHub PR review comment by including a marker:

```
<!-- ai-sdlc:capture severity=major triage=new-task -->
The session-token rotation logic doesn't handle clock-skew between
nodes. We should fix this in a follow-up; not blocking this PR.
```

A polling job (or webhook in v2) reads PR comments containing the marker, converts them to capture records (preserving comment URL, author, PR number), and queues them.

### 5.3 In-code marker (formalized TODO)

Replaces the unstructured `// TODO:` with a triage-bearing marker:

```typescript
// ai-sdlc:capture severity=minor triage=new-task
// The retry loop here doesn't apply jitter; could thunder-herd on broad outage.
function retryWithBackoff(...) { ... }
```

A linting pass (`pnpm lint:captures`) extracts all such markers in a PR and surfaces them to the capture queue. Avoids the silent-rot problem of unstructured TODOs.

### 5.4 AI-agent direct capture

Review subagents, the developer subagent, and the orchestrator itself can write capture records directly to `$ARTIFACTS_DIR/_captures/` via the `cli-capture --json` interface. The agent's prompt is updated to instruct it to capture (not silently absorb) findings that match capture criteria.

Examples of agent-driven captures:

- **code-reviewer**: "I noticed unrelated cleanup that would simplify this file" → captures with `triage: new-task`
- **test-reviewer**: "Test coverage is good but the test name doesn't match its assertion" → captures with `triage: new-task severity: minor`
- **developer**: "I had to work around an undocumented behavior in dep X" → captures with `triage: new-rfc severity: major` (the workaround is technical debt; needs design decision)
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
  "triage": "new-task|new-rfc|scope-extension|quick-fix|framework-bug|not-actionable|tbd",
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
  "relatedTaskId": "AISDLC-176|null",                // if this captures-against an in-flight task
  "extensionTargetTaskId": "AISDLC-167|null",        // if triage=scope-extension
  "rfcCarvePath": "spec/rfcs/RFC-0024-…|null",      // if triage=new-rfc and RFC has been drafted
  "blocksTaskId": "AISDLC-178|null",                 // if this finding gates another task's progress
  "createdTaskId": null,                              // populated when a backlog task is created from this capture
  "createdRfcId": null,                               // populated when an RFC is reserved from this capture
  "resolvedAt": null,                                 // populated when triage flips from tbd to a terminal value
  "resolvedBy": null,
  "auditTrail": [
    { "action": "captured", "by": "dominique@reliablegenius.io", "at": "2026-05-03T17:42:03Z" }
  ]
}
```

The schema is intentionally rich — capture-time cost is low if the agent fills most fields and the operator only confirms.

## 7. Triage rubric

Each triage value has a precise meaning that the framework can act on:

| Triage | Meaning | Framework action |
|---|---|---|
| `tbd` | Captured but operator hasn't decided | Surfaced in TUI Blockers pane until resolved |
| `quick-fix` | Small scope, ships standalone or with current work | Auto-creates backlog task with `priority: low`, labels `quick-fix` + source-context label |
| `new-task` | Separate contract, normal scope | Creates backlog task with `status: Draft`; operator refines + flips to `To Do` |
| `scope-extension` | Belongs in current task's AC list | Appends AC to `extensionTargetTaskId`; emits `CaptureScopeExtended` event |
| `new-rfc` | Design decision required first | Reserves next RFC slot; creates placeholder file; surfaces in TUI for operator drafting |
| `framework-bug` | Framework misbehaved (per RFC-0025 taxonomy) | Routes to `framework-bugs/` task subdirectory; auto-fills evidence |
| `not-actionable` | Known limitation, expected behavior, won't fix | Records reasoning in capture, archives to `_captures/_archive/` |

The rubric is **fixed enum** (not free-form) so the framework can route deterministically. Adding triage values requires an RFC update.

## 8. Integration with DoR (RFC-0011)

Captures with `triage: new-task` create backlog tasks in `status: Draft`. These tasks must still pass DoR Stage A + Stage B before the orchestrator dispatches them. The capture record's `evidence` + `source` fields populate the initial task description, but the operator (or refinement reviewer) must add open questions, ACs, and dependencies as part of the standard DoR refinement.

This means **emergent capture is the on-ramp, not a bypass**. The Decision Engine's frontloading contract is preserved.

For `triage: scope-extension`, the appended AC must itself satisfy the DoR criteria for AC quality (testable, single-purpose, etc.). The DoR re-check fires automatically when an AC is appended (already supported by RFC-0011 Phase 4 / AISDLC-115.5).

## 9. Integration with the autonomous orchestrator (RFC-0015)

### 9.1 Capture as a side-effect of orchestrator runs

The orchestrator's playbook handlers (RFC-0015 Phase 2 / AISDLC-169.2) emit captures for:

- Failure-mode escalations that are framework bugs (per RFC-0025 routing)
- Repeated failures of the same kind (calibration drift, infinite-iteration mode)
- Stuck-candidate counter exceeded (>5 ticks without progress)

These captures land in `$ARTIFACTS_DIR/_captures/` with `triage: framework-bug` and route to AISDLC-NNN bug tasks automatically.

### 9.2 Decision-pending → decision-deferred handoff

When a captured finding **gates** an in-flight pipeline run (the `blocksTaskId` field is populated), the orchestrator:

1. Marks the gated task with `Needs Clarification` status (RFC-0011 Phase 4) — pointing at the capture record
2. Stops dispatching that task; moves to the next frontier candidate
3. Emits `CaptureBlockedTask` event so the TUI can surface the dependency
4. Resumes the gated task automatically once the capture's triage becomes terminal AND the resulting task/RFC reaches `Done`/`Implemented`

This is the **decision-deferred** pattern — the operator doesn't have to manually un-stick the original work; the framework reconnects the dependency once the deferred decision lands.

### 9.3 Capture-pending in dispatch filtering

A new pre-dispatch filter (`filters/captures-pending.ts`) refuses to dispatch a task if it has any unresolved capture (triage=tbd) referencing it. This prevents the orchestrator from re-dispatching work that the operator hasn't yet finished triaging.

## 10. Integration with the operator TUI (RFC-0023)

The TUI's Blockers pane surfaces captures with `triage: tbd` as the highest-priority signal (per VISION.md §3 — operator's bottleneck is decisions). Each row offers one-keystroke triage actions:

- `t` → set `triage: new-task` (creates draft task immediately)
- `e` → set `triage: scope-extension` (prompts for target task ID)
- `r` → set `triage: new-rfc` (reserves RFC slot)
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
  { "action": "triaged", "by": "dominique@reliablegenius.io", "to": "new-task", "at": "2026-05-03T17:45:11Z" },
  { "action": "task-created", "by": "framework", "taskId": "AISDLC-178", "at": "2026-05-03T17:45:11Z" }
]
```

This satisfies the framework's quality contract (VISION.md §4 — "self-improvement loop"): every capture-to-resolution path is traceable, and the corpus aggregator can compute capture-throughput metrics for the operator analytics surface (RFC-0023 §10).

## 12. Capture corpus + aggregator

`cli-capture-corpus aggregate` produces summary statistics for operator review:

- Capture rate (per day / per source / per agent)
- Triage decision distribution
- Median time-from-capture-to-triage
- "Stale captures" (triage=tbd > 7 days) — drives operator nudge
- Capture-to-task conversion rate (how many captures actually become tasks vs not-actionable)

These metrics inform operator throughput optimization (RFC-0023 §10) and surface framework-quality signals (e.g., a spike in `framework-bug` captures from a specific playbook handler is a signal to re-tune that handler — closes the RFC-0025 self-improvement loop).

## 13. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 — Schema + capture writer | `capture-record.v1.schema.json`, `cli-capture` binary, JSONL writer to `_captures/`, validator | 4–5 days |
| 2 — Triage rubric + actions | Triage enum, capture → backlog task creation, capture → RFC reservation, capture → AC append for scope-extension | 1 week |
| 3 — Pre-dispatch filter | `filters/captures-pending.ts` wired into orchestrator, `CaptureBlockedTask` event, decision-deferred handoff | 4–5 days |
| 4 — Capture sources beyond CLI | PR-comment marker poller, `lint:captures` rule for in-code markers, agent prompt updates | 1 week |
| 5 — Operator TUI integration | Blockers pane shows tbd captures with triage actions, recently-triaged pane | 4 days (depends on RFC-0023 progress) |
| 6 — Corpus aggregator + promotion | `cli-capture-corpus aggregate`, hybrid promotion runbook, soak window | 1 week soak + 3 days runbook |

Total: ~5–6 weeks wall-clock, parallelizable phases 4 + 5.

## 14. Feature flag

`AI_SDLC_EMERGENT_CAPTURE=experimental` (mirrors RFC-0014 / RFC-0015 pattern). When unset, `cli-capture` exits with a "not enabled" message + pointer to the promotion runbook. Phase 6 promotion runbook drives the default-on flip.

## 15. Open questions

These need operator walkthrough before Lifecycle: Draft → Ready for Review.

**OQ-1 — Capture privacy:** Should capture records be operator-private by default (only visible to the capturer) or team-shared? Trade-off: privacy lowers capture friction (operator might capture half-formed thoughts) but team-shared makes the audit trail richer. Recommendation: team-shared (matches the rest of the framework's transparency contract).

**OQ-2 — AI-agent auto-triage threshold:** Should AI agents auto-set the `triage` field, or always default to `tbd` and require operator confirmation? Recommendation: agents auto-set triage with confidence score; operator confirms in TUI. Forces operator awareness without losing the agent's signal.

**OQ-3 — Capture-vs-comment for in-PR findings:** When a reviewer finds something in a PR review, should the framework prefer a GitHub PR review comment (visible in standard PR UI) OR a capture record (typed, triaged)? Recommendation: both — the PR comment includes the capture marker (§5.2), so it's visible in GitHub UI AND in the capture corpus.

**OQ-4 — In-code marker syntax:** Match the `// TODO:` ergonomic ("operators already type this") or use a distinctive prefix to make linting unambiguous? Recommendation: `// ai-sdlc:capture` prefix — distinctive, lint-able, doesn't collide with existing TODO conventions that the operator might use for other purposes.

**OQ-5 — Severity inference:** When the capturer doesn't supply `severity`, should the framework infer (based on agent role, finding text classifier, etc.) or leave as `unknown`? Recommendation: leave as `unknown`; operator triages with severity in mind.

**OQ-6 — Capture quota / rate-limiting:** AI agents could theoretically capture excessively (every minor lint observation). Should the framework rate-limit? Recommendation: no hard limit, but corpus aggregator surfaces "agent X captured Y findings/day" so operator can adjust agent prompts if needed.

**OQ-7 — Capture deletion:** Records are immutable per §11. Can the operator EVER delete a capture (e.g., accidentally captured PII)? Recommendation: yes via `cli-capture redact <id> --reason <text>` which scrubs the `finding` field but preserves the audit trail. Hard delete is operator-only via filesystem (not a CLI affordance).

**OQ-8 — Backlog labeling on auto-created tasks:** Should auto-created tasks carry a label distinguishing them from operator-curated tasks (e.g., `emergent-capture`)? Recommendation: yes — useful for analytics + lets operator filter "tasks I personally framed" vs "tasks the framework surfaced."

**OQ-9 — Decision-deferred timeout:** A task gated on a `tbd` capture stays in `Needs Clarification`. Should there be a timeout (e.g., capture sits >14 days → escalate notification)? Recommendation: yes, surfaces in TUI with growing-louder visual treatment but no auto-action.

**OQ-10 — Multi-capture from one source:** When an agent finds 5 things in one PR review, are those 5 captures or 1 capture with 5 findings? Recommendation: 5 captures — each must be independently triageable (one might be quick-fix, one new-RFC).

**OQ-11 — Capture during DoR refinement:** When the refinement reviewer (RFC-0011 Stage B) asks an operator question and the operator's answer reveals a NEW concern, is that a capture or a DoR comment edit? Recommendation: capture — preserves the audit trail across the DoR + capture corpora.

**OQ-12 — CLI ergonomics for "capture against current PR":** When the operator is mid-PR-review, `cli-capture --against-current-pr` should auto-detect the PR from cwd / branch context. Worth shipping in Phase 1 or defer? Recommendation: ship in Phase 1 — the convenience drives adoption.

## 16. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ⏳ Pending walkthrough | — |
| Alexander Kline | Product Lead | ⏳ Pending walkthrough | — |

Lifecycle: Draft → Ready for Review (after OQ walkthrough) → Signed Off (after all owners sign).

## 17. References

- [VISION.md](../../VISION.md) §4 (quality contract), §5 (emergent gap) — anchoring philosophy
- [RFC-0011 — Definition of Ready Gate](RFC-0011-definition-of-ready-gate.md) — captures-as-on-ramp, not bypass
- [RFC-0015 — Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — playbook handler integration, decision-deferred
- [RFC-0023 — Operator TUI](RFC-0023-operator-tui-pipeline-monitoring.md) — Blockers pane, triage actions
- [RFC-0025 — Framework Quality Monitoring](RFC-0025-framework-quality-monitoring.md) (reserved) — `triage: framework-bug` routing
- [RFC-0026 — Exploration Workstream Pattern](RFC-0026-exploration-workstream-pattern.md) (reserved) — captures during exploration are first-class

## 18. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-03 | dominique@reliablegenius.io | Initial draft seed; 12 open questions |
