---
id: RFC-0039
title: Adopter-Defined Pipeline Gate Extension
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-19
updated: 2026-06-09
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0012]
relatedRFCs: [RFC-0037, RFC-0038, RFC-0022]
requiresDocs: []
---

# RFC-0039: Adopter-Defined Pipeline Gate Extension

**Status:** Draft
**Lifecycle:** Draft
**Author:** Alexander Kline (Product owner contribution)
**Created:** 2026-05-19
**Updated:** 2026-06-09
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — Dominique Legault
- [ ] Product owner — Alexander Kline

## 1. Summary

The `/ai-sdlc execute` Step 0-13 pipeline currently has a fixed gate set: orchestrator state check, dependency preflight, validation, attestation verification, coverage, build, lint, format. Each gate is hardcoded in the slash command body or pipeline-cli. Adopter projects need gates the framework doesn't ship — production-consumer-trace verification, doc-frontmatter currency, CARE-domain content validation, PHI scanning, semver compliance, telemetry-instrumentation completeness.

This RFC proposes a pipeline gate extension contract: adopters register additional gates via configuration, and pipeline-cli invokes them at well-defined stage hooks (post-dev / pre-review / pre-push / pre-merge-flip). The framework defines the interface + invocation timing; the adopter ships the gate logic.

## 2. Motivation

### The gate-discipline mismatch

The framework ships gates for **universally-applicable correctness**:
- Build / test / lint / format pass
- Attestation signed (RFC-0010 §13)
- Dependency preflight satisfied (AISDLC-117)
- Definition-of-Ready satisfied (RFC-0011)
- Skip-CI markers absent (AISDLC-88)

These are necessary baseline. Adopters layer additional gates on top for **domain-specific correctness**:

- An adopter committed to architect-doc currency needs a gate that verifies every commit touching a `produces:` code path also bumps the corresponding architect doc's `last_verified` date
- An adopter in regulated industries needs a gate that scans dev artifacts for PHI / PII before push
- An adopter shipping a multi-tenant SaaS needs a gate that verifies RLS policies cover every new table
- An adopter with strict API stability needs a gate that enforces "no breaking changes without ADR + deprecation period"
- An adopter committed to "no dead wires" (substrate shipped → must have non-test consumer) needs a gate that verifies `consumer: <path:line>` in commit messages

Currently adopters bolt these on via husky hooks or GitHub Actions, which works but:
- Doesn't compose with the pipeline's structured stage-hooks (gate runs in the wrong place — too early or too late)
- Doesn't have access to pipeline-cli's stage state (e.g., the classifier decision, the reviewer verdicts)
- Can't fail-closed with the same operator-friendly error messages the framework's gates produce

### Why this is structurally framework concern

Each adopter's gate logic is adopter-domain (correct). But the **gate invocation contract** is universal — when to fire, what state to expose, how to return pass/fail, how to render the operator-facing failure message. That contract belongs in the framework.

## 3. Goals and Non-Goals

### Goals

- Adopters register additional gates via `.ai-sdlc/gates.yaml`
- pipeline-cli invokes adopter gates at well-defined stage hooks
- Adopter gates have read access to pipeline state (current step, classifier decision, reviewer verdicts, dev verifications)
- Gate failure produces operator-friendly error with recovery instructions (matching framework gate style)
- Backward-compatible (no `.ai-sdlc/gates.yaml` = no behavior change)

### Non-Goals

- Adopter gates writing to pipeline state (read-only access)
- Replacing framework gates (defaults remain mandatory)
- Multi-stage gates that run across pipeline steps (each adopter gate is single-stage)
- Gates that modify the codebase (those are pre-commit hooks, different layer)

## 4. Proposed Mechanism

### 4.1 Adopter gate registration

`.ai-sdlc/gates.yaml`:

```yaml
adopterGates:
  - id: production-consumer-trace
    stage: pre-push                          # well-known stage hook
    command: scripts/check-consumer-trace.sh # adopter-provided executable
    description: "Verify commit messages include 'consumer: <path:line>' for substrate additions"
    severity: error                          # error | warning
    skipIf: docs-only                        # optional skip condition (uses classifier output)

  - id: architect-doc-currency
    stage: post-dev
    command: tsx scripts/check-architect-doc-currency.ts
    description: "Bump last_verified on touched produces: paths"
    severity: warning
    skipIf: never
```

### 4.2 Stage hooks

Well-known hooks pipeline-cli invokes adopter gates at:

| Hook | Pipeline step | Pipeline state available |
|------|---------------|----------------------------|
| `post-orchestrator-state` | Step 0 end | nothing yet |
| `post-validation` | Step 1 end | task validated |
| `post-dev` | Step 6 end | dev output JSON, classifier ready to run |
| `post-classifier` | Step 7a end | classifier decision known |
| `post-reviewers` | Step 8 end | reviewer verdicts aggregated |
| `pre-push` | Step 10 end | task marked Done, verdict file written |
| `pre-ready-for-review` | Step 13 begin | draft PR open, signed envelope present |

Adopter gates specify which hook to fire at. Multiple gates per hook are sequential (in `.ai-sdlc/gates.yaml` order).

### 4.3 Gate invocation contract

Adopter gate executable receives via environment variables:

```
AI_SDLC_GATE_STAGE        # the hook this fired at
AI_SDLC_TASK_ID           # current task being executed
AI_SDLC_BRANCH            # feature branch name
AI_SDLC_WORKTREE_PATH     # absolute path to worktree
AI_SDLC_PIPELINE_STATE    # path to a JSON file with current pipeline state
                          # (classifier decision, dev verifications, reviewer verdicts)
```

Exit code: 0 = pass, non-zero = fail. Stderr captured for operator-facing error message.

### 4.4 Failure semantics

`severity: error` failure aborts the pipeline at that step, surfaces stderr to operator, preserves worktree for inspection (matching framework gate behavior).

`severity: warning` failure logs but continues. Useful for soft-warning gates during bootstrap.

### 4.5 Skip conditions

`skipIf: docs-only` — gate skipped when classifier classified the PR as docs-only (no code paths touched).

`skipIf: <classifier-key>` — gate skipped when classifier returned a specific subset.

`skipIf: never` — always run.

## 5. Backward Compatibility

Fully backward-compatible. Adopters who don't ship `.ai-sdlc/gates.yaml` see no behavior change.

## 6. Composition with Other RFCs

- **RFC-0037 (adopter project context)**: adopter gates can read `.ai-sdlc/project-context.md` for context-aware checks
- **RFC-0038 (adopter-defined reviewers)**: gates run BEFORE or AFTER reviewers depending on stage hook; reviewer findings can inform gate logic
- **RFC-0022 (compliance posture audit surface)**: adopter compliance gates would naturally compose with the audit-surface model
- **RFC-0012 (two-tier pipeline architecture)**: gates are second-tier — adopter-defined, optional, composable

## 7. Alternatives Considered

### 7.1 husky / GitHub Actions only

Existing options. Doesn't compose with pipeline-cli's structured state. Wrong layer.

### 7.2 Single mega-script that adopter wires into pre-push

Adopter writes one orchestrating script that does all their domain-specific checks. Loses the per-gate stage-hook + skip-conditions + severity model.

### 7.3 Framework ships a "gate-pack" registry

Heavier proposal — framework curates gate packs adopters can register (e.g., "fintech compliance pack", "healthcare PHI pack"). Useful but premature; RFC-0039 stays adopter-local.

## 8. Open Questions

1. **Concurrent gate execution**: should gates at the same stage hook run in parallel or sequential? Parallel is faster but harder to debug.
2. **State JSON schema**: what exactly should `AI_SDLC_PIPELINE_STATE` expose? Minimum useful set without over-coupling adopter gates to framework internals.
3. **Gate timeout**: how long can an adopter gate run before pipeline-cli kills it? Default 30s? Configurable per-gate?
4. **Gate-against-gate composition**: should adopter gates be able to skip themselves based on other gates' results? Probably no for v1; revisit if it surfaces as adopter pain.
5. **Concurrent vs sequential same-stage plugin execution**: when multiple in-process `afterRun` plugins are registered and fire at the same stage, should the orchestrator invoke them sequentially (predictable order, simpler error attribution) or concurrently (lower latency but harder to debug conflicting decisions)?
6. **`AI_SDLC_PIPELINE_STATE` schema stability contract**: what is the versioning and stability contract for the `AI_SDLC_PIPELINE_STATE` JSON file exposed to subprocess gates AND the `AfterRunEvent` exposed to in-process plugins? Should the framework emit a `pipelineStateVersion` field so plugins can self-protect against schema evolution?
7. **Gate timeout for in-process `afterRun` plugins**: the §4 config-file path has a configurable per-gate timeout for subprocess executables. Should in-process `afterRun` plugins be subject to a similar framework-enforced timeout, or are they trusted to be well-behaved (since they are registered by the adopter at install time)?
8. **Gate-against-gate composition via `context.store`**: if plugin A writes `auto-merge:<pr>: hold` and plugin B writes `auto-merge:<pr>: permit`, the orchestrator treats the `hold` as blocking. Should the orchestrator also expose the full set of `GatePluginDecision` records to each subsequent plugin (so plugin B can inspect plugin A's decision before writing its own)? Or should each plugin write independently with the orchestrator doing final aggregation?

## 9. References

- Existing framework gates: `scripts/check-attestation-sign.sh`, `scripts/check-skip-ci-marker.sh`, `scripts/check-task-moved.sh`
- pipeline-cli stage structure: `pipeline-cli/src/steps/`
- Composing RFCs: RFC-0010, RFC-0012, RFC-0037, RFC-0038
- Related: RFC-0022 (compliance posture)
- `OrchestratorPlugin` contract: `orchestrator/src/plugin.ts`
- `CostGovernancePlugin` reference implementation: `orchestrator/src/cost-governance.ts`

## 10. Complementary in-process plugin path

### 10.1 Motivation

The §4 config-file path (`.ai-sdlc/gates.yaml` + stage-hook executables) covers gate concerns that are fire-and-forget at a well-known pipeline stage and need only the env-var pipeline state. It does not serve adopters who need:

- **Cross-cycle decision persistence** via `PluginContext.store` (e.g., accumulating merge eligibility signals across multiple PR iterations)
- **Unified log capture** via the orchestrator's `Logger` (structured, timestamped, routed to the same sink as framework logs)
- **Typed event access** to the `AfterRunEvent` shape, including the full `PipelineResult` with reviewer verdicts, classifier decision, and dev verifications
- **Multi-tier auto-merge arbitration** — e.g., a 6-gate / 3-tier policy with hardcoded forbidden-list invariants that span multiple label dimensions

These adopters benefit from in-process plugin integration via `OrchestratorPlugin.afterRun` with a typed store-decision contract. The §10 path and the §4 path are **non-exclusive** — adopters choose per-gate based on whether the concern is stage-fire-and-forget (config-file executable) or stateful merge-arbitration (in-process plugin).

### 10.2 `afterRun` store-decision contract

`afterRun` SHALL NOT throw to block merge. The run is already complete when `afterRun` fires; throwing is ambiguous semantics (should the framework retry? rollback? the run succeeded — only the merge gate is uncertain). Instead, the plugin SHALL write a typed `GatePluginDecision` record to `context.store` under the canonical key `auto-merge:<pr-number>` (or `auto-merge:<task-id>` for backlog-task pipelines).

The orchestrator's merge step SHALL read the latest decision record(s) under the canonical key and actuate accordingly:
- If any decision has `decision: 'hold'` or `decision: 'error'`, the merge step is blocked.
- If all decisions have `decision: 'permit'`, the merge step proceeds (subject to framework gate checks).
- Multiple plugins MAY write decisions under the same canonical key. The orchestrator MUST aggregate by treating any `hold` or `error` as blocking, regardless of order.

### 10.3 `GatePluginDecision` shape

```typescript
interface GatePluginDecision {
  /** Merge-gate outcome. */
  decision: 'permit' | 'hold' | 'error';

  /**
   * Optional auto-merge tier. When absent, the plugin's permit/hold applies
   * at all tiers. When present, the framework applies tier-specific policy
   * (e.g., 'conservative' requires additional human review; 'aggressive'
   * permits merge on passing LLM verdicts alone).
   */
  tier?: 'conservative' | 'normal' | 'aggressive' | 'off';

  /** Plugin name, for audit trail attribution. */
  gatePluginName: string;

  /** ISO 8601 timestamp when the decision was written. */
  timestamp: string;

  /** Human-readable reason for the decision. Surfaces in operator error messages. */
  reason: string;

  /**
   * Optional structured gate results for multi-gate policies.
   * Each entry documents one gate check with its pass/fail outcome and detail.
   */
  gateResults?: Array<{
    gateName: string;
    passed: boolean;
    detail: string;
  }>;
}
```

### 10.4 The forbidden-list pattern

A common adopter safety requirement is a **forbidden-list**: a set of label combinations, file paths, or PR attributes that MUST block merge regardless of tier and regardless of reviewer verdicts. The `afterRun` plugin path is the correct layer for implementing forbidden-lists because:

1. The plugin has access to the full `PipelineResult` (including all reviewer verdicts) via `AfterRunEvent.result`
2. The `decision: 'hold'` outcome is treated as blocking at ALL tiers — it cannot be overridden by framework-level auto-merge tier promotion
3. The decision record survives across orchestrator restarts via `context.store`

Example forbidden-list pattern:

```typescript
async afterRun(event: AfterRunEvent): Promise<void> {
  const pr = event.result.prMeta;
  const forbidden = this.forbiddenList.check(pr.labels, pr.files);
  if (forbidden.matched) {
    await this.store.set(`auto-merge:${pr.number}`, {
      decision: 'hold',
      gatePluginName: this.name,
      timestamp: new Date().toISOString(),
      reason: `Forbidden-list match: ${forbidden.reason}. Human review required.`,
      gateResults: forbidden.matches.map((m) => ({
        gateName: m.ruleId,
        passed: false,
        detail: m.detail,
      })),
    } satisfies GatePluginDecision);
    return;
  }
  // ... tier evaluation ...
}
```

The forbidden-list pattern is a documented adopter primitive. Framework documentation SHOULD include a worked example of this pattern for adopters with hardcoded safety invariants.

### 10.5 Reference TypeScript shim

The following is a reference shape for an in-process merge-gate plugin. It mirrors the `CostGovernancePlugin` pattern in `orchestrator/src/cost-governance.ts`.

```typescript
// .ai-sdlc/plugins/merge-tier-gate-plugin.ts
//
// In-process merge-gate plugin: enforces a 3-tier auto-merge policy with
// forbidden-list invariants via OrchestratorPlugin.afterRun.
//
// Contract: afterRun SHALL NOT throw. Writes GatePluginDecision to store.

import type {
  OrchestratorPlugin,
  PluginContext,
  AfterRunEvent,
} from '@ai-sdlc/orchestrator';

type AutoMergeTier = 'conservative' | 'normal' | 'aggressive' | 'off';

interface GatePluginDecision {
  decision: 'permit' | 'hold' | 'error';
  tier?: AutoMergeTier;
  gatePluginName: string;
  timestamp: string;
  reason: string;
  gateResults?: Array<{ gateName: string; passed: boolean; detail: string }>;
}

export class MergeTierGatePlugin implements OrchestratorPlugin {
  name = 'merge-tier-gate';

  private store!: PluginContext['store'];
  private log!: PluginContext['log'];

  initialize(ctx: PluginContext): void {
    this.store = ctx.store;
    this.log = ctx.log;
  }

  async afterRun(event: AfterRunEvent): Promise<void> {
    const prNumber = event.result.prMeta?.number;
    if (!prNumber) {
      this.log.info('[merge-tier-gate] no PR number; skipping gate evaluation');
      return;
    }

    const storeKey = `auto-merge:${prNumber}`;
    const timestamp = new Date().toISOString();

    try {
      const decision = this.evaluateMergeGate(event);
      await this.store?.set(storeKey, decision);
      this.log.info(
        `[merge-tier-gate] wrote decision ${decision.decision} (tier: ${decision.tier ?? 'all'})`,
      );
    } catch (err) {
      // afterRun MUST NOT throw — write an error decision instead
      const errorDecision: GatePluginDecision = {
        decision: 'error',
        gatePluginName: this.name,
        timestamp,
        reason: `Plugin evaluation error: ${err instanceof Error ? err.message : String(err)}`,
      };
      await this.store?.set(storeKey, errorDecision);
      this.log.info('[merge-tier-gate] plugin-internal error; wrote error decision to store');
    }
  }

  private evaluateMergeGate(event: AfterRunEvent): GatePluginDecision {
    const timestamp = new Date().toISOString();
    const prNumber = event.result.prMeta?.number!;
    const labels = event.result.prMeta?.labels ?? [];

    // Forbidden-list: these label combinations block merge at any tier
    if (labels.includes('security-review-required')) {
      return {
        decision: 'hold',
        gatePluginName: this.name,
        timestamp,
        reason: 'Label security-review-required present; human security review mandatory.',
        gateResults: [{ gateName: 'forbidden-label-check', passed: false, detail: 'security-review-required' }],
      };
    }

    // Tier evaluation (simplified example)
    const allApproved = event.result.reviewerVerdicts?.every((v) => v.approved) ?? false;
    return {
      decision: allApproved ? 'permit' : 'hold',
      tier: allApproved ? 'normal' : undefined,
      gatePluginName: this.name,
      timestamp,
      reason: allApproved
        ? 'All reviewer verdicts approved; normal-tier merge permitted.'
        : 'One or more reviewers requested changes; merge held.',
    };
  }
}
```

This shim is approximately 80 lines. The `GatePluginDecision` shape is written to `context.store`; the framework's merge step reads it at the appropriate pipeline stage.

### 10.6 Relationship to §4 stage-hook config-file path

The in-process plugin path (§10) and the config-file stage-hook path (§4) are complementary:

| Dimension | §4 config-file stage hook | §10 in-process `afterRun` plugin |
|-----------|--------------------------|----------------------------------|
| Invocation point | Well-defined stage hook (pre-push, post-dev, etc.) | `afterRun` — after full pipeline completes |
| Access to pipeline state | Env-var JSON file (`AI_SDLC_PIPELINE_STATE`) | Typed `AfterRunEvent` + full `PipelineResult` |
| Cross-cycle persistence | None (stateless per invocation) | `PluginContext.store` (persistent KV) |
| Authoring surface | Any executable (shell, Python, Go) | TypeScript shim implementing `OrchestratorPlugin` |
| Merge-gate semantics | Exit code blocks pipeline at stage | `GatePluginDecision` written to store; read at merge step |
| Forbidden-list support | Expressible (exit non-zero) | First-class documented pattern (§10.4) |

Adopters who need both stage-level pre-checks (§4) and post-pipeline merge arbitration (§10) register both. The framework invokes them independently; their outcomes compose additively (any hold blocks).
