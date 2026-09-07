---
id: RFC-0048
title: Per-Repo Configurable Governance Hard-Rules
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-09-07
updated: 2026-09-07
targetSpecVersion: v1alpha1
requires: []
assumes: [RFC-0043]
requiresDocs: []
---

# RFC-0048: Per-Repo Configurable Governance Hard-Rules

> This RFC lands on main with `lifecycle: Draft` for stakeholder reference. The
> five Open Questions gate promotion; they are resolved via an operator rubric
> walkthrough before sign-off.

**Status:** Draft (2026-09-07) — **5 Open Questions pending operator walkthrough.**
The plugin injects a fixed set of governance hard-rules ("NEVER merge PRs", "NEVER
force push", "NEVER close…") into every session, subagent, and `execute` command,
verbatim, regardless of the consumer repo's policy — while the *enforcement*
substrate (`agent-role.yaml` `blockedActions`/`blockedPaths`) is already per-repo.
The narration and the enforcement have drifted (the prose asserts "never merge PRs"
but `blockedActions: git merge*` doesn't even match `gh pr merge`). This RFC makes
the hard-rules a single per-repo policy source of truth in `agent-role.yaml`,
rendered into every governance surface, **defaults strict**, with a **trust boundary**
so the governed party cannot relax its own guardrails. Trigger: local-trades adopter
(plugin 0.19.0); tasks AISDLC-601/602 filed against this RFC.

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

Phase tasks are reconciled with the already-filed AISDLC-601/602 after OQ resolution:

- **Phase 1 (AISDLC-601):** schema + resolver + strict defaults; render into
  `session-start.js` + `subagent-start.js`; trust boundary.
- **Phase 2 (AISDLC-602):** render into `execute`/`execute-parallel` hard-rules +
  reconcile `enforce-blocked-actions.js` (`gh pr merge`); green+CLEAN enforcement.
- Additional phases (presets, permanently-fixed-rule set) added per OQ-3/OQ-5
  resolutions.

## Open Questions

**OQ-1 — Configuration surface / schema shape.** How does a repo express the policy:
extend the existing `blockedActions` list, add a dedicated `spec.governance` block
with per-rule keys, or a named-preset selector — or a combination?

**OQ-2 — Trust boundary / authorization.** *Established lean (operator, 2026-09-07):*
merge-relaxation gates on work-item trust tier — internal backlog tasks (higher trust)
may auto-merge on green+CLEAN; external GitHub-sourced work (lower trust) never
auto-merges. Remaining to confirm: the exact signal used to classify tier at
merge-decision time (backlog-task provenance vs. `gh-issue-N` source-kind vs.
contributor trust tier), and that the policy *declaration* is read only from trusted
base-branch/operator config (not PR-modified). See [[project_dual_workflow_architecture]],
RFC-0043.

**OQ-3 — Configurable vs. permanently-fixed rules.** Which hard-rules become
configurable (merge / force-push / close / branch-delete / reset-hard) and which stay
permanently fixed regardless of config (CI-skip tokens; `.ai-sdlc/attestations|verdicts`
edits)?

**OQ-4 — green+CLEAN enforcement point.** Where does the merge-on-green gate live so
it cannot be skipped: an LLM command-body precondition, a deterministic CLI helper the
command must call, or a hook?

**OQ-5 — Preset layer.** Ship named presets (`strict` default, `operator-trusted`
permitting merge-on-green-CLEAN) as a one-line opt-in on top of the granular rules, or
granular-only for now?

## References

- Trigger: local-trades adopter triage (2026-09-07, plugin 0.19.0).
- Tasks: AISDLC-601 (source of truth + hooks), AISDLC-602 (execute + enforcement).
- Substrate: `ai-sdlc-plugin/hooks/{session-start,subagent-start,enforce-blocked-actions}.js`,
  `ai-sdlc-plugin/commands/execute.md`, `.ai-sdlc/agent-role.yaml`.
- [[RFC-0043]] (untrusted-contributor trust tiers — relevant to OQ-2).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ⏸ Pending |
| Operator | Dominique Legault | ⏸ Pending |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-07 | Initial Draft. Problem, Option-1 proposal, 5 Open Questions. Trigger: local-trades adopter (plugin 0.19.0); tasks AISDLC-601/602 filed. |
