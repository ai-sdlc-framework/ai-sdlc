---
id: RFC-0025
title: Framework Quality Monitoring (Non-Decision Failure Modes)
status: Draft
lifecycle: Ready for Review
author: dominique@reliablegenius.io
created: 2026-05-03
updated: 2026-05-15
targetSpecVersion: v1alpha1
requires: [RFC-0015, RFC-0024]
requiresDocs: []
---

# RFC-0025: Framework Quality Monitoring (Non-Decision Failure Modes)

**Status:** Draft (initial seed; structure may shift)
**Lifecycle:** Draft
**Author:** dominique@reliablegenius.io
**Created:** 2026-05-03
**Target Spec Version:** v1alpha1
**Depends on:** RFC-0015 (autonomous orchestrator), RFC-0024 (emergent issue capture)
**Anchor:** [VISION.md §4](../../VISION.md) — framework's quality contract

> The bold-status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

## 1. Summary

The Decision Engine ([VISION.md §1](../../VISION.md)) targets a 95% pass-through rate for well-frontloaded issues. The other 5% are not all the same kind of failure: some are **operator under-decided** failures (the issue genuinely lacked a decision; refining the DoR gate fixes the class), and some are **framework-misbehaved** failures (the framework itself broke its quality contract; fixing the framework fixes the class).

Today the framework conflates these. Both surface as "the pipeline failed" — same notification, same triage path, same blame attribution. This is corrosive to trust: operators who can't tell whether their issue was bad OR the framework broke get suspicious of both.

This RFC defines a **failure-mode taxonomy** that distinguishes these classes, an **automatic routing** mechanism that flows framework-bugs into a bugfix backlog without operator intervention, a **severity scoring** rubric so the right framework bugs get the right urgency, and a **self-improvement loop** that proves the framework is getting more reliable over time.

## 2. Motivation

### 2.1 The Decision Engine's quality contract

VISION.md §4 commits to four properties:

1. Deterministic execution
2. Faithful gating
3. Honest failure modes
4. Self-improvement loop

Today, the framework doesn't measure any of them. There's no way to answer "is the framework getting more reliable?" with data. That's a problem because **trust in the Decision Engine is load-bearing for everything else** — if operators stop trusting that well-framed issues will execute deterministically, they stop frontloading (rationally), and the entire framework collapses to "AI writes code, sometimes."

### 2.2 The witness test was a perfect example

The 2026-05-03 witness test of `cli-orchestrator tick` produced four findings (now AISDLC-174 through 177). Every one was a framework bug, NOT an operator-under-decided issue:

| Finding | Class | Evidence |
|---|---|---|
| AISDLC-174 — DorConfig schema not registered | Framework bug | Pre-existing test failure on main, blocking unrelated branches |
| AISDLC-175 — orphan-parent dispatched | Framework bug | Pre-dispatch filter chain incomplete |
| AISDLC-176 — dev returned prose, work stranded | Framework bug | JSON contract not enforced with retry |
| AISDLC-177 — no rollback on developer-failed | Framework bug | Failure-handling path missing |

If an operator without context received "the orchestrator failed on AISDLC-70," they could rationally conclude EITHER "AISDLC-70 was a bad task" OR "the orchestrator is unreliable." Both conclusions are corrosive. The operator should instead receive: **"the framework misbehaved in 4 documented ways while attempting AISDLC-70; here's the auto-filed bugfix backlog,"** which is actionable AND trust-building.

### 2.3 Today's signal-loss patterns

| Pattern | Signal lost |
|---|---|
| Failure in CI surfaced only as red check + raw log | "What kind of failure?" |
| Stack traces in events.jsonl with no taxonomy | "Is this a known issue?" |
| Same failure repeated across 5 PRs without aggregation | "Are we seeing a regression or coincidence?" |
| Framework-side vs adopter-side ambiguity | "Is this our problem or theirs?" |
| Failures recorded but not auto-routed | "Who's fixing this?" |

The framework knows enough about itself to disambiguate most of these — the data exists in events.jsonl and the playbook handlers. The gap is taxonomy + routing.

## 3. Goals

1. **Failure-mode taxonomy** — every framework failure classified into one of a small number of well-known buckets
2. **Automatic routing** — framework-bug failures auto-create backlog tasks via RFC-0024 capture pattern (`triage: framework-bug`)
3. **Severity scoring** — failures scored on impact (operator-time-cost, blast radius, frequency) so the right bugs get the right urgency
4. **Self-improvement metrics** — operator can answer "is the framework getting more reliable?" with data
5. **Operator transparency** — the operator knows which class of failure they're seeing AT failure time, not later
6. **No silent absorption** — every framework misbehavior is captured; "we'll fix that next time" is not an option
7. **Adopter-safe defaults** — adopters of ai-sdlc inherit the same monitoring without ceremony

## 4. Non-goals

1. **Not a bug tracker** — captures route INTO an existing bugfix backlog (managed by RFC-0024 + standard backlog flow); this RFC doesn't replace tracking infrastructure
2. **Not a SaaS observability surface** — local-first; cross-org telemetry aggregation is a separate concern
3. **Not a remediation engine** — the framework files the bug; humans (or future automated remediation in a follow-up RFC) fix it
4. **Not a perfectionism mandate** — the goal is "operators can trust the framework," not "zero failures." Honest failure handling is the win

## 5. Failure-mode taxonomy

Every framework failure is classified into one of these classes:

### 5.1 `operator-under-decided` (NOT a framework bug)

The issue genuinely lacked a decision the operator should have made upfront. Examples:

- AC list missing the case the failure exposed
- Open question on the DoR comment unanswered
- External dependency declared as `required` but not actually available
- Compliance posture not declared and a regulated path was attempted

**Routing:** Surfaces in the failed task as a clarification request (RFC-0011 Phase 4, `Needs Clarification` status). NOT routed to framework bugfix backlog.

**Self-improvement loop:** If the same operator-under-decided pattern recurs (e.g., 5+ tasks in 30 days fail with "missing AC for null-input case"), the corpus aggregator surfaces it as a candidate for a new DoR Stage A check or a new refinement-reviewer prompt.

### 5.2 `framework-misbehaved` (a framework bug)

The framework violated its own contract. Sub-classes:

| Sub-class | Definition | Example |
|---|---|---|
| `framework-determinism-violated` | Same input produced different outputs | Two dispatches of the same task produce different code |
| `framework-gate-faulty` | A gate passed something it should have failed (or vice versa) | DoR passed a task with no ACs |
| `framework-silent-failure` | An error was swallowed; operator didn't see it | Pre-dispatch filter threw and orchestrator still dispatched |
| `framework-contract-violated` | A documented contract between modules was broken | Dev subagent returned prose when JSON envelope required (AISDLC-176) |
| `framework-sweep-incomplete` | Cleanup didn't run after a failure | Worktree + sentinel left after dev-failed (AISDLC-177) |
| `framework-coverage-gap` | A failure mode not in the playbook | New failure mode the playbook didn't anticipate |
| `framework-perf-regression` | Operation took dramatically longer than baseline | Pipeline tick that historically took 30s now takes 5min |

**Routing:** Auto-creates backlog task via RFC-0024 capture (`triage: framework-bug`); attached to the appropriate framework module's owner; severity-scored per §7.

### 5.3 `ambiguous` (needs operator triage)

The framework can't tell whether the failure is operator-side or framework-side. Examples:

- A flaky test that fails sometimes — could be timing-sensitive code (operator) or test infrastructure (framework)
- A lint rule that fires inconsistently — could be config drift (operator) or rule implementation bug (framework)

**Routing:** Captures with `severity: unknown, triage: tbd`, surfaces in the operator TUI Blockers pane for manual triage. The operator's choice updates the corpus so the framework can learn the pattern.

### 5.4 `external-dependency-failed` (NOT a framework bug)

A dependency outside the framework's control failed. Examples:

- GitHub API outage
- Anthropic API rate-limited
- npm registry returned a corrupt tarball
- Network partition during pull

**Routing:** Captures with `triage: not-actionable` (or `triage: new-task` if it's a recurring dep that warrants a workaround). Severity reflects user-impact (blocking pipeline = major; intermittent retry = minor).

## 6. Detection

The framework detects its own misbehavior at well-known checkpoints. Each checkpoint emits a structured event into `events.jsonl` with the proposed classification:

| Checkpoint | What it checks | Emits |
|---|---|---|
| Step 6 (parse-dev-return) | Did the dev subagent return valid JSON? | `framework-contract-violated` if no, after RFC-0024 retry |
| Pre-dispatch filter chain | Did any filter throw? | `framework-silent-failure` (filter throw should not silently drop dispatch) |
| Step 11 (push-and-pr) | Did push succeed? PR open? | `framework-sweep-incomplete` if PR open but task not flipped to Done |
| Orchestrator tick | Did the tick complete in <5min historical baseline? | `framework-perf-regression` if 3x baseline |
| Playbook handler escalation | Did this match a known mode? | `framework-coverage-gap` if no handler matched |
| Post-merge | Did the same task ship twice? | `framework-determinism-violated` (per AISDLC-104 class) |
| Verifier | Did attestation pass? | `framework-gate-faulty` if attestation valid but reviewer-side test fails on main |

Detection is fail-loud — checkpoints emit even if downstream handling succeeds. The audit trail is the truth.

## 7. Severity scoring

Each framework-bug capture is scored on three axes (auto-computed where possible):

### 7.1 Operator-time-cost

How much operator time the failure costs (per-occurrence + lifetime).

- **High** — operator must manually investigate + remediate (witness test class — the AISDLC-70 commit was stranded, required manual recovery)
- **Medium** — operator must take a single corrective action (re-run, dismiss review, etc.)
- **Low** — operator notices but no action needed (logged, framework recovers)

### 7.2 Blast radius

How many concurrent operations are affected.

- **High** — affects every pipeline run (AISDLC-174 — DorConfig schema regression blocked every coverage gate)
- **Medium** — affects runs touching specific modules
- **Low** — affects only the specific task that triggered

### 7.3 Frequency

How often this class fires.

- **High** — observed >5 times / 7 days
- **Medium** — observed 2-5 times / 7 days  
- **Low** — observed 1 time

The composite severity = max(operator-time-cost, blast-radius) raised by one level if frequency is High. So a low-cost low-blast bug that fires constantly gets bumped to medium urgency.

This composite drives the `priority:` field on the auto-created backlog task and the badge in the operator TUI.

## 8. Self-improvement metrics

The framework MUST be able to answer:

1. **Reliability trend** — is the framework getting more reliable? (Framework-bug captures per pipeline-run, week-over-week)
2. **Mean time to remediation (MTTR)** — once a framework bug is captured, how long until it's fixed?
3. **Recurrence rate** — what fraction of fixed framework bugs recur within 30 days?
4. **Coverage rate** — what fraction of failures got classified vs landed in `ambiguous`?
5. **Operator-time-saved** — estimated operator time saved by auto-routing vs manual triage (counterfactual: what would manual triage have cost?)

Surfaced in the operator TUI Analytics pane (RFC-0023 §10) and in `cli-quality-corpus aggregate` for adopter-side dogfooding.

The reliability trend metric is the primary signal — when it's improving, the framework is honoring its quality contract; when it's flat or declining, that's a signal to invest in framework hardening.

## 9. Integration

### 9.1 With RFC-0015 (autonomous orchestrator)

The orchestrator's playbook handlers (RFC-0015 Phase 2 / AISDLC-169.2) ALL call into the classifier defined here. Currently each handler decides independently whether to escalate; this RFC standardizes the escalation by calling `classifyFailure(error, context)` which returns:

```jsonc
{
  "class": "framework-misbehaved",
  "subclass": "framework-contract-violated",
  "severity": { "composite": "high", "axes": {...} },
  "captureRecord": { /* RFC-0024 schema */ }
}
```

Handlers continue to provide recovery semantics; classification becomes a shared service.

### 9.2 With RFC-0024 (emergent capture)

Every `framework-misbehaved` classification produces an RFC-0024 capture record with `triage: framework-bug`. The capture's `auditTrail` includes the classification result so the operator can see WHY the framework concluded "this is on us."

### 9.3 With RFC-0023 (operator TUI)

The TUI Analytics pane surfaces the self-improvement metrics. The Blockers pane surfaces `ambiguous` failures awaiting operator triage. The Events pane filters can be set to "framework-bugs only" for operators investigating a regression.

### 9.4 With RFC-0011 (DoR gate)

`operator-under-decided` failures route into the existing DoR clarification flow (`Needs Clarification` status). When the same DoR-gap pattern recurs, this RFC's corpus aggregator proposes new DoR checks (operator approves before they ship).

## 10. Adopter inheritance

Adopters of ai-sdlc inherit the failure-mode taxonomy automatically — it's part of the orchestrator's contract. They can:

- Add adopter-specific failure subclasses (must be in a vendor-namespace, e.g., `acme-corp:custom-gate-faulty`)
- Override severity scoring weights for their environment (high-blast-radius means different things for a 10-person startup vs a 1000-engineer org)
- Disable specific checkpoints (with operator override + audit reason)
- Pipe captures to their own bug-tracker via the RFC-0024 capture corpus subscriber

Defaults are conservative — every checkpoint enabled, severity weights tuned for dogfood-scale.

## 11. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 — Taxonomy + classifier API | `classifyFailure()` function, taxonomy schema, unit tests against witness-test scenarios | 1 week |
| 2 — Detection checkpoints | Wire classifier into orchestrator playbook + Step 6 + Step 11 + filter chain | 1 week |
| 3 — Auto-routing via captures | Integration with RFC-0024 capture writer (gated on RFC-0024 Phase 1+2 shipping first) | 4–5 days |
| 4 — Severity scoring | Composite severity computation, priority assignment on auto-created tasks | 4 days |
| 5 — Self-improvement metrics | `cli-quality-corpus aggregate`, TUI Analytics integration | 1 week |
| 6 — Adopter inheritance + soak | Adopter override surface, hybrid promotion runbook | 2 weeks soak + 4 days runbook |

Total: ~5–6 weeks wall-clock; sequenced after RFC-0024 Phases 1+2 (which must ship first).

## 12. Feature flag

`AI_SDLC_FRAMEWORK_QUALITY_MONITORING=experimental`. Off by default for adopters during the soak window. When on, classifier runs on every failure; auto-routing only fires when both this flag AND `AI_SDLC_EMERGENT_CAPTURE` are on.

## 13. Open questions — resolved (operator walkthrough 2026-05-15)

> **Implementation Status (2026-05-15):** The 10 OQs below were resolved by operator walkthrough on 2026-05-15. Lifecycle promoted `Draft → Ready for Review`. AISDLC-270 / PR #481 was filed 2026-05-13 against the as-yet-unresolved OQs and **paused by the operator before merge**; that PR's diff requires audit against the now-resolved OQs (AISDLC-300 + a follow-up audit task) before the implementation can be unblocked, refit, or rejected.
>
> **What ships today (partial — pre-OQ-walkthrough):**
> - `pipeline-cli/src/tui/analytics/quality-reader.ts` — reads `_quality/captures.jsonl`, computes reliability trend (the §8 primary signal).
> - `pipeline-cli/src/orchestrator/playbook/handlers/` — 9 catalogued failure-mode handlers implementing the spirit of the §3 failure-mode taxonomy.
>
> **What's pending (post-OQ-walkthrough):** Implementation of the resolved OQs — see §13.1 Quality Monitoring Configuration Defaults for the normative config schema. PR #481 was the candidate impl; pending audit may shift to a refit chain or rebuild.

The following normative answers were established by operator walkthrough on **2026-05-15**:

**OQ-1 — Default classification when ambiguous:** When the classifier can't decide between `operator-under-decided` and `framework-misbehaved`, default to `ambiguous` (operator triages) or default to `operator-under-decided` (less alarming) or default to `framework-misbehaved` (more alarming, more honest)? Recommendation: `ambiguous` — preserves operator agency while honest about uncertainty.

   **Resolution (2026-05-15):** **Confidence-bucketed classification** with three tiers. High-confidence (≥ 0.7): auto-classify into `operator-under-decided` or `framework-misbehaved`. Mid-confidence (0.3–0.7): `ambiguous` (operator triages). Low-confidence (< 0.3): unclassified, log only. Per-org thresholds configurable in `quality-monitoring.yaml`. Composes with the shared classifier substrate (RFC-0024 Refit Phase 2 / AISDLC-274) and RFC-0035 Phase 5 / AISDLC-289. **Selected over `ambiguous`-only** because tiered is the industry pattern (Datadog/Sentry); composes architecturally with the shared classifier substrate; lets operators tune the noise floor per-org.

**OQ-2 — Severity weight tuning surface:** Operators can override severity weights per §10. Should this be a YAML resource (`.ai-sdlc/quality-monitoring.yaml`) or CLI flags? Recommendation: YAML resource — discoverable, version-controlled, validatable.

   **Resolution (2026-05-15):** **YAML resource + CLI flag override.** Durable per-org config in `.ai-sdlc/quality-monitoring.yaml` (matches `capture-config.yaml` / `decisions-config.yaml` convention from RFC-0024 / RFC-0035). One-shot debugging override via `--severity-weight axis=value` flag on relevant CLIs. **Selected over YAML-only** because debugging-via-one-shot-override is a real ergonomic; the cost of the additional flag surface is small.

**OQ-3 — Recurrence detection window:** §8 metric "recurrence rate within 30 days" — is 30 days the right window? Could be 7 (more sensitive to flapping) or 90 (more lenient on rare regressions). Recommendation: 30 days as default, configurable.

   **Resolution (2026-05-15):** **Multi-window simultaneously: 7d / 30d / 90d** (Sentry pattern). Each window answers a different operational question: 7d = flap detection; 30d = standard recurrence; 90d = legacy regression. All three computed and surfaced in metric output + TUI + Slack digest. Per-org configurable in `quality-monitoring.yaml`. **Selected over 30d-only** because the flap-vs-regression distinction is operationally important enough to justify three numbers per failure mode; compute cost is trivial (3× the same query).

**OQ-4 — Framework-bug attribution to module owners:** Auto-created framework-bug tasks could include the suspected module owner as `assignee`. Auto-attribute or leave unassigned? Recommendation: auto-attribute via CODEOWNERS file (heuristic, often wrong but useful starting point).

   **Resolution (2026-05-15):** **Per-org configurable; default suggest-only** (Sentry pattern). Default = surface top-3 candidates from CODEOWNERS in TUI + Slack DM; operator confirms assignment. Per-org override via `quality-monitoring.yaml` (`autoAttribute: true`) flips the default to force-assign. **Selected over auto-attribute-via-CODEOWNERS** because the cost of wrong-assignment is higher in small teams (where suggest-only is fine) and small teams are the default profile; larger teams that need accountability force opt in via the toggle. Avoids the LinkedIn-postmortem "owner blame" anti-pattern.

**OQ-5 — Adopter telemetry opt-in:** Should adopters' framework-bug counts (anonymized) optionally roll up to a framework-maintainer dashboard so the framework team learns which classes hit production? Recommendation: opt-in only, with clear disclosure of what's shared (counts, classes, no payload contents).

   **Resolution (2026-05-15):** **Operator-initiated, pre-filled GitHub issue** (no telemetry pipeline). When the framework detects a `framework-bug` classification, it pre-generates an issue body (anonymized repro, classifier output, suggested fix, related code paths) and surfaces a `cli-quality report-upstream <bug-id>` command + TUI prompt. The command opens the browser to `https://github.com/<framework-repo>/issues/new?body=<pre-filled>` — operator reviews, edits, and submits manually. Composes with the RFC-0024 capture-then-submit lifecycle pattern (this is "submit upstream" instead of "submit team-internal"). **Selected over opt-in telemetry** because pull-based reporting is fully transparent (operator sees exactly what's filed), zero infrastructure cost (no telemetry servers, schemas, or GDPR/Schrems II surface), and matches modern OSS reporting convention (`bun --report-bug`, VS Code "Report Issue", Rust panic handler's "consider reporting at github.com/...").

**OQ-6 — Coverage-gap response:** When the playbook hits `framework-coverage-gap` (a failure mode the playbook didn't anticipate), should the framework auto-quarantine the work AND auto-file an RFC for adding the new mode, or just log and let operator decide? Recommendation: auto-quarantine + auto-file backlog task (not RFC — RFC requires more thought; the task can graduate).

   **Resolution (2026-05-15):** **Auto-quarantine + auto-file capture record** (composes with RFC-0024). Coverage gap = a capture with `source: framework-coverage-gap` + `triage: tbd`. Operator triages via the existing RFC-0024 rubric (§7) → `quick-fix-task` / `new-issue` / `new-feature-issue` / `scope-creep`. If gaps cluster, RFC-0024 §15.1 stale-ladder + OQ-6 rate-ceiling handle the load. **Selected over auto-file-backlog-task or auto-file-RFC** because it reuses an existing operator workflow (no new artifact type) and the capture lifecycle's per-org configurability handles flood control.

**OQ-7 — Determinism violation: how to detect:** §6 mentions detecting `framework-determinism-violated` post-merge. The mechanism (re-run + diff?) is expensive. Should detection be sampled (e.g., 1 in 50 dispatches) or always? Recommendation: sampled (1 in 50) for cost; always for tasks the operator marks `requires-determinism: true`.

   **Resolution (2026-05-15):** **Composite sampling**: default rate 1-in-50 + always-on for `requires-determinism: true` tasks + always-on for top-decile blast-radius (composes with RFC-0014 dep-graph snapshot). Per-org override in `quality-monitoring.yaml`. **Selected over pure-sampled** because risk-based concentration via blast radius matches the framework's deterministic-first preflight ladder (RFC-0035 §5) and the cost of missing a high-blast-radius determinism violation is operationally far higher than missing a low-blast one.

**OQ-8 — MTTR computation:** §8 metric "mean time to remediation." Should the clock start at first occurrence or first capture? Recommendation: first capture (operationally meaningful — when did the framework KNOW vs when did it happen).

   **Resolution (2026-05-15):** **MTTR clock from first capture; MTTD as v2 follow-up.** Phase 5 of RFC-0025 impl ships MTTR-from-first-capture (unambiguous, measurable). MTTD added when first-occurrence inference is reliable (e.g., when determinism-detection sweep + bisect can anchor "first occurrence" to a specific commit). Output labeled clearly as "MTTR (from first capture)" to avoid misinterpretation. **Selected over splitting MTTD + MTTR from day 1** because imperfect first-occurrence inference would contaminate the metric; ship the unambiguous version first.

**OQ-9 — Operator-time-cost estimation:** §7.1 "operator-time-cost" rubric is qualitative. Should the framework attempt to measure (e.g., elapsed time from failure event to operator-action event)? Recommendation: yes, instrument from operator TUI interactions; surface as data alongside the qualitative bucket.

   **Resolution (2026-05-15):** **Instrument from TUI events.** Compute elapsed-time from `OrchestratorBlockedByX` events to `OperatorActionTaken` events using the existing RFC-0015 `events.jsonl` substrate. Surface in §7 severity rubric output + feed RFC-0035 §7 operator-fatigue signal (composition opportunity). Per-org configurable AFK noise filter (`afkInactivityMinutes` default 30 — skip elapsed-time on inactivity gaps > N minutes). **Selected over qualitative self-report** because instrumentation is industry standard (Sentry/Linear/PagerDuty/Datadog all instrument); local-only data (no telemetry); the AFK filter handles operator-walked-away noise.

**OQ-10 — Vendor-namespace enforcement:** §10 says adopter custom subclasses must be vendor-namespaced. How is this enforced? Recommendation: schema validation rejects un-namespaced custom subclasses on resource load.

   **Resolution (2026-05-15):** **Schema validation rejects un-namespaced custom subclasses on resource load.** Custom failure-mode subclasses MUST use vendor reverse-DNS prefix (e.g., `acme.com/security-policy-violation`); un-prefixed names produce a clear error at resource load. Matches Kubernetes CRD / npm scoped package / Go module convention. **Selected over warn-only or no-enforcement** because lenient enforcement post-launch is much harder than strict-then-relax; the framework hasn't shipped this surface yet so there are no adopters to break.

### 13.1 Quality Monitoring Configuration Defaults

Per-organization configurability is mandatory across all OQ resolutions. Quality-monitoring shipping defaults are calibrated for small-to-medium dogfood teams; adopters override via `.ai-sdlc/quality-monitoring.yaml`:

```yaml
quality:
  classifier:                        # OQ-1 — confidence-bucketed
    confidenceThresholds:
      autoClassify: 0.7              # high-conf: auto-classify into operator-under-decided or framework-misbehaved
      ambiguous: 0.3                 # mid/low boundary; below 0.3 = unclassified, log only

  severity-weights:                  # OQ-2 — overridable per-axis
    operator-time-cost: 1.0
    framework-recurrence: 1.0
    blast-radius: 1.0

  recurrence-windows:                # OQ-3 — multi-window simultaneously
    - 7d                             # flap detection
    - 30d                            # standard recurrence
    - 90d                            # legacy regression

  framework-bug:                     # OQ-4 — default suggest-only
    autoAttribute: false
    attributionSources: [codeowners] # extensible to git-blame, recent-pr in v2
    suggestionCount: 3

  upstream-reporting:                # OQ-5 — operator-initiated, pre-filled
    repoUrl: ""                      # adopter sets per-framework-version
    prefilledIssueTemplate: ".ai-sdlc/templates/framework-bug-report.md"

  coverage-gap:                      # OQ-6 — composes with RFC-0024
    autoQuarantine: true
    fileCapture: true                # capture record with source: framework-coverage-gap, triage: tbd

  determinism-detection:             # OQ-7 — composite sampling
    defaultSampleRate: 0.02          # 1 in 50 baseline
    alwaysOnRequiresDeterminism: true
    alwaysOnTopBlastRadiusDecile: true
    blastRadiusSource: rfc-0014-deps-snapshot

  metrics:
    mttr:                            # OQ-8 — first-capture clock
      clockStart: first-capture
      v2-mttd:                       # add when first-occurrence inference reliable
        enabled: false
    operator-time-cost:              # OQ-9 — instrumented from TUI events
      afkInactivityMinutes: 30

  vendor-namespace:                  # OQ-10 — strict enforcement
    enforce: reject                  # other options: warn (deprecated), none (deprecated)
```

Default constants ship in the `ai-sdlc init` quality-monitoring template. Auto-tuning from observed corpus throughput is future work (composes with RFC-0035 calibration loop); operator-configurable from day one.

## 14. Sign-off

Per `project_team_roles.md`:

| Owner | Role | Status | Date |
|---|---|---|---|
| Dominique Legault | CTO / Engineering Authority + AI-SDLC Operator | ⏳ Pending walkthrough | — |
| Alexander Kline | Product Lead | ✅ Signed v0.1 | 2026-05-04 |

Lifecycle: Draft → Ready for Review (after OQ walkthrough) → Signed Off (after all owners sign).

### Product Authority review

**Endorse with calibration note**: the distinction between `operator-under-decided` (DoR-side fix) and `framework-misbehaved` (framework-side fix) is structurally important for PPA's calibration loop.

**Critical PPA composition concern**: a bad score caused by a framework bug is not evidence of a bad scoring model. When RFC-0025's failure taxonomy identifies a framework failure, the corresponding scoring decision MUST be excluded from CK calibration data. Otherwise the flywheel learns from noise — the calibration loop trains itself to compensate for framework bugs rather than to score better.

**Implementation suggestion**: a one-bit flag on the calibration log entry (`frameworkFailureExcluded: true`) rather than a separate routing pipeline. Keeps the data simple. The calibration aggregator decides whether to honor the flag at aggregation time. RFC-0025's existing taxonomy provides the trigger.

**Composition with RFC-0033 governance reporting**: framework-failure-mode counts feed RFC-0033's `quality.dorCommonFailures` — but distinguished as a separate row (`framework.failureModes`) so operators can see at a glance which 5% slice is operator-under-decided vs framework-misbehaved.

**Composition with RFC-0024 emergent capture**: framework failure events flow into the bugfix backlog via RFC-0024's emergent-capture pattern (already specified in RFC-0025 §5). Endorse.

**Composition with RFC-0030 demand clusters**: framework-failure-mode patterns shouldn't feed D1 demand pressure (they're not customer signal); the clusters explicitly exclude `framework-bug` source-tagged items. Recommend explicit exclusion clause when RFC-0030 ships.

Position grounded in RFC-0029 Principle 5 (governance by composition; orthogonal axes have orthogonal remediations).

## 15. References

- [VISION.md](../../VISION.md) §4 (quality contract) — anchoring philosophy
- [RFC-0011 — Definition of Ready Gate](RFC-0011-definition-of-ready-gate.md) — operator-under-decided routing
- [RFC-0015 — Autonomous Pipeline Orchestrator](RFC-0015-autonomous-pipeline-orchestrator.md) — playbook handler integration
- [RFC-0023 — Operator TUI](RFC-0023-operator-tui-pipeline-monitoring.md) — Analytics pane surfaces self-improvement metrics
- [RFC-0024 — Emergent Issue Capture + Triage Pattern](RFC-0024-emergent-issue-capture-and-triage.md) — `triage: framework-bug` routing pipe

## 16. Revision history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-05-03 | dominique@reliablegenius.io | Initial draft seed; 10 open questions |
| v0.2 | 2026-05-15 | dominique@reliablegenius.io | Operator OQ walkthrough resolved all 10 OQs (§13). Resolutions: confidence-bucketed classifier (OQ-1), YAML+CLI override (OQ-2), multi-window recurrence (OQ-3), per-org-configurable suggest-only attribution (OQ-4), operator-initiated pre-filled GitHub issue for upstream reporting (OQ-5; replaces telemetry pipeline), capture-record-based coverage-gap response (OQ-6), composite blast-radius sampling for determinism (OQ-7), first-capture MTTR with MTTD as v2 (OQ-8), instrumented operator-time-cost (OQ-9), strict reject for un-namespaced subclasses (OQ-10). Added §13.1 Quality Monitoring Configuration Defaults (consolidated config schema + defaults + per-org override convention). Lifecycle promoted Draft → Ready for Review. PR #481 (AISDLC-270 candidate impl) flagged for audit against the resolved OQs before unblock/refit/rebuild decision. |
