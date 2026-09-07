---
id: AISDLC-604
title: >-
  Schema drift: sync sdk-go/core/schemas/agent-role.schema.json with the canonical reference schema (+ add a drift gate)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - schema
  - sdk-go
  - agent-role
  - drift
  - reference
dependencies: []
references:
  - spec/schemas/agent-role.schema.json
  - sdk-go/core/schemas/agent-role.schema.json
  - reference/scripts/generate-schemas.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Surfaced by AISDLC-601 code + test review (PR #1043, 2026-09-07).** The Go SDK
mirror `sdk-go/core/schemas/agent-role.schema.json` has drifted from the
canonical `spec/schemas/agent-role.schema.json`. Two reviewers independently
flagged it as a pre-existing minor (not introduced by AISDLC-601 — the new
`Governance` `$def` was added consistently to both files, but the surrounding
mirror is stale).

**Known drift at the time of filing (~87 diff lines):** the mirror is missing
`spec` properties present in the canonical schema, including (non-exhaustive):
`designSystem`, `scope`, `soulBindings`, and `constraints.blockedActions`
(plus `constraints.requireHumanApproval` / `requireStory` / `requireTokenUsage`),
and carries slightly shorter/older property descriptions. The mirror is used by
the Go SDK (`sdk-go/core/validation.go` embeds/consumes it); drift means an
AgentRole config that is valid under the TypeScript reference validator can be
rejected (or silently under-validated) by the Go SDK, and vice versa.

## Scope
- Reconcile `sdk-go/core/schemas/agent-role.schema.json` against the canonical
  `spec/schemas/agent-role.schema.json` so the two agree on the `spec` property
  set and `$defs` (at minimum: `designSystem`, `scope`, `soulBindings`,
  `constraints.blockedActions` + the other missing `constraints.*` keys, and the
  `Governance` `$def` shape). Descriptions may stay terser in the mirror if the
  Go SDK has a length constraint, but the *validation surface* (properties,
  enums, `additionalProperties`, required) must match.
- Decide + document the drift-prevention mechanism. Preferred: a small gate
  (wired into `pnpm test`) that diffs the two schemas' validation surface and
  fails on divergence — OR make the mirror generated from the canonical source
  (single source of truth) if the Go embed can consume a generated artifact.
  Pick whichever fits the Go embed conventions; do NOT hand-maintain two copies
  with no guard (that is the exact condition being fixed).
- Run the full Go SDK suite (`cd sdk-go && go test ./...`) AND the reference
  validation suite; both must pass against the reconciled schema.

## Acceptance Criteria
- [ ] `sdk-go/core/schemas/agent-role.schema.json` validation surface (properties,
  enums, `additionalProperties`, required, `$defs`) matches
  `spec/schemas/agent-role.schema.json` — verified by an explicit diff/test, not
  by eye.
- [ ] A drift-prevention gate (or generation step) exists so the two schemas
  cannot silently diverge again; it is wired into `pnpm test`.
- [ ] `cd sdk-go && go test ./...` passes.
- [ ] Reference validation suite passes; an AgentRole config valid under the TS
  validator is also accepted by the Go SDK (add a cross-validator conformance
  case if one does not already exist).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Filed as a follow-up to AISDLC-601 per operator instruction (2026-09-07). The
`Governance` `$def` added by AISDLC-601 is already consistent between the two
files; this task addresses the pre-existing surrounding drift and installs the
guard that would have caught it.
