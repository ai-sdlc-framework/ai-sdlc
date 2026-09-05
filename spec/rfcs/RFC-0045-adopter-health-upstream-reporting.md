---
id: RFC-0045
title: Adopter Health Reporting — Upstream Feedback Loop for Config-Audit Findings
status: Draft
lifecycle: Draft
author: Dominique Legault
created: 2026-09-05
updated: 2026-09-05
specVersion: v1alpha1
# Design-contract dependencies (assumes: reads as contract, does NOT code-import):
#   RFC-0025 — establishes the anonymized, opt-in, operator-submitted pre-filled
#              GitHub issue pattern this RFC extends for a new payload kind.
#   RFC-0022 — compliance-evidence anonymization + export conventions to mirror.
assumes: [RFC-0025, RFC-0022]
requiresDocs: []
---

# RFC-0045: Adopter Health Reporting — Upstream Feedback Loop for Config-Audit Findings

**Status:** Draft — problem framing + design sketch + Open Questions for operator walkthrough. This RFC defines the OPTIONAL upstream-reporting layer on top of the local `ai-sdlc doctor` command (AISDLC-578). Per the 2026-09-05 operator decision, the doctor command ships FIRST as a purely local audit; this RFC governs the separate, consent-gated channel that carries doctor findings back to the ai-sdlc project so maintainers gain visibility into how the framework is configured and used across adopters. Nothing here authorizes automatic phone-home — the shipped baseline (RFC-0025) is manual, anonymized, and opt-in, and this RFC's default MUST NOT be more aggressive than that without an explicit resolved Open Question.

## Summary

`ai-sdlc doctor` (AISDLC-578) audits an installed adopter project's `.ai-sdlc/` config, runtime/plugin versions, and workflow wiring, and reports misconfigurations locally. This RFC adds an OPTIONAL, consent-gated path for those findings (and anonymized usage signal) to flow **upstream** to the ai-sdlc project, so maintainers can answer the question we currently cannot: *of the people running ai-sdlc daily, how many are misconfigured, and which misconfigurations are most common?* Today there is **zero** downstream→upstream channel — GitHub stars/forks/watchers are the only signal, and they measure nothing about install health. The design extends RFC-0025's already-shipped, deliberately-manual "anonymized pre-filled GitHub issue" pattern rather than introducing a telemetry beacon.

## Motivation

- **Silent misconfiguration is the dominant adopter failure mode.** In a single 2026-09-05 session the framework itself hit three config-drift classes (runtime-dependency pins, plugin-version lag, release-pin `^0.x` caret drift). For an adopter these fail *silently* — a false-rejected attestation, a frozen runtime — with no signal to the user or to us.
- **We have no visibility.** 103 stars / 28 forks / 7 watchers tell us nothing about install count, version distribution, or config health. We cannot prioritize adopter-facing fixes because we cannot see which misconfigurations are actually biting real users.
- **The project has a principled anti-telemetry stance we must honor.** RFC-0025 (Implemented) explicitly *rejected* a telemetry pipeline in favor of an operator-initiated, path/token/email-anonymized, pre-filled GitHub issue the human reviews and submits (`cli-quality report-upstream`, `repoUrl` empty by default). Any upstream reporting for doctor findings MUST be at least as conservative.
- **The feedback loop is the point.** Correct, timely feedback from downstream users on how the system performs for them is what lets the framework improve for adopters — the strategic priority (project positioning shift toward adoption).

## Goals

1. Give maintainers aggregate visibility into adopter config-health and common misconfigurations, sourced from `ai-sdlc doctor` findings.
2. Make reporting **opt-in and consent-gated** at every send, with the user able to see exactly what would be transmitted before it leaves their machine.
3. **Anonymize by construction** — no repo paths, home paths, tokens, emails, branch names, or proprietary content ever leave the machine.
4. Reuse RFC-0025's shipped anonymize→render→operator-submits flow rather than building a new transport.
5. Prevent tracker self-DoS — N adopters must not each auto-file the same finding.
6. Support a periodic cadence (nudge, not force) so health is checked over time, not just once at init.

## Non-Goals

- **No automatic/background phone-home.** This RFC does not authorize any unattended network send. (An OQ may propose a stricter-reviewed aggregated-endpoint option, but the default stays manual.)
- **No collection of code, diffs, PR content, or identifying metadata.** Only anonymized config-shape + finding identifiers.
- **Not a replacement for `ai-sdlc doctor`.** Doctor is local and ships independently (AISDLC-578). This RFC is purely the optional reporting layer on top.
- **No new required config.** Reporting stays off until an adopter explicitly enables it.

## Proposal

Extend the `ai-sdlc doctor` typed result set with a reporting layer that reuses RFC-0025's pipeline:

1. **`ai-sdlc doctor --report-upstream`** — takes the local finding set, runs it through the RFC-0025 anonymizer, renders a **pre-filled GitHub issue** (finding ids + severities + framework version + anonymized config shape; NO paths/tokens/emails/branch names), shows the operator the exact body, and opens the browser to `<repoUrl>/issues/new?...`. The human submits. `repoUrl` defaults to the ai-sdlc project and is overridable/disable-able in `.ai-sdlc/` config; reporting is OFF unless the operator runs the flag or opts in.
2. **Anonymized finding schema** — a stable `{ checkId, severity, frameworkVersion, pluginVersion, configShape }` record where `configShape` is a booleans/enums-only fingerprint (e.g. `attestationEnabled: true`, `dorMode: enforce`) with zero free-text.
3. **Dedup / anti-DoS** — a per-finding fingerprint + local "already reported this fingerprint at this version" ledger so re-runs don't re-file; and (design decision, see OQ) a strategy that prevents N adopters filing N identical issues (e.g. search-existing-and-comment, or aggregate).
4. **Periodic cadence** — the existing SessionStart hook (or a documented CI/cron cadence) *nudges* the operator to run `doctor` when the last audit is stale; it never sends anything itself.

## Design Details

### Schema Changes

- New anonymized `HealthReport` payload kind (booleans/enums + finding ids only), defined alongside the doctor typed result set (AISDLC-578) and validated so no free-text field can carry identifying data.
- Optional `.ai-sdlc/` config block (extends the RFC-0025 `quality-monitoring.yaml` precedent or a sibling): `reporting.enabled` (default false), `reporting.repoUrl`, `reporting.cadenceDays`.

### Behavioral Changes

- `ai-sdlc doctor` gains `--report-upstream` (and the SessionStart nudge when a stale-audit + reporting-opted-in condition holds). No behavior change when reporting is disabled (the default).

### Migration Path

- Purely additive and opt-in. Existing adopters see no change until they enable reporting. No migration required.

## Backward Compatibility

Fully backward compatible — the reporting layer is off by default and additive to AISDLC-578's local doctor. Projects that never enable it behave exactly as before.

## Alternatives Considered

### Alternative 1: Automatic telemetry beacon
An unattended background send of anonymized health pings to an ai-sdlc-owned endpoint. Rejected as the DEFAULT: contradicts RFC-0025's shipped, deliberate anti-telemetry decision and the project's adopter-trust posture. May be revisited only as an explicitly-resolved, separately-consented Open Question (OQ-1/OQ-3), never as the baseline.

### Alternative 2: Do nothing (status quo)
Rely on adopters manually opening issues when something breaks. Rejected: this is exactly today's state — it gives no proactive visibility and biases the signal toward loud failures, missing silent misconfiguration entirely.

## Implementation Plan

Gated on AISDLC-578 (local doctor) landing first, and on operator resolution of the Open Questions below (consent/cadence/transport/dedup). Phases to be generated as backlog tasks after the OQ walkthrough per project convention.

1. Anonymized `HealthReport` schema + anonymizer reuse from RFC-0025.
2. `--report-upstream` render+submit flow (pre-filled issue).
3. Dedup ledger + anti-DoS strategy (per resolved OQ).
4. Periodic-nudge wiring (SessionStart / documented CI cadence).
5. Docs: adopter runbook + explicit privacy statement of exactly what is/ isn't sent.

## Open Questions

> These are the genuinely-forked, regret-prone decisions. They MUST be resolved by
> the operator via the decision-rubric walkthrough before implementation tasks are
> generated (per AISDLC-298 — no inline OQ resolution by developers).

- **OQ-1 — Consent model.** Per-send confirmation every time (strongest, RFC-0025 baseline) vs a one-time "enable reporting" opt-in that then reports without re-confirming each run (lower friction, higher trust cost)? Default MUST NOT exceed RFC-0025's manual baseline absent a resolution here.
- **OQ-2 — Cadence / trigger.** Manual-only (`--report-upstream` when the operator chooses) vs a SessionStart *nudge* when the last audit is stale vs a CI cadence. Nudge-not-send is the presumptive answer; confirm.
- **OQ-3 — Transport.** Pre-filled GitHub issue the human submits (RFC-0025 pattern, zero infra) vs an aggregated ping to an ai-sdlc-owned endpoint (better analytics, but reintroduces the telemetry surface RFC-0025 rejected) vs a single dedup'd issue-per-repo. Recommend the pre-filled-issue pattern for v1.
- **OQ-4 — Anti-DoS / dedup.** How to stop N adopters filing N identical issues: search-existing-issue-and-+1 vs aggregate-then-summarize vs a maintainer-side intake bot that dedups by fingerprint. This is the load-bearing operational decision — an un-deduped design DDoSes the project's own tracker.
- **OQ-5 — Payload scope.** Exactly which fields leave the machine, and how the anonymizer is proven correct (a hermetic test asserting no path/token/email/branch can appear). Enumerate the whitelist; default-deny everything else.
- **OQ-6 — Default repoUrl.** Ship pointing at the ai-sdlc project (with visible opt-out) vs empty-by-default (RFC-0025's choice, requires explicit opt-in). The empty default is more conservative; the project-default gathers more signal. Trade adoption-signal against consent-purity.

## References

- RFC-0025 — Framework Quality Monitoring (the shipped anonymized, opt-in, operator-submitted pre-filled-issue pattern this RFC extends).
- RFC-0022 — Compliance Posture + Audit Surface (anonymization + export conventions).
- AISDLC-578 — `ai-sdlc doctor` local config-health audit (the data source; ships first, independently).
- 2026-09-05 session — three config-drift classes (runtime pins, plugin-version lag, release-pin caret drift) motivating proactive adopter-health visibility.

## Sign-Off

Sign-off is per-pillar and operator-driven; do not pre-fill. Owners sign after the OQ walkthrough.

| Pillar | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ⏸ Pending |
| Product | Alex | ⏸ Pending |
| Operator | Dominique Legault | ⏸ Pending |
