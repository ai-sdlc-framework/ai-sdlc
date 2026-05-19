---
id: RFC-0038
title: Adopter-Defined Reviewer Extension Point
status: Draft
lifecycle: Draft
author: alexanderkline13@gmail.com
created: 2026-05-19
updated: 2026-05-19
targetSpecVersion: v1alpha1
requires: [RFC-0010, RFC-0037]
relatedRFCs: [RFC-0014]
requiresDocs: []
---

# RFC-0038: Adopter-Defined Reviewer Extension Point

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

## 9. References

- Existing reviewer agents: `ai-sdlc-plugin/agents/{code,test,security}-reviewer.md`
- AISDLC-141 classifier implementation: `pipeline-cli/src/cli/classify-pr.ts`
- AISDLC-142 incremental review: `pipeline-cli/src/cli/incremental-decide.ts`
- Existing adopter configuration: `.ai-sdlc/pipeline.yaml`, `.ai-sdlc/agent-role.yaml`
- Related RFCs: RFC-0037 (adopter context), RFC-0010 (parallel execution)
