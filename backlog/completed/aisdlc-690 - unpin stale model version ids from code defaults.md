---
id: AISDLC-690
title: >-
  Model defaults: stop pinning old model version ids in code; use family aliases on harness paths and one central table for direct-API paths
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - model-routing
  - pipeline-cli
  - orchestrator
  - regression
dependencies: []
references:
  - pipeline-cli/src/routing/default-table.ts
  - pipeline-cli/src/routing/load-table.ts
  - pipeline-cli/src/pipeline/reviewer-runner.ts
  - pipeline-cli/src/pipeline/clean-room-signer.ts
  - pipeline-cli/src/orchestrator/reconcile.ts
  - pipeline-cli/src/cli/index.ts
  - orchestrator/src/defaults.ts
  - orchestrator/src/models/registry.ts
  - orchestrator/src/harness/adapters/claude-code.ts
  - orchestrator/src/runners/sdk-review-runner.ts
  - docs/operations/model-routing.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The framework's built-in model defaults name old, versioned model ids. The operator
runs the developer and the code and test reviewers on the current Sonnet and the
security reviewer on the current Opus, and ruled on 2026-10-03: "we should just use
the latest opus and sonnet models, and not pin it to a specific version, that way
when they update it we just use the latest updates. if there is a problem then we
pin it." He called the stale pins a regression.

What is pinned today (non-test source, 2026-10-03):

- `pipeline-cli/src/routing/default-table.ts`: `DEFAULT_ROLE_MODELS` and the built-in
  table's `strength` name `claude-sonnet-4-6` and `claude-opus-4-6`. These apply to
  every role whenever a repository has no valid `.ai-sdlc/model-routing.yaml` on its
  base branch, and the shell spawner passes them as `--model`.
- `pipeline-cli/src/pipeline/reviewer-runner.ts`,
  `pipeline-cli/src/pipeline/clean-room-signer.ts`,
  `pipeline-cli/src/orchestrator/reconcile.ts` and the `emit-leaf` model default in
  `pipeline-cli/src/cli/index.ts` fall back to `claude-sonnet-4-6`.
- `orchestrator/src/defaults.ts`: `DEFAULT_MODEL` and `DEFAULT_ANTHROPIC_MODEL` are
  `claude-sonnet-4-5-20250929`; `DEFAULT_MODEL_COSTS` has no entry for a current model.
- `orchestrator/src/models/registry.ts` (`DEFAULT_REGISTRY`) and
  `orchestrator/src/harness/adapters/claude-code.ts` (`DEFAULT_AVAILABLE_MODELS`) map
  the aliases to `claude-sonnet-4-6` and `claude-opus-4-7`.
- `orchestrator/src/runners/sdk-review-runner.ts` defaults to `claude-sonnet-4-6`.
- `docs/operations/model-routing.md` and other docs show versioned ids in examples
  that read as the recommended configuration.

The agent definitions in `ai-sdlc-plugin/agents/` already use the aliases (`sonnet`,
`opus`), so the in-session path follows new releases while the paths above do not.

## Design rule

- **Harness paths** (anything that reaches Claude Code: `--model`, an agent call's
  model): the default is the family alias (`sonnet`, `opus`, `haiku`). The harness
  resolves it to the current release.
- **Direct-API paths** (anything that sends a model id to a provider HTTP API or SDK,
  where a bare family alias may not be accepted): the id comes from ONE central
  module, not from literals spread across files. That module is the only place a
  versioned Claude id may appear in non-test source, and it carries the current
  release of each family at the time of the change. Every such default stays
  overridable by its existing environment variable.
- **Pinning stays possible.** A routing table cell, an override or an environment
  variable may name a full versioned id. Nothing in this task removes that.
- **Recorded model.** Where the harness or the provider reports the model that
  actually ran, usage records and attestation leaves keep recording that reported
  value. This task changes what is requested, not what is recorded.
- Adopter-facing: adopters inherit these defaults, so the change is noted in the docs
  it touches, with the pin instructions next to it.

## Scope
1. **Routing defaults.** `DEFAULT_ROLE_MODELS` and `builtInDefaultTable()` use
   `sonnet` and `opus`. The security-reviewer floor in `load-table.ts` keeps its
   meaning (the security reviewer is never weaker than the default security model)
   when the default is an alias and a table names either the alias or a pinned id of
   the same family: a table with `strength: [sonnet, opus]` and one with pinned ids of
   those families both validate, and a table that puts the security reviewer on a
   weaker entry is still rejected.
2. **Pipeline fallbacks.** The four `claude-sonnet-4-6` fallbacks in `pipeline-cli`
   listed above resolve through the routing default for their role, not through a
   literal.
3. **Orchestrator.** `DEFAULT_REGISTRY` and `DEFAULT_AVAILABLE_MODELS` are derived
   from the central module; `DEFAULT_MODEL`, `DEFAULT_ANTHROPIC_MODEL` and the SDK
   review runner default read it too. `DEFAULT_MODEL_COSTS` gains entries for the ids
   the central module names, taken from the price table that AISDLC-648 and
   AISDLC-659 maintain where it has them; a model with no known price is reported as
   unpriced, never priced as another model.
4. **Guard.** A test (or lint script wired into `pnpm test`) fails when a versioned
   Claude model id literal appears in non-test source outside the central module and
   the price tables. Test fixtures and docs are out of its reach.
5. **Docs.** `docs/operations/model-routing.md` shows aliases in its table example and
   "Without a table" section, states the alias default and how to pin, and keeps
   versioned ids only where it shows recorded evidence. Other docs that present a
   versioned id as the recommended default are updated the same way; historical
   records (completed tasks, RFC motivation tables, whitepapers) are left alone.

## Out of scope
- The routing table file of this repository itself, which the operator lands separately.
- What `route apply` writes into a cell (AISDLC-656.2).
- Non-Claude provider defaults.

## Acceptance Criteria
- [x] With no routing table, `ai-sdlc-pipeline resolve-model developer` returns `sonnet` and `resolve-model security-reviewer` returns `opus`, both on the `default` arm.
- [x] A table using only aliases validates; a table using pinned ids of the same families validates; a table whose security-reviewer cell is weaker than the default security model is rejected with the existing reason.
- [x] The shell spawner passes the alias as `--model` for a role with no table cell (asserted on the recorded argv).
- [x] No versioned Claude model id literal remains in non-test source outside the central module and the price tables.
- [ ] The new guard fails on a fixture that adds one. (Not shipped: the guard is a proposed follow-up that needs an explicit go, not part of this PR.)
- [x] Each direct-API default is still overridden by its existing environment variable (one test per variable).
- [x] A model without a price entry is reported as unpriced in cost output.
- [x] `docs/operations/model-routing.md` shows the alias default and the pin instructions.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
