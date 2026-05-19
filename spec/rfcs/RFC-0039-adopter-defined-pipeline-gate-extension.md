---
id: RFC-0039
title: Adopter-Defined Pipeline Gate Extension
status: Draft
lifecycle: Draft
author: alexanderkline13@gmail.com
created: 2026-05-19
updated: 2026-05-19
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0012]
relatedRFCs: [RFC-0037, RFC-0038, RFC-0022]
requiresDocs: []
---

# RFC-0039: Adopter-Defined Pipeline Gate Extension

**Status:** Draft
**Lifecycle:** Draft
**Author:** alexanderkline13@gmail.com (Product owner contribution)
**Created:** 2026-05-19
**Updated:** 2026-05-19
**Target Spec Version:** v1alpha1

---

## Sign-Off

- [ ] Engineering owner — dominique@reliablegenius.io
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

## 9. References

- Existing framework gates: `scripts/check-attestation-sign.sh`, `scripts/check-skip-ci-marker.sh`, `scripts/check-task-moved.sh`
- pipeline-cli stage structure: `pipeline-cli/src/steps/`
- Composing RFCs: RFC-0010, RFC-0012, RFC-0037, RFC-0038
- Related: RFC-0022 (compliance posture)
