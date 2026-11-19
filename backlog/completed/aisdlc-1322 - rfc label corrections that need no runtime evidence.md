---
id: AISDLC-1322
title: 'RFC label corrections that need no runtime evidence (0017 and 0036 to Signed Off, 0015 and 0047 to Superseded)'
status: Done
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - rfc
dependencies: []
references:
  - spec/rfcs/README.md
  - scripts/check-rfc-lifecycle-transitions.mjs
  - scripts/check-rfc-registry.mjs
  - scripts/check-rfc-docs.mjs
  - .claude/rules/rfcs.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - spec/rfcs/RFC-0017-in-soul-variant-pattern.md
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - docs/concepts/autonomous-orchestrator.md
  - backlog/completed/aisdlc-437 - feat-RFC-0017-phase-4-internaladopter-four-product-reference-impl.md
  - backlog/completed/aisdlc-336 - docs-RFC-0036-phase-11-adopter-authoring-promotion-runbook.md
assumes:
  - RFC-0015
  - RFC-0017
  - RFC-0036
  - RFC-0042
  - RFC-0043
  - RFC-0046
  - RFC-0047
  - RFC-0051
  - RFC-0061
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: every RFC is closed out, after the planner''s audit found lifecycle labels behind reality. These four need no design decision and no runtime evidence, only a truthful label. Facts below were read on `main` at 0c21bc11f on 2026-11-18: the sign-off tables of RFC-0017 and RFC-0036, the headers of RFC-0015, RFC-0042 and RFC-0047, and a search of the source for the RFC-0047 anchor.'
---

## Description

**Gap.** Four RFCs carry a lifecycle that is behind what the repository shows.

| RFC | Frontmatter now | Evidence read on `main` | Correct label |
|---|---|---|---|
| RFC-0017 | `status: Draft`, `lifecycle: Ready for Review` | The body header already says `Signed Off` (line 23). The Sign-Off table (lines 39 to 46) has Design Authority (Morgan Hirtle) "Conditional sign-off on v0.4", Engineering (Dominique Legault) "Signed v0.4" and Product (Alexander Kline) "Signed v0.4", all dated 2026-05-26. The one condition that matters is "§11 practitioner validation gates resolved on InternalAdopter implementation pass (AISDLC-437)"; AISDLC-437 is in `backlog/completed/` with `status: Done`. The table has no line recording that the condition was discharged. | `Signed Off` |
| RFC-0036 | `status: Draft`, `lifecycle: Ready for Review` | The Sign-Off section (lines 27 to 31) has three ticked boxes: Engineering (2026-05-27), Product (2026-05-18) and Operator (2026-05-27). The two 2026-05-27 lines say "lifecycle bump deferred until AISDLC-336 Phase 11 promotion runbook lands"; AISDLC-336 is in `backlog/completed/`. | `Signed Off` |
| RFC-0015 | `status: Approved`, `lifecycle: Signed Off` | The tick loop it specifies was retired as the way to run autonomously (AISDLC-763; commit a8dda8a3d, AISDLC-1313, rewrote the public page). `docs/concepts/autonomous-orchestrator.md` says "retired" and names the session hierarchy of RFC-0051 as the replacement. `pipeline-cli/src/orchestrator` and `pipeline-cli/bin/cli-orchestrator.mjs` still ship, not as an autonomous loop. | `Superseded` by RFC-0051 |
| RFC-0047 | `status: Draft`, `lifecycle: Signed Off` | Its CI-only signer and verifier were deleted with the v6 envelope (AISDLC-1173, commit fed148f2e); the isolated-review workflow was removed by AISDLC-832; only the tier name `isolated` survives, on the review verdict record (RFC-0061). A search of the source on `main` finds no code that signs or verifies a root with a `ci-only` key; what remains is listed in Fix. | `Superseded` by RFC-0061 |

The Registry rows of `spec/rfcs/README.md` (RFC-0015 line 365, RFC-0017 line 367, RFC-0036 line 386, RFC-0047 line 397) repeat the old values and follow the files.

**How this differs from other open tasks.** AISDLC-1317 makes the Registry and the body `**Status:**` lines repeat the frontmatter and lists RFC-0017 and RFC-0047 for the operator; this task settles the frontmatter of those four files, so it should land first, and AISDLC-1317 then drops RFC-0017 and RFC-0047 from its operator list and its `status:` edit of RFC-0047. AISDLC-1316 is the docs gate for `Implemented` RFCs and touches no RFC file. AISDLC-1323 and AISDLC-1324 promote other RFCs to `Implemented` and need none of this.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must an RFC whose design is signed stay at `Ready for Review`, and must a retired design stay `Signed Off`? No: the ladder in `spec/rfcs/README.md` ("RFC Lifecycle") defines `Signed Off` as "all owner boxes checked" and `Superseded` as "replaced by newer RFC, header notes the successor"; the labels now say something the files contradict. 2. Deleted: nothing; the retired code stays where it is. 3. Simplified or optimised: each change is one step on the ladder (`Ready for Review` to `Signed Off`) or a move to `Superseded`, which the lifecycle gate allows from any state, so no operator override marker is needed. 4. Accelerated: not applicable. 5. Automated: `pnpm rfc:check` and the lifecycle gate already check every change below.

- **Rules that apply** (`.claude/rules/rfcs.md`, `spec/rfcs/README.md`): the ladder is changed only through `scripts/check-rfc-lifecycle-transitions.mjs`; do NOT add the `ai-sdlc:lifecycle-jump-approved-by` marker anywhere. No Open Question is resolved, no `**Resolution:**` or `RESOLVED:` marker is added, and no text inside an Open Questions section is edited. `CHANGELOG.md` is never edited.
- **RFC-0017 and RFC-0036: re-verify, then promote.** Re-read both Sign-Off sections on the tree you start from. For each RFC, the promotion is made only when every owner line is a signed line (a ticked box or a line starting with the sign-off mark) and nothing in the table says a sign-off is withdrawn or still pending. Then set `lifecycle: Signed Off` and `status: Approved` (the mapping guide in the README), and change the `**Lifecycle:**` body line to `Signed Off`. For RFC-0017 add one dated line directly under the Sign-Off table: "Condition (1) of the Design Authority sign-off, practitioner validation on the InternalAdopter pass, is tracked by AISDLC-437, which is Done; recorded 2026-11-18 by AISDLC-1322 from the completed task, not by the Design Authority." Do not edit the Design Authority row itself. For RFC-0036 add the same kind of line for AISDLC-336. If either file shows a missing or withdrawn sign-off, leave that RFC unchanged and name the line in the PR body.
- **RFC-0015: Superseded.** Set `lifecycle: Superseded` and `status: Withdrawn` (the mapping guide pairs `Superseded` with `Withdrawn`; RFC-0042 uses `status: Superseded`, which the `status` enum in `spec/schemas/rfc.schema.json` does not list, so do not copy it). Add under the title a block in the wording of RFC-0042's header: "> **Superseded by RFC-0051 (AISDLC-1322, 2026-11-18).** The autonomous orchestrator tick loop was retired as the way to run autonomously (AISDLC-763); autonomous dispatch runs through the session hierarchy (`cli-hierarchy up`). The code under `pipeline-cli/src/orchestrator` and `pipeline-cli/bin/cli-orchestrator.mjs` stays; it is no longer a loop." Change the body `**Status:**` and `**Lifecycle:**` lines to `Superseded`, keeping the former text after "Previously:". The `requires:` lists of RFC-0023, 0024, 0025 and 0026 name RFC-0015: leave them unchanged and list them in the PR body (the upstream-OQ gate reads `requires:`; whether they move to `assumes:` is the operator's).
- **RFC-0047: Superseded.** Set `lifecycle: Superseded` and `status: Withdrawn` (today `status: Draft`, which is wrong either way). Add under the title the same style of block as RFC-0042: "> **Superseded by RFC-0061 (AISDLC-1322, 2026-11-18).** The CI-only ed25519 anchor, its signer and its verifier were deleted with the v6 envelope (AISDLC-1173); the isolated-review workflow was removed (AISDLC-832). Only the tier name `isolated` survives, on the review verdict record (RFC-0061)." Change the body `**Status:**` and `**Lifecycle:**` lines the same way as for RFC-0015.
- **Verify before writing the RFC-0047 header.** Search the source for the anchor: `grep -rIn "RFC-0047" pipeline-cli orchestrator reference .github scripts .ai-sdlc spec/schemas --exclude-dir=node_modules --exclude-dir=dist`. On 2026-11-18 the hits are comments and data only: the `ciOnly` flag parsed from `.ai-sdlc/trusted-reviewers.yaml` in `orchestrator/src/runtime/attestations.ts`, the `ci-only` text in `spec/schemas/attestation-envelope-v6.schema.json` and its generated copy `reference/src/core/generated-schemas.ts`, `isolatedTierAvailable()` in `pipeline-cli/src/attestation/independence-policy.ts` (returns `true` unconditionally), and `docs/operations/ci-only-trust-marker.md`. If a hit shows a live signer or verifier of a `ci-only` root, do not supersede RFC-0047: leave it unchanged and say so in the PR body. If the hits match the list above, supersede and state in the PR body that the remnants are named, not removed here.
- **Registry.** Run `node scripts/check-rfc-registry.mjs --write`, then correct the Notes cell of each of the four rows by hand: remove the clause that states the old position (for RFC-0015 the "Flag default-on promotion gated on" clause; for RFC-0047 the "Signed Off" and "isolated producible" claims), and add "Superseded by RFC-0051" or "Superseded by RFC-0061, AISDLC-1322" or "Signed Off 2026-11-18 by AISDLC-1322 (evidence: AISDLC-437)" as fits. Change the Status cell to the new `status:` value of each file. The Open Questions Inventory and the critical-path table of the README: if either lists one of the four with its old lifecycle, set it to the new value.
- **Stop rule.** If a change would need the operator override marker, or an owner sign-off is missing, leave that RFC out and report it; the rest of the task still lands.

Out of scope: any `Implemented` promotion (AISDLC-1323 and AISDLC-1324); deleting the RFC-0047 remnants or the retired orchestrator code; the `requires:` lists of other RFCs; the other Status and Notes cells of the README (AISDLC-1317); the docs gate (AISDLC-1316).

## Acceptance Criteria

- [ ] #1 `node scripts/check-rfc-lifecycle-transitions.mjs` accepts the diff: for each changed RFC the `lifecycle:` change is `Ready for Review` to `Signed Off` (RFC-0017, RFC-0036) or any state to `Superseded` (RFC-0015, RFC-0047), and the diff contains no `ai-sdlc:lifecycle-jump-approved-by` marker.
- [ ] #2 RFC-0017 and RFC-0036 have `lifecycle: Signed Off`, `status: Approved` and a body `**Lifecycle:**` line of `Signed Off`, or the PR body names the sign-off line that is missing and the RFC is unchanged.
- [ ] #3 RFC-0015 and RFC-0047 have `lifecycle: Superseded`, `status: Withdrawn`, a header block naming RFC-0051 and RFC-0061 respectively, and body status lines that start with `Superseded` and keep the former text after "Previously:".
- [ ] #4 The PR body states the result of the RFC-0047 search (the hits and why none is a live signer or verifier) and lists the `requires:` entries of RFC-0023, 0024, 0025 and 0026 that name RFC-0015.
- [ ] #5 `node scripts/check-rfc-registry.mjs` and `node scripts/check-rfc-docs.mjs` exit 0, and `pnpm rfc:check` and `pnpm rfc:test` pass; the Registry rows of the four RFCs match their files, including the Status cell.
- [ ] #6 The diff adds no line containing `**Resolution:**` or `RESOLVED:`, changes no text inside an Open Questions section, does not touch `CHANGELOG.md`, and has at most 15 files (expected: 4 RFC files and the README).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
