---
id: RFC-0038
title: Adopter-Defined Reviewer Extension Point
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-19
updated: 2026-06-09
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0037]
relatedRFCs: [RFC-0014]
requiresDocs: []
---

# RFC-0038: Adopter-Defined Reviewer Extension Point

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

The plugin currently ships three reviewer agents (code-reviewer, test-reviewer, security-reviewer) wired into `/ai-sdlc execute` Step 7 fan-out and AISDLC-141's classifier-gated subset. Adopter projects develop domain-specific quality concerns that don't map cleanly onto these three — doc-conformance, compliance, accessibility, narrative consistency, API stability, telemetry instrumentation, etc.

Currently adopters' only options are (a) inline domain-specific concerns into the existing reviewer prompts via project-local `.claude/agents/<name>.md` overrides (couples concerns, hard to evolve independently), or (b) fork the plugin to add a new reviewer agent type (defeats framework value). This RFC proposes a reviewer extension contract: adopters register additional reviewer types via configuration, and the classifier + dispatch pipeline treat them as first-class.

## 2. Motivation

### The reviewer-quality-concern mismatch

The three default reviewers cover **general-purpose software quality**:
- code-reviewer: structural quality, conventions, anti-patterns
- test-reviewer: test coverage, test quality
- security-reviewer: OWASP class concerns, secrets, auth

These are necessary but not sufficient for adopter projects with **domain-specific quality concerns**:

- An adopter shipping architectural documentation needs a reviewer that validates doc-frontmatter, link integrity, currency dates, cross-references
- An adopter in regulated industries needs a reviewer that scans for PHI / PII / financial-data leakage in dev artifacts
- An adopter shipping public APIs needs a reviewer that validates breaking-change discipline + semver
- An adopter shipping accessibility-critical UIs needs a reviewer that runs WCAG validation
- An adopter shipping telemetry-instrumented services needs a reviewer that validates metric naming + cardinality + retention

In every case, the adopter has crisp, repeatable validation criteria that don't fit the three default reviewers. Forking the plugin or wrapping every dispatch is the wrong answer; the framework should provide the extension contract.

### Why this composes well with the classifier (AISDLC-141)

AISDLC-141 already gates which of the three default reviewers fire based on PR content classification. Adding adopter-defined reviewers to this contract is incremental — the classifier learns to recognize new reviewer-relevant content patterns; the fan-out decision becomes a 0-to-N subset selection across the union of {default reviewers} ∪ {adopter-defined reviewers}.

The classifier's fail-open property (AISDLC-141 AC-4) extends naturally: when classifier confidence falls below threshold, fire ALL reviewers including adopter-defined.

## 3. Goals and Non-Goals

### Goals

- Adopters can register additional reviewer agent types via configuration
- Adopter-defined reviewers participate in classifier-gated fan-out (AISDLC-141)
- Adopter-defined reviewer verdicts integrate into existing aggregation gate (Step 8)
- Verdict shape standardized — adopter reviewers emit the same `{approved, findings, summary}` JSON contract as default reviewers
- Framework remains agnostic about WHAT adopter-defined reviewers check

### Non-Goals

- Framework prescribing specific adopter-reviewer types (no "compliance-reviewer baked in")
- Replacing default reviewers (they remain mandatory baseline)
- Multi-stage reviewer pipelines (each reviewer is single-stage, parallel-with-others)
- Reviewer-against-reviewer cross-talk during single dispatch (out of scope for this RFC)

## 4. Proposed Mechanism

### 4.1 Adopter reviewer registration

New configuration file: `.ai-sdlc/reviewers.yaml` (composes with `.ai-sdlc/pipeline.yaml`).

Schema:

```yaml
adopterReviewers:
  - id: doc-conformance-reviewer
    agentDefinition: .claude/agents/doc-conformance-reviewer.md
    classifierKey: docs
    fanOutWeight: required | optional | classified-only
    description: "Validates frontmatter standard, cross-link integrity, currency dates"

  - id: accessibility-reviewer
    agentDefinition: .claude/agents/accessibility-reviewer.md
    classifierKey: ui
    fanOutWeight: classified-only
    description: "Validates WCAG 2.1 AA compliance on touched UI components"
```

### 4.2 Classifier extension

`cli-classify-pr` (AISDLC-141) extended:
- Recognizes adopter-defined `classifierKey` values
- Returns the union subset across default + adopter-defined reviewers
- `fanOutWeight: required` means "always fire" (overrides classifier subset)
- `fanOutWeight: optional` means "fire if classifier confidence high"
- `fanOutWeight: classified-only` means "fire only when classifier explicitly returns this reviewer key"

### 4.3 Verdict aggregation

Adopter-defined reviewer verdicts use the same JSON contract as defaults:

```json
{
  "approved": true | false,
  "findings": [
    { "severity": "critical|major|minor|suggestion", "file": "...", "line": N, "message": "..." }
  ],
  "summary": "..."
}
```

Step 8 aggregation in `/ai-sdlc execute` treats adopter-defined reviewer findings identically to default reviewer findings for the CHANGES_REQUESTED vs APPROVED gate decision.

### 4.4 Incremental review (AISDLC-142) composition

The content-hash skip + delta-only logic from AISDLC-142 applies to adopter-defined reviewers identically. Adopters get the same review-reuse savings.

## 5. Backward Compatibility

Fully backward-compatible. Adopters who don't ship `.ai-sdlc/reviewers.yaml` see no behavior change. Default reviewers continue to fire per existing AISDLC-141 logic.

## 6. Composition with Other RFCs

- **RFC-0010 (parallel execution)**: adopter-defined reviewers run in parallel with defaults during Step 7 fan-out
- **RFC-0014 (dependency graph)**: classifier subset extension is a graph-aware decision (already handles deps); no new graph layer needed
- **RFC-0037 (adopter project context)**: adopter-defined reviewers inherit the same `.ai-sdlc/project-context.md` prepend as defaults
- **AISDLC-141 (classifier-gated review)**: this RFC extends the reviewer set the classifier chooses from
- **AISDLC-142 (incremental review)**: adopter reviewers get same content-hash skip + delta-only treatment

## 7. Alternatives Considered

### 7.1 Per-agent prompt extension via `.claude/agents/<default-reviewer>.md` overrides

Adopters can already override `.claude/agents/code-reviewer.md` etc. to add domain-specific checks. Works for small additions; couples concerns (code quality + accessibility in one reviewer) and makes the override hard to evolve.

### 7.2 Adopter pre-commit / pre-PR scripts

Adopters can wire domain-specific checks via husky / GitHub Actions. Works for binary pass/fail gates but doesn't participate in the classifier-gated dispatch + verdict aggregation model. Loses the reviewer agent's natural-language finding-capture capability.

### 7.3 Plugin extension API

A heavier proposal — register reviewers via a programmatic API rather than configuration. Higher engineering investment; configuration-file approach matches the framework's existing adopter-config conventions.

## 8. Open Questions

1. **Hard cap on reviewer count**: per-PR fan-out at scale (e.g., 10+ adopter-defined reviewers) — should the framework cap this for resource discipline? Or trust the classifier to subset?
2. **Reviewer registration validation**: should `.ai-sdlc/reviewers.yaml` be schema-validated at dispatch time? Or lazy-loaded only when the agent file is referenced?
3. **Veto semantics**: should adopter-defined reviewer findings have the same APPROVED/CHANGES_REQUESTED weight as defaults, or be advisory-only by default?
4. **Cross-adopter reviewer sharing**: should the framework optionally support reviewer-definition sharing (e.g., npm-published reviewer packs) or stay strictly per-adopter-local?
5. **Subprocess wrapping encourage/discourage**: should the framework actively encourage the subprocess-plugin path for policy-heavy reviewers, or position it as a last-resort escape hatch? What documentation and validation support should ship alongside the pattern?
6. **Frontier discovery via cli-deps vs PluginContext extension**: when a subprocess-plugin reviewer needs access to the framework's dependency graph (e.g., to enforce shard/lane label constraints against known task topology), should it receive this via a cli-deps snapshot path injected by the harness, or via an explicit `PluginContext` extension (e.g., `context.frontier`)?
7. **Operator overrides — per-plugin vs framework `--skip-plugin=` flag**: should the operator be able to skip a specific subprocess-plugin reviewer at dispatch time via a per-plugin `skipIf:` condition in `.ai-sdlc/reviewers.yaml`, or via a framework-level `--skip-plugin=<name>` flag passed to the dispatch command?
8. **Distinguishing exit-code-1 vs exit-code-2 in audit trail**: how should the framework surface exit-code-1 (gate-fail, structured policy violation) vs exit-code-2 (plugin-internal error) distinctly in the verdict JSON and operator audit trail? Should the verdict `approved: false` carry a `failureKind: 'policy-gate' | 'plugin-error'` discriminant?
9. **Optional `ReviewerPlugin extends OrchestratorPlugin` typed interface**: should the framework ship a typed `ReviewerPlugin` interface that extends `OrchestratorPlugin` with reviewer-specific metadata (e.g., `classifierKey`, `fanOutWeight`, `verdictShape`)? Or is the untyped `OrchestratorPlugin` + runtime duck-typing sufficient for v1?

## 9. References

- Existing reviewer agents: `ai-sdlc-plugin/agents/{code,test,security}-reviewer.md`
- AISDLC-141 classifier implementation: `pipeline-cli/src/cli/classify-pr.ts`
- AISDLC-142 incremental review: `pipeline-cli/src/cli/incremental-decide.ts`
- Existing adopter configuration: `.ai-sdlc/pipeline.yaml`, `.ai-sdlc/agent-role.yaml`
- Related RFCs: RFC-0037 (adopter context), RFC-0010 (parallel execution)
- `OrchestratorPlugin` contract: `orchestrator/src/plugin.ts`
- `CostGovernancePlugin` reference implementation: `orchestrator/src/cost-governance.ts`

## 10. Complementary subprocess-plugin path

### 10.1 Motivation

The §4 config-file path (`.ai-sdlc/reviewers.yaml` + `agentDefinition`) covers **Class A** reviewer concerns — judgment-heavy, LLM-native, prose-finding-capture. It is not the right layer for **Class B** concerns — policy-heavy, deterministic, exit-code pass/fail:

- Label invariant enforcement (e.g., required `shard:` / `lane:` / `dispatch:` prefixes on every dispatched ticket)
- Dependency-graph constraint validation (e.g., no PR merges a module that breaks a declared consumer contract)
- License allowlist enforcement
- Schema-shape conformance checks
- Project-specific naming-convention linting

Expressing Class B concerns as LLM agents is wasteful and non-reproducible. Expressing them as GitHub Actions CI lints fires too late (post-dispatch). The subprocess-plugin path fills this gap: adopters author their policy in Python/Go/Rust/shell, wrap it in a thin TypeScript shim that implements `OrchestratorPlugin`, and register the shim in `.ai-sdlc/plugins.yaml`. The framework calls `beforeRun`; the shim calls `spawnSync` on the policy binary; the exit code determines gate outcome.

The two paths are **non-exclusive**. Adopters pick per-reviewer based on whether the concern is judgment-heavy (config-file LLM agent) or policy-heavy (subprocess plugin). A single `.ai-sdlc` config can register both.

### 10.2 `beforeRun` throw-to-block semantics

The existing `OrchestratorPlugin.beforeRun` contract (see `orchestrator/src/plugin.ts`) already defines the throw-to-block behavior:

> If `beforeRun` throws, the orchestrator MUST treat the exception as a hard gate. No developer-fleet agent spawn occurs. The exception message (or a structured `ReviewerGateError`) is emitted as a verdict:
>
> ```json
> {
>   "approved": false,
>   "findings": [{ "severity": "critical", "file": "", "line": 0, "message": "<exception message>" }],
>   "summary": "Reviewer gate blocked dispatch: <exception message>"
> }
> ```

This behavior is implemented in the orchestrator's pipeline loop and requires no new contract changes. The subprocess-plugin path lifts this existing behavior by throwing from `beforeRun` when the subprocess exits non-zero.

### 10.3 Exit-code convention

Adopters MUST use the following three-code convention. No other exit codes are reserved for this pattern.

| Exit code | Meaning | Plugin behavior |
|-----------|---------|-----------------|
| `0` | Policy check passed | `beforeRun` returns normally; dispatch proceeds |
| `1` | Gate fail (structured policy violation) | `beforeRun` throws with structured findings extracted from subprocess stderr/stdout |
| `2` | Plugin-internal error (non-policy) | `beforeRun` throws fail-closed; verdict captures error context |

Exit code `1` signals a **deterministic policy violation** — the subprocess found specific, actionable findings (e.g., unlabeled tickets, disallowed licenses). Exit code `2` signals an **operational error** — the subprocess could not complete its check (misconfiguration, missing dependency, I/O failure). The framework MUST treat both as blocking, but the operator-facing error message SHOULD distinguish them so operators can route to the right remediation path (fix the PR vs fix the plugin).

Adopter subprocess scripts MUST NOT use exit codes other than 0, 1, or 2. Exit code `127` (command not found) and similar shell-level failures are treated as exit code `2` (plugin-internal error) by the shim.

### 10.4 Cross-language by design

The subprocess shim is thin TypeScript. The policy logic is authored in the adopter's language of choice. The framework makes no assumptions about the language of the subprocess binary.

### 10.5 Reference TypeScript shim

The following is a reference shape for a subprocess-plugin reviewer. It mirrors the `CostGovernancePlugin` pattern in `orchestrator/src/cost-governance.ts`.

```typescript
// .ai-sdlc/plugins/label-policy-reviewer.ts
//
// Subprocess-plugin reviewer shim: enforces S196 label invariants by
// delegating to an adopter-authored Python policy module.
//
// Exit-code convention:
//   0  — pass (all tickets labelled correctly; dispatch proceeds)
//   1  — gate-fail (structured findings in stderr JSON; dispatch blocked)
//   2  — plugin-internal error (misconfiguration, I/O failure; fail-closed)

import { spawnSync } from 'node:child_process';
import type {
  OrchestratorPlugin,
  PluginContext,
  BeforeRunEvent,
} from '@ai-sdlc/orchestrator';

interface LabelPolicyFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  file: string;
  line: number;
  message: string;
}

interface LabelPolicyResult {
  approved: boolean;
  findings: LabelPolicyFinding[];
  summary: string;
}

export class LabelPolicyReviewerPlugin implements OrchestratorPlugin {
  name = 'label-policy-reviewer';

  private log!: PluginContext['log'];

  initialize(ctx: PluginContext): void {
    this.log = ctx.log;
  }

  async beforeRun(event: BeforeRunEvent): Promise<void> {
    this.log.info(`[label-policy-reviewer] checking labels for issue ${event.issueId}`);

    const result = spawnSync(
      'python3',
      ['scripts/check_label_policy.py', '--issue-id', event.issueId, '--format', 'json'],
      { encoding: 'utf-8', timeout: 30_000 },
    );

    // Exit code 2 or spawn error → fail-closed, plugin-internal error
    if (result.error || result.status === 2) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? 'unknown error';
      throw new Error(`[label-policy-reviewer] plugin-internal error: ${detail}`);
    }

    // Exit code 1 → gate fail, parse structured findings from stdout
    if (result.status === 1) {
      let parsed: LabelPolicyResult;
      try {
        parsed = JSON.parse(result.stdout) as LabelPolicyResult;
      } catch {
        // Non-JSON stderr fallback
        throw new Error(
          `[label-policy-reviewer] gate blocked: ${result.stderr?.trim() ?? result.stdout?.trim()}`,
        );
      }
      const findingLines = parsed.findings
        .map((f) => `  [${f.severity}] ${f.message}`)
        .join('\n');
      throw new Error(
        `[label-policy-reviewer] label policy violated:\n${findingLines}\n${parsed.summary}`,
      );
    }

    // Exit code 0 → pass; return normally
    this.log.info('[label-policy-reviewer] label policy satisfied; dispatch proceeding');
  }
}
```

This shim is approximately 60 lines. The policy logic (the Python module invoked via `spawnSync`) is authored and maintained by the adopter, independent of the framework. The framework's only contract with the subprocess is the three-code exit-code convention.

### 10.6 Relationship to §4.1 config-file path

The subprocess-plugin path (§10) and the config-file LLM-agent path (§4.1) are complementary, not competing:

| Dimension | §4.1 config-file LLM agent | §10 subprocess plugin |
|-----------|----------------------------|----------------------|
| Concern type | Judgment-heavy, prose-finding | Policy-heavy, deterministic |
| Authoring language | Claude agent prompt + `reviewers.yaml` | Any language; TypeScript shim wrapper |
| Reproducibility | Non-deterministic (LLM) | Deterministic (binary gate) |
| Classifier integration | Via `classifierKey` field | Optional `classifierKey` on plugin (deferred) |
| Fan-out integration | Step 7 fan-out | `beforeRun` hook (pre-dispatch) |

The §4.1 path fires in the Step 7 fan-out AFTER dispatch. The §10 path fires in `beforeRun` BEFORE dispatch. Adopters who need both Class A and Class B coverage register both types; the framework invokes them at their respective points in the pipeline lifecycle.
