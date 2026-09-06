---
id: AISDLC-585
title: >-
  Deprecate attestation schema versions v3/v4/v5 — warn on sign now, plan
  removal via RFC-0042 amendment
status: To Do
assignee: []
created_date: '2026-09-06 04:07'
labels:
  - attestation
  - pipeline-cli
  - deprecation
  - rfc-0042
dependencies: []
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Directive
Operator (2026-09-06): "mark the previous signing signature versions less than v6 as deprecated and no longer support them soon."

## Current state
- **v6 is the default** signing schema (RFC-0042, since AISDLC-409). v3/v4/v5 signing is opt-in via `--schema-version v5` / `AI_SDLC_V5_LEGACY=1`.
- Per CLAUDE.md + RFC-0042 **OQ-7**, the v3/v4/v5 **verifier** code is retained READ-ONLY specifically so every historical PR remains auditable. Removing verify support breaks auditability of already-merged PRs; removing SIGN support does not.
- AISDLC-583's legacy `agentFileHash` binding (and its follow-up AISDLC-584) live entirely on the pre-v6 verify path — if legacy is deprecated/removed, 584's hardening becomes moot (note the linkage).

## Two-phase plan (deprecate ≠ remove)

### Phase A — Deprecate signing NOW (this task, low-risk)
1. Emit a clear **deprecation warning** whenever a v3/v4/v5 envelope is SIGNED (`--schema-version v3|v4|v5` or `AI_SDLC_V5_LEGACY=1` / legacy `AI_SDLC_V6_CUTOVER_ACTIVE=0`): "schema <v> is deprecated; v6 is the only supported signing schema — see <migration doc>." Point at the transcript-leaf emission prerequisite (the reason legacy opt-in existed).
2. Docs: mark v5 opt-out as deprecated in CLAUDE.md's "Review attestations" section + the RFC-0042 status, with a target removal window.
3. Do NOT change the VERIFIER — it must keep reading v3/v4/v5 for historical auditability until the RFC decides otherwise (Phase B).

### Phase B — Remove support (SEPARATE, needs an RFC-0042 amendment / OQ walkthrough — DO NOT self-resolve)
Removing v3/v4/v5 **verify** support directly contradicts OQ-7's retention decision, so it requires an operator-driven RFC-0042 amendment answering: (a) do we drop the legacy SIGN path entirely; (b) do we drop legacy VERIFY, and if so how do we preserve auditability of already-merged legacy PRs (e.g. one-time re-attestation sweep to v6, or an archived verifier); (c) the removal timeline. This is an architectural/audit-trail decision for the operator, not the implementer.

## Acceptance Criteria (Phase A only)
- [ ] Signing a v3/v4/v5 envelope emits a deprecation warning naming the schema + pointing to v6 migration; v6 signing is unchanged and silent.
- [ ] The verifier is UNCHANGED (still reads v3/v4/v5 for historical PRs — OQ-7).
- [ ] CLAUDE.md + RFC-0042 status note the v3/v4/v5 signing deprecation + a target removal window; Phase B (removal) is explicitly deferred to an RFC-0042 amendment.
- [ ] Hermetic test asserts the deprecation warning fires on legacy sign and NOT on v6.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0042 (attestation schema lifecycle, OQ-7 legacy retention). Linked: AISDLC-583/584 (legacy agentFileHash binding — moot if legacy removed).
<!-- SECTION:DESCRIPTION:END -->
