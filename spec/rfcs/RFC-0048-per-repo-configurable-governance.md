---
id: RFC-0048
title: Per-Repo Configurable Governance Hard-Rules
status: Draft
lifecycle: Implemented
author: 'Dominique Legault'
created: 2026-09-07
updated: 2026-09-07
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0043]
requiresDocs: []
---

# RFC-0048: Per-Repo Configurable Governance Hard-Rules

> **Implemented 2026-09-07.** This RFC landed as `Draft` for stakeholder reference,
> had its five Open Questions resolved via an operator rubric walkthrough, was Signed
> Off, and shipped across three phases (AISDLC-601/602/603). Kept for the design record.

**Status:** Implemented (2026-09-07) — **all three phases shipped: AISDLC-601 (#1043,
source-of-truth schema + resolver + SessionStart/SubagentStart render), AISDLC-603
(#1046, deterministic `merge-if-eligible` CLI helper), AISDLC-602 (#1047, execute
hard-rules render + `enforce-blocked-actions` merge-governance reconcile). Signed Off
2026-09-07 (Engineering + Operator) — **all 5 Open Questions resolved via
operator rubric walkthrough.** The plugin hard-codes governance hard-rules ("NEVER
merge PRs", "NEVER force push", "NEVER close…") into every session, subagent, and
`execute` command, while the *enforcement* substrate (`agent-role.yaml`
`blockedActions`) is already per-repo — the two have drifted (`git merge*` doesn't
match `gh pr merge`). This RFC makes the hard-rules a single per-repo policy source of
truth in a `spec.governance` block (OQ-1), rendered into every governance surface,
**defaults strict**. Resolutions: **(OQ-1)** dedicated `governance` block with per-rule
keys; **(OQ-2)** merge-relaxation gates on work-item `sourceKind` provenance
(internal-backlog = trusted → auto-merge-on-green-CLEAN eligible; external-GitHub =
untrusted → never), with the policy *declaration* read only from trusted base-branch
config; **(OQ-3)** operational rules (merge/force-push/close/branch-delete/reset-hard)
configurable, integrity rules (CI-skip tokens, `.ai-sdlc/attestations|verdicts` edits,
and relaxing governance from a PR tree) permanently fixed; **(OQ-4)** a deterministic
`merge-if-eligible` CLI helper owns the green+CLEAN+tier gate, with the hook blocking
raw `gh pr merge` so the helper is the only route; **(OQ-5)** ship the granular block
**plus** a named `operator-trusted` preset now (`strict` = defaults). Trigger:
local-trades adopter (plugin 0.19.0); tasks AISDLC-601/602/603.

## Summary

Give `.ai-sdlc/agent-role.yaml` a governance section that expresses the canonical
hard-rules and their per-repo settings. Resolve it (repo policy ⊕ strict defaults)
into one policy object, and RENDER the injected hard-rule text — in `session-start.js`,
`subagent-start.js`, and the `execute`/`execute-parallel` command bodies — from that
resolved policy rather than string constants. Reconcile `enforce-blocked-actions.js`
so the enforced behavior matches the narration (notably: actually block `gh pr merge`
under strict). Defaults stay strict, so existing adopters are unchanged; a repo opts
into a softer rule (e.g. agent-merge on green+CLEAN) with one declaration.

## Motivation

- **Adopters are stuck.** A consumer cannot change an injected hard-rule without
  patching the framework — which the framework tells adopters not to do. The injected
  rule can directly contradict a policy the repo's operator deliberately chose.
- **Concrete case (local-trades).** The operator decided an agent MAY merge a PR once
  ALL CI checks are green and `mergeStateStatus` is CLEAN, because green PRs were
  piling up unmerged waiting for a human. Every real hazard for that repo is already a
  CI check (`verify-attestation`, `migration-mutation-gate`,
  `workflow-secret-scope-gate`, `ci`), so "green + CLEAN" already covers it. But the
  injected "NEVER merge PRs. Only humans merge." keeps asserting the opposite in every
  session, and `execute`'s hard-rule forbids it outright.
- **Narration/enforcement drift already exists.** `agent-role.yaml` can say
  `git merge*` is blocked (which matches only a LOCAL `git merge`, not `gh pr merge`),
  while the injected prose independently hard-codes "NEVER merge PRs." The two sources
  can already disagree; this RFC collapses them into one.

## Goals

1. One per-repo policy source of truth for governance hard-rules, in
   `.ai-sdlc/agent-role.yaml`.
2. Every governance surface (SessionStart banner, SubagentStart banner, `execute`
   hard-rules, PreToolUse hook) renders/enforces from that one resolved policy.
3. **Defaults strict** — a repo with no governance section behaves exactly as today.
4. A **trust boundary**: a relaxation cannot be set by the party being governed
   (untrusted contributor PRs).
5. Fix the existing merge narration/enforcement drift (`gh pr merge`).

## Non-Goals

- Removing the strict defaults or weakening the framework's default posture.
- Making governance settable by untrusted contributors.
- Auto-merge orchestration mechanics beyond expressing/enforcing the "green + CLEAN"
  gate (the merge itself remains the operator's opt-in policy).

## Proposal

Adopt **Option 1** (per the triage): one per-repo policy source of truth, rendered
into every governance surface, defaults strict. Concretely:

1. A `governance` (a.k.a. `hardRules`) section in `agent-role.yaml`'s `spec`,
   enumerating the canonical rules with strict defaults.
2. A shared, hermetically-testable **resolver** that merges repo policy over strict
   defaults into a resolved policy object.
3. **Render surfaces** consume the resolver: `session-start.js`, `subagent-start.js`,
   and `execute`/`execute-parallel` hard-rule blocks.
4. **Enforcement reconciliation**: `enforce-blocked-actions.js` derives its
   merge/force-push/etc. blocks from the same resolved policy, closing the
   `gh pr merge` gap.
5. **Trust boundary + green+CLEAN guardrail** as described in Design Details.

## Design Details

- **Schema (shape pending OQ-1).** Candidate: `spec.governance` with per-rule keys,
  e.g. `allowMerge: never | onGreenClean`, `allowForcePush`, `allowClosePrIssue`,
  `allowBranchDelete`, `allowResetHard`. Absent section ⇒ strict.
- **Resolver.** `resolveGovernance(repoPolicy) → { rules… }` with strict defaults;
  unknown/malformed keys **fail closed to strict**. Single source consumed by all
  surfaces.
- **Trust boundary — gated on work-item trust tier (established architecture).** The
  operator's standing design (2026-09-07): trust is **higher for internal backlog
  issues** (the subscription/dogfood path — the operator authored the work item) and
  **lower for external work that arrives through GitHub** (issues / contributor PRs).
  So the merge-relaxation follows the source: an **internal backlog task MAY auto-merge
  on green+CLEAN**; **external GitHub-sourced work is NOT eligible for auto-merge** —
  a human still merges. This maps directly onto the [[project_dual_workflow_architecture]]
  (backlog=subscription/trusted, GitHub-issue=API-key/lower-trust) and RFC-0043's
  contributor trust tiers. Additionally, the *policy declaration itself* is honored
  only from the repo's trusted `.ai-sdlc/agent-role.yaml` on the base branch / operator
  filesystem — never from PR-modified config supplied by an untrusted contributor
  (the governed party must not relax its own rules).
- **green+CLEAN (enforcement point pending OQ-4).** `allowMerge: onGreenClean` means
  "all required CI checks green AND `mergeStateStatus == CLEAN`", gated on the repo's
  real checks (verify-attestation, migration-mutation-gate, …). Opting in removes only
  the "human clicks merge" step, not any safety gate.
- **Configurable vs. fixed (boundary pending OQ-3).** Some rules may remain
  permanently fixed regardless of config (candidates: never write CI-skip magic
  tokens; never edit `.ai-sdlc/attestations/**` or `.ai-sdlc/verdicts/**`).

## Backward Compatibility

Defaults strict: a repo with no `governance` section reproduces today's injected
hard-rule text and enforcement byte-for-byte where practical. No adopter action
required; existing adopters unchanged.

## Alternatives Considered

- **Option 2 — named presets only** (`strict` / `operator-trusted`). Lower ceremony
  but less granular; folded into OQ-5 as a possible layer on top of Option 1.
- **Option 3 — make only the merge rule overridable.** Minimal, but leaves the other
  rules hard-coded and doesn't fix the general drift. Rejected as the whole answer.
- **Status quo** — adopters fork the framework. Rejected (the framework tells them not
  to).

## Implementation Plan

Three phase tasks (reconciled with the OQ resolutions):

- **Phase 1 (AISDLC-601):** `spec.governance` block (OQ-1) + `operator-trusted`/`strict`
  presets (OQ-5) + resolver (strict defaults, fail-closed, preset expansion pinned to
  the OQ-3 fixed set) + render into `session-start.js` + `subagent-start.js`; policy
  read base-branch-only (OQ-2). Permanently-fixed integrity rules (OQ-3) never
  relaxable.
- **Phase 2 (AISDLC-602):** render the resolved policy into `execute`/`execute-parallel`
  hard-rules + reconcile `enforce-blocked-actions.js` to block raw `gh pr merge`
  (closing the `git merge*` gap) and route merges only through the Phase-3 helper.
  Depends on 601 + 603.
- **Phase 3 (AISDLC-603):** the deterministic `merge-if-eligible` CLI helper (OQ-4) —
  green + CLEAN + trusted `sourceKind` gate (OQ-2), exits non-zero otherwise, then
  merges. Depends on 601. This is where the green+CLEAN check lives.

## Open Questions

**OQ-1 — Configuration surface / schema shape.** How does a repo express the policy:
extend the existing `blockedActions` list, add a dedicated `spec.governance` block
with per-rule keys, or a named-preset selector — or a combination?

**Resolution (2026-09-07, full rubric): dedicated `spec.governance` block with
per-rule keys.** Industry research: structured per-rule policy with defaults is the
universal governance-as-config pattern (K8s OPA/Gatekeeper CRDs, GitHub branch
protection, ESLint `rules: { name: severity|[severity,opts] }`, Terraform Sentinel) —
flat allow/deny string lists only work when every entry has identical semantics.
**Refinement:** rules carry rule-specific value types (e.g. `allowMerge:
never | onGreenClean`, `allowForcePush: bool`) that `blockedActions` (a bash-command
glob list) cannot represent. **Counter-argument:** "reuse `blockedActions` — it already
gates merges." Rebuttal: it gates *bash patterns* (`git merge*`) and cannot express
`gh pr merge` or `onGreenClean`; overloading it forces two grammars into one field and
re-creates the very narration/enforcement split this RFC closes. **Selected over
`blockedActions`-extension and preset-only** because governance needs per-rule value
types and one structured source rendered to every surface.

**OQ-2 — Trust boundary / authorization.** *Established lean (operator, 2026-09-07):*
merge-relaxation gates on work-item trust tier — internal backlog tasks (higher trust)
may auto-merge on green+CLEAN; external GitHub-sourced work (lower trust) never
auto-merges. Remaining to confirm: the exact signal used to classify tier at
merge-decision time (backlog-task provenance vs. `gh-issue-N` source-kind vs.
contributor trust tier), and that the policy *declaration* is read only from trusted
base-branch/operator config (not PR-modified). See [[project_dual_workflow_architecture]],
RFC-0043.

**Resolution (2026-09-07, full rubric): the tier signal is work-item `sourceKind`
provenance; the policy declaration is read base-branch-only.** Industry research:
provenance-gated trust is standard (GitHub Actions restricts the fork-PR token by
source via `pull_request_target`, not by content; RFC-0043 contributor trust tiers).
The `sourceKind` (`backlog-task` vs `gh-issue-N`) is *already threaded through
`executePipeline`* and maps one-to-one onto the operator's internal-vs-external
architecture, and — critically — it is set by the dispatch, not by the party being
governed, so it cannot be spoofed from a PR. **Refinement over the bare lean:** the
merge-decision surface reads `sourceKind` (trusted ⇒ auto-merge-on-green-CLEAN
eligible; untrusted ⇒ never), AND the `governance` declaration is resolved only from
the trusted base-branch `.ai-sdlc/agent-role.yaml` / operator filesystem — never the
PR tree (a PR cannot relax the rule it is governed by). **Counter-argument:** "PR
author-association is GitHub's native trust primitive." Rebuttal: association answers
"who opened the PR," not the work-item provenance the architecture keys on; it can be a
*secondary* tightening on the external path but not the primary signal. **Selected over
author-association-only** because `sourceKind` is already threaded, matches the
internal-vs-external split exactly, and is unforgeable by the governed party.

**OQ-3 — Configurable vs. permanently-fixed rules.** Which hard-rules become
configurable (merge / force-push / close / branch-delete / reset-hard) and which stay
permanently fixed regardless of config (CI-skip tokens; `.ai-sdlc/attestations|verdicts`
edits)?

**Resolution (2026-09-07, full rubric): operational rules configurable, integrity
rules permanently fixed.** Configurable = `merge`, `force-push`, `close PR/issue`,
`branch-delete`, `git reset --hard`. Permanently fixed regardless of config = never
write CI-skip magic tokens; never edit `.ai-sdlc/attestations|verdicts`; governance
cannot be relaxed from a PR tree (the OQ-2 base-branch-only invariant). Industry
research: every serious policy system separates negotiable config from non-negotiable
invariants (K8s always-on admission controllers; AWS SCP / permission-boundary
ceilings; OPA pinned base bundles). **Counter-argument:** "a fully trusted operator
repo should be able to do anything, including skip CI or edit attestations." Rebuttal:
those are not preferences — they are the mechanisms the framework's guarantees rest on;
a repo that can write `[skip ci]` or edit `.ai-sdlc/attestations` silently disables the
verification everything else assumes, and once governance is config-driven the config
that disables governance must itself be un-relaxable from the governed surface.
**Selected over everything-configurable and merge-only** because it draws the line
exactly where the trust chain breaks — keeping "configurable" from becoming
"unguarded."

**OQ-4 — green+CLEAN enforcement point.** Where does the merge-on-green gate live so
it cannot be skipped: an LLM command-body precondition, a deterministic CLI helper the
command must call, or a hook?

**Resolution (2026-09-07, full rubric): a deterministic `merge-if-eligible` CLI helper
owns the gate; the PreToolUse hook blocks raw `gh pr merge` so the helper is the only
route.** The helper queries required-checks + `mergeStateStatus` + `sourceKind` and
exits non-zero unless green + CLEAN + trusted-tier, then merges. Industry research: the
framework's own governing principle is "anything mechanical → hook/workflow, never LLM"
(attestation signing was moved from the command body to the pre-push hook for exactly
this reason); deterministic gates beat LLM-honored prose. **Refinement:** two simple
layers — the hook enforces "only via the helper" (blocks raw `gh pr merge`), the helper
enforces "only when eligible" — which keeps the live-CI query out of the PreToolUse hot
path while remaining un-skippable. **Counter-argument:** "let the command body check
green+CLEAN — less machinery." Rebuttal: that is the soft enforcement the framework
abandoned for signing; an LLM precondition is skippable under context pressure, a helper
that exits non-zero is testable and auditable. **Selected over the inline-hook and
LLM-precondition** because it is deterministic AND keeps network calls out of the hook.

**OQ-5 — Preset layer.** Ship named presets (`strict` default, `operator-trusted`
permitting merge-on-green-CLEAN) as a one-line opt-in on top of the granular rules, or
granular-only for now?

**Resolution (2026-09-07, operator decision): ship the granular block PLUS a named
`operator-trusted` preset now** (`strict` = the defaults, no config). The operator
selected the preset layer over the rubric's granular-only recommendation: an
`operator-trusted` one-word opt-in for the merge-on-green-CLEAN bundle is worth shipping
immediately for the known common case. **Preset semantics (load-bearing):** a preset is
sugar that expands to the same resolved `governance` object — it MUST NOT be able to set
anything the granular block couldn't (so OQ-3's permanently-fixed integrity rules stay
fixed under any preset), and `operator-trusted` still only enables auto-merge for the
trusted `sourceKind` per OQ-2 (it does not blanket-permit merging external work).
Explicit granular keys override the preset. **Selected over granular-only** per operator
call; the rubric's premature-bundling caution is mitigated by pinning the preset's
expansion to the granular schema + the OQ-3 fixed set.

## References

- Trigger: local-trades adopter triage (2026-09-07, plugin 0.19.0).
- Tasks: AISDLC-601 (source of truth + hooks), AISDLC-602 (execute + enforcement).
- Substrate: `ai-sdlc-plugin/hooks/{session-start,subagent-start,enforce-blocked-actions}.js`,
  `ai-sdlc-plugin/commands/execute.md`, `.ai-sdlc/agent-role.yaml`.
- [[RFC-0043]] (untrusted-contributor trust tiers — relevant to OQ-2).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (one per-repo policy source of truth rendered to every surface; defaults strict; sound implementation surface across 601/602/603; 2026-09-07) |
| Operator | Dominique Legault | ✅ Signed (fixes the real narration/enforcement drift; trust boundary follows the internal-vs-external work-item architecture; 2026-09-07) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-07 | Initial Draft. Problem, Option-1 proposal, 5 Open Questions. Trigger: local-trades adopter (plugin 0.19.0); tasks AISDLC-601/602 filed. |
| 2026-09-07 | **Draft → Ready for Review.** All 5 OQs resolved via operator rubric walkthrough: (1) dedicated `governance` block; (2) `sourceKind`-provenance tier gating + base-branch-only declaration; (3) operational-configurable / integrity-fixed; (4) deterministic `merge-if-eligible` helper + hook blocks raw `gh pr merge`; (5) granular **+** `operator-trusted` preset (operator override of the granular-only recommendation). Reconciled phase plan to AISDLC-601/602 + new AISDLC-603 (helper). |
| 2026-09-07 | **Ready for Review → Signed Off** (Engineering + Operator). Phase tasks AISDLC-601/602/603 dispatchable. |
