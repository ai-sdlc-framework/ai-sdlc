---
id: AISDLC-173
title: 'RFC-0022: Compliance Posture + Audit Surface — draft + reserve in registry'
status: Done
assignee: []
created_date: '2026-05-03'
labels:
  - spec
  - governance
  - rfc-process
  - compliance
dependencies: []
references:
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reserve RFC-0022 in the registry per AISDLC-165 governance and ship the initial RFC draft for "Compliance Posture + Audit Surface."

The framework today carries a number of compliance-adjacent surfaces (DSSE attestation per AISDLC-74/146, trusted-reviewers allowlist per AISDLC-152, secret-pattern matchers per AISDLC-128, DoR calibration per RFC-0011, dependency-graph drift gate per RFC-0014) but no unified compliance-posture declaration. The gap surfaced explicitly during the RFC-0009 OQ-11 walkthrough on 2026-05-04 — the operator asked "do we track anywhere what regulatory compliances we adhere to?" and the honest answer was "nowhere; you'd just remember."

RFC-0022 introduces a `CompliancePosture` resource (`.ai-sdlc/compliance.yaml`) where adopters declare applicable regulatory regimes (HIPAA, SOC2-T2, PCI-DSS-L1, GDPR, FedRAMP-Moderate, ISO-27001:2022). The framework derives gate defaults from the declared regimes (database-branch pool isolation per RFC-0009 OQ-11, secret-scan strictness, attestation requirement, audit-log retention, reviewer-authority model) using "tightest constraint wins" composition semantics. Operators may override any derived gate but only with `attestedNotes` rationale. A new `cli-compliance-audit export` CLI bundles audit evidence (DSSE envelopes, DoR calibration, trusted-reviewer changes, enforcement events, access-control changes) for a date range into a deterministic, content-addressable `.tar.gz`.

The structural template is RFC-0019's adapter-framework document layout (frontmatter + 16 sections including Sign-Off, Revision History, 7 open questions). Default adapter-equivalent here is the "(none declared)" baseline posture (= today's behavior; no derived-gate change for existing projects).

The RFC ships with 7 open questions for operator walkthrough; each carries a lean to enable Phase 1 implementation work to begin without blocking on every OQ resolution.

Note on registry numbering: RFC-0020 and RFC-0021 are reserved for separate in-flight RFCs (OQ-7 carve-outs — session-bug severity and incident monitoring) that have not yet landed on main. Per task spec, this PR reserves RFC-0022 only and leaves "Next available number" at RFC-0020 so the next RFC author can pick up the gap.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 RFC-0022 file exists at `spec/rfcs/RFC-0022-compliance-posture-audit-surface.md` with full structure (frontmatter + 16 sections including Sign-Off, Revision History, 7 open questions)
- [x] #2 Registry table in `spec/rfcs/README.md` includes RFC-0022 row (Status: Draft, Lifecycle: Draft, Author: Dominique Legault, File link, Notes explaining the regime → DerivedGates pattern + RFC-0020/21 reservation context)
- [x] #3 "Next available number" line in registry remains RFC-0020 (RFC-0020/21 reserved for separate in-flight OQ-7 carve-outs; not touched in this PR)
- [x] #4 RFC frontmatter declares `requires: [RFC-0008, RFC-0011]` (admission composite + DoR change-management discipline)
- [x] #5 Drift check exits 0 (`backlog-drift check`)
- [x] #6 Format check exits clean (`pnpm format:check`)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two-file edit: new `spec/rfcs/RFC-0022-compliance-posture-audit-surface.md` (full RFC body, ~600 lines) + amend `spec/rfcs/README.md` registry table (one row added; "Next available number" line untouched per OQ-7 carve-out semantics).

- **Structural template**: mirrored RFC-0019's section layout. §1 summary, §2 motivation (4 sub-sections including the 2026-05-04 OQ-11 walkthrough trigger), §3 goals/non-goals, §4 architecture (4-component diagram), §5 the CompliancePosture resource with TypeScript declarations + mandatory `attestedBy` rationale, §6 regime → DerivedGates mapping table + tightest-wins composition + override-with-notes semantics, §7 init wizard integration including OQ-11-specific DB-pool default-flip behavior, §8 audit evidence export CLI with bundle layout + idempotency contract, §9 4-phase implementation plan, §10 schema changes, §11 backward compatibility, §12 alternatives considered (6 rejected/deferred patterns), §13 7 open questions with leans, §14 references, §15 sign-off, §16 revision history.
- **Regime mapping default leans**: HIPAA / PCI-DSS / FedRAMP REQUIRE per-shard DB pool; SOC2-T2 / ISO-27001 RECOMMEND it; GDPR conditional on EU residency; "(none declared)" stays on shared-with-rls. Secret scan ordinal max wins. Retention max wins (7y for HIPAA dominates).
- **Operator override surface**: mandatory `attestedNotes` per overridden field. Schema places notes in a sibling `_notes` map keyed by field name to preserve override-value typing. Loader refuses postures with override-without-notes (Q2 lean).
- **Audit export idempotency**: bundle is content-addressable; same period + same evidence → byte-identical `.tar.gz`. Same sha256-of-sha256s pattern AISDLC-146 uses for DSSE contentHashV3.
- **OQ-11 integration**: init wizard reads compliance.yaml in the gate-config step and pre-selects the DB-pool default. Collapses two operator decisions (compliance posture + DB pool) into one (compliance posture; DB pool follows).
- **Registry numbering decision**: per task spec, reserve RFC-0022 specifically (operator pre-allocated it for compliance work) and leave next-available at RFC-0020 since RFC-0020/21 are separate in-flight OQ-7 carve-outs not yet landed. Registry now has a deliberate gap (0019, 0022, next=0020).
- **7 open questions**: Q1 mapping location, Q2 override audit, Q3 control mapping source, Q4 export format, Q5 monitoring vs export, Q6 multi-tenant composition, Q7 PR-template discipline. Each carries a lean so Phase 1 work isn't blocked on every OQ resolution.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Reserved RFC-0022 in the canonical registry and shipped the initial Draft of the Compliance Posture + Audit Surface spec, mirroring RFC-0019's adapter-framework document layout. Closes the gap surfaced during the RFC-0009 OQ-11 walkthrough — adopters can now declare regulatory posture (HIPAA / SOC2 / PCI-DSS / GDPR / FedRAMP / ISO-27001 / etc.) in `.ai-sdlc/compliance.yaml`, framework derives gate defaults via "tightest wins" composition, and `cli-compliance-audit export` bundles auditor-ready evidence into a deterministic `.tar.gz`.

## Changes
- `spec/rfcs/RFC-0022-compliance-posture-audit-surface.md` (new): 16-section RFC with TypeScript interface declarations for CompliancePosture / Regime / DerivedGates / AuditExportSpec, regime → DerivedGates mapping table covering 6 regimes plus "(none declared)" baseline, init-wizard UX sketch with OQ-11-specific DB-pool default-flip, audit-export CLI specification with bundle layout + idempotency contract, 4-phase implementation plan, 7 open questions with leans.
- `spec/rfcs/README.md` (modified): added RFC-0022 row to registry table; "Next available number" line preserved at RFC-0020 per OQ-7 carve-out semantics (RFC-0020/21 reserved for separate in-flight RFCs).

## Design decisions
- **Mirror RFC-0019's structural template**: gives the framework a consistent RFC document shape; operators reading one know the layout of the others.
- **Mandatory `attestedBy` on every regime declaration**: compliance regimes are legal claims; framework MUST NOT let an operator silently declare HIPAA coverage without recording who said so.
- **"(none declared)" baseline = today's pre-RFC-0022 behavior**: zero-impact backward compatibility; existing pipelines without `.ai-sdlc/compliance.yaml` continue to function unchanged.
- **Tightest-constraint-wins composition for multi-regime**: mirrors RFC-0009 OQ-2's `min` semantics; intuitive for operators ("the strictest applicable rule wins").
- **Operator override requires `attestedNotes`**: deviation from framework leans is fine but must be audit-traceable; `_notes.<field>` schema keeps override values typed while making rationale mandatory.
- **JSONL-friendly evidence kinds**: every audit-export kind already lives in JSONL format (DSSE envelopes, calibration, enforcement events) or git history; no new storage substrate required.
- **On-demand export over continuous monitoring for v1**: continuous monitoring is a real adopter ask but adds event-streaming + alert-routing infrastructure the framework doesn't have today; defer to a future RFC layered on the same posture substrate.
- **Registry gap (0019 → 0022, next=0020)**: deliberate per task spec — RFC-0020/21 are pre-reserved for separate in-flight OQ-7 carve-outs (session-bug severity, incident monitoring); next RFC author picks up the gap.

## Verification
- `pnpm format:check` — clean
- `npx backlog-drift@0.1.3 check` — exit 0

## Follow-up
- Operator walks through 7 open questions in §13; flip lifecycle to Ready for Review after resolution.
- Phase 1 implementation tasks (orchestrator/src/compliance scaffolding + loader + JSON Schema + "(none declared)" baseline) gated on RFC-0022 sign-off; create AISDLC-173.1 through 173.4 sub-task tree at that point.
- Coordinate with RFC-0009 author so OQ-11 DatabaseBranchPool default consumes `posture.spec.derivedGates.databaseBranchPool` once both RFCs reach Phase 3.
- RFC-0020 and RFC-0021 reservations remain pending; the next RFC update PR (RFC-0009 OQ-7 follow-on) should claim those slots.
