---
id: AISDLC-1323
title: 'Promote built RFCs to Implemented with runtime evidence (0017, 0036, 0043, 0046, 0050, 0051, 0053)'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - rfc
dependencies:
  - AISDLC-1322
references:
  - spec/rfcs/README.md
  - scripts/check-rfc-lifecycle-transitions.mjs
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-registry.mjs
  - reference/src/capabilities/registry.ts
  - .ai-sdlc/capabilities.yaml
  - .ai-sdlc/dark-code-baseline.json
  - .claude/rules/rfcs.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
assumes:
  - RFC-0011
  - RFC-0017
  - RFC-0036
  - RFC-0042
  - RFC-0043
  - RFC-0046
  - RFC-0047
  - RFC-0050
  - RFC-0051
  - RFC-0053
  - RFC-0061
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: every RFC is closed out, after the planner''s audit found built RFCs still labelled Signed Off. Each promotion is gated by the lifecycle check, which asks for runtime evidence, so an RFC with a shadow, degraded or unwired capability stays where it is (class a: the rule is applied, not loosened). The frontmatter, the capability registry and the sign-off tables were read on `main` at 0c21bc11f on 2026-11-18.'
---

## Description

**Gap.** Seven RFCs are built, in whole or in part, and still say `Signed Off` (RFC-0017 and RFC-0036 after AISDLC-1322 moves them there). The ladder in `spec/rfcs/README.md` ("RFC Lifecycle") ends at `Implemented`, and `Signed Off` to `Implemented` is refused by `scripts/check-rfc-lifecycle-transitions.mjs` unless the frontmatter has `runtimeEvidence` and every entry is `live` or `not-applicable` (an empty list when the RFC specifies no optional capability). So each promotion needs a check of what runs in this repository, not a label change.

**How this differs from other open tasks.** AISDLC-1322 corrects labels that need no evidence (0015, 0017, 0036, 0047) and must land first, because RFC-0017 and RFC-0036 are `Ready for Review` until then and the ladder cannot be skipped. AISDLC-1324 promotes RFC-0054 and RFC-0059, which need a concept page and the docs gate. AISDLC-1316 adds a published-page rule for every `Implemented` RFC with a baseline of today's gaps; this task must land BEFORE AISDLC-1316 is dispatched, so the baseline absorbs these RFCs. AISDLC-1317 aligns Registry cells and body status lines and does not change lifecycle.

**Known caveats, read before starting.**

- RFC-0043: built for the Docker runtime only. gVisor and MicroVM drivers are deferred (open tasks AISDLC-515 and AISDLC-515.2). The RFC states Docker as the v1 reference runtime and the others as upgrade drivers, so they are not a capability the gate counts as degraded; record them as `not-applicable` with evidence naming AISDLC-515, or, if you cannot defend that from the RFC text, leave RFC-0043 out. The RFC also carries `deferredDocs: true` with a deadline of 2026-08-31 long past; do not change it here (AISDLC-1316 and the operator own that). Its header says it is amended by RFC-0061: the clean-room output is the verdict record.
- RFC-0046: amended by RFC-0061 (the tier carrier is the verdict record, not a transcript leaf). Its Implementation Plan has five unticked boxes. `isolatedTierAvailable()` in `pipeline-cli/src/attestation/independence-policy.ts` returns `true` unconditionally and its comment names the RFC-0047 anchor, which AISDLC-1173 deleted; AISDLC-1322 supersedes RFC-0047. Check what actually sets and verifies the `isolated` tier today (`pipeline-cli/src/attestation/verdict-untrusted.ts`, `verdict-check.ts`) before writing evidence. If the `isolated` tier is claimed without a check, that is a degraded capability: do not promote RFC-0046 and name it in the PR body.
- RFC-0053: the Sign-Off table has Engineering and Operator signed, Product and Design pending. RFC-0043, 0050, 0051 and 0059 are in the same state. The lifecycle is already `Signed Off` and the gate does not read the table for this transition, so it is not a blocker; list it in the PR body as an observation for the operator.
- RFC-0050 and RFC-0051 name registered capabilities (`pricing.feed`, `usage.ingest`, `routing.table`; `hierarchy.board`, `hierarchy.clear`). `hierarchy.clear` has a documented fallback; ephemeral executors are the default (RFC-0059) and a typed clear exists only for standing executors. Decide from the evidence, not from the registry text.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should built RFCs be promoted on sight? No: the rule asks for evidence per capability, so a promotion that cannot show it is refused, and the RFC stays `Signed Off` with the reason in the PR body. 2. Deleted: nothing. 3. Simplified or optimised: one pass per RFC with the same five steps, no new script. 4. Accelerated: not applicable. 5. Automated: `pnpm rfc:check` fails on an unknown capability id or a malformed entry and prints a warning for each `degraded` or `shadow` entry, so the result is checked by existing gates.

Per RFC, in this order:

1. **List the optional capabilities.** Read the RFC and name each optional (usually model-backed, or flag-gated, or driver-dependent) function that has a defined fallback. Use only ids in `reference/src/capabilities/registry.ts` (`pnpm rfc:check` rejects others). An RFC that specifies none gets `runtimeEvidence: []`. An RFC that specifies a capability with no registered id is NOT promoted; name the capability in the PR body (registering an id is a code change outside this task).
2. **Check each capability is live in THIS repository.** Evidence must be something a reader can open: a file under `artifacts/` or `.ai-sdlc/`, a command output with its date, or a workflow run, not a statement in the RFC. A capability counts as `live` only when the real result was produced and used. It is NOT live when: it runs in shadow, it sits behind a flag that is off in this repository's configuration (`.ai-sdlc/`, `.github/workflows/`, environment defaults in the source), it took its fallback, or its module has no non-test importer (`node scripts/check-dark-code.mjs`; the entries of `.ai-sdlc/dark-code-baseline.json` name RFCs). Do not introduce a token import to satisfy the dark-code check.
3. **Write `runtimeEvidence`** in the frontmatter in the shape of README section "`runtimeEvidence`" (`capability`, `status`, `evidence`, `date: '2026-11-18'`, optional `owner`). Entries are `live` or `not-applicable` only.
4. **Tick the plan checkboxes that are done**, and only those, citing nothing new. A box stays unticked when its work is not built. Do not edit any Open Questions section, and add no `**Resolution:**` or `RESOLVED:` marker.
5. **Promote.** Set `lifecycle: Implemented` and `status: Implemented`, set the body `**Lifecycle:**` line to `Implemented` and the `**Status:**` line to begin with `Implemented`, keeping the former text after "Previously:". Then `node scripts/check-rfc-registry.mjs --write` and correct the Notes cell of the row if it states a pending step.
6. **If any capability is shadow, degraded or unwired, leave the RFC at `Signed Off`.** Change nothing in its file; the PR body names the RFC, the capability and the evidence.

- **Rules that apply** (`.claude/rules/rfcs.md`, `spec/rfcs/README.md`): no operator override marker is used anywhere; the ladder is not skipped. `CHANGELOG.md` is never edited.
- **Docs gate.** `node scripts/check-rfc-docs.mjs` enforces `requiresDocs` for `Implemented` RFCs: RFC-0050 and RFC-0051 declare `operator-runbook` and need a file under `docs/operations/` that cites the RFC id. If one is missing, leave that RFC at `Signed Off` and say so. If the published-page rule of AISDLC-1316 is already on `main` when this task starts, each promoted RFC must satisfy it honestly: set `requiresDocs` to name a published page that already cites the RFC id (examples to check, not assume: `docs/operations/usage-ledger.md`, `docs/operations/cli-hierarchy.md`, `docs/operations/untrusted-pr-gate.md`, `docs/operations/independence-policy.md`, the two tutorials for RFC-0017 and RFC-0036). An RFC with no such page stays at `Signed Off` and is named in the PR body; add no baseline entry and no exemption. The two tasks may land in either order.
- **Stop rule.** If more than the expected eight files change (seven RFC files and the README), or a promotion would need a code change, a new docs page or the operator override, leave that RFC out and report it. A partial result is a valid result.

Out of scope: RFC-0054 and RFC-0059 (AISDLC-1324); RFC-0015, 0017 and 0036 label corrections (AISDLC-1322); the RFC-0043 drivers (AISDLC-515, AISDLC-515.2); RFC-0047 remnants; `deferredDocs` fields; any change to `.ai-sdlc/capabilities.yaml` or the capability registry.

## Acceptance Criteria

- [ ] #1 For every RFC promoted, `lifecycle: Implemented` and `status: Implemented` are set, `runtimeEvidence` is present with entries that are all `live` or `not-applicable` (or is `[]`), each `live` entry's `evidence` names a file, command output or run that the PR body lists, and `node scripts/check-rfc-lifecycle-transitions.mjs` accepts the diff with no operator override marker.
- [ ] #2 For every RFC not promoted, its file is unchanged and the PR body names the RFC, the capability that is shadow, degraded or unwired (or the missing docs file) and the evidence found.
- [ ] #3 RFC-0043 is either promoted with the gVisor and MicroVM drivers recorded as `not-applicable` and naming AISDLC-515, or left out with the reason; RFC-0046 is promoted only with the result of the `isolated` tier check written into the PR body; RFC-0053's pending Product and Design sign-offs are listed in the PR body as an observation.
- [ ] #4 Plan checkboxes are ticked only for work that exists; the diff adds no line containing `**Resolution:**` or `RESOLVED:` and changes no text inside an Open Questions section.
- [ ] #5 `node scripts/check-rfc-registry.mjs`, `node scripts/check-rfc-docs.mjs` and `node scripts/check-dark-code.mjs` exit 0; `pnpm rfc:check` and `pnpm rfc:test` pass; the Registry rows of every changed RFC match their files.
- [ ] #6 The diff does not touch `CHANGELOG.md`, `.ai-sdlc/` or any file outside `spec/rfcs/`, and has at most 15 files (expected: at most seven RFC files and the README).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
