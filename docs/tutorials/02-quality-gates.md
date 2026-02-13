# Tutorial 2: Adding Quality Gates

Quality gates are the enforcement mechanism of the AI-SDLC Framework. They define rules that must pass before work can proceed, using a three-tier enforcement model inspired by HashiCorp Sentinel:

- **Advisory** -- Violations are logged and reported, but the action proceeds. Use this for guidelines or new policies being validated.
- **Soft-mandatory** -- Violations block the action, but an authorized user can override with a justification. Use this for standard governance.
- **Hard-mandatory** -- Violations block the action with no override possible. Use this for security-critical or regulatory requirements.

This tutorial walks through creating QualityGate resources with metric-based, tool-based, and reviewer-based rules, then wiring them into pipeline stages.

## Prerequisites

- Completion of [Tutorial 1: Setting Up a Basic Pipeline](01-basic-pipeline.md)
- Familiarity with the pipeline stages and quality gate references from Tutorial 1

## Step 1: Create a Metric-Based Gate

Start with a test coverage gate. This uses a metric-based rule to require at least 80% line coverage. Set the enforcement to `soft-mandatory` so an engineering manager can override it in exceptional situations.

Create `gates/test-coverage.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: test-coverage
  namespace: team-alpha
spec:
  scope:
    repositories: ["org/service-*"]
    authorTypes: ["ai-agent"]
  gates:
    - name: line-coverage-check
      enforcement: soft-mandatory
      rule:
        metric: line-coverage
        operator: ">="
        threshold: 80
      override:
        requiredRole: engineering-manager
        requiresJustification: true
```

Key details:

- **scope** targets this gate to repositories matching `org/service-*` and only to changes authored by AI agents. Human-authored changes are not subject to this gate.
- The **rule** is metric-based: it compares the `line-coverage` metric against a threshold of 80 using the `>=` operator.
- The **override** block specifies that only users with the `engineering-manager` role can override a failure, and they must provide a justification.

## Step 2: Add a Tool-Based Gate

Security scanning should be non-negotiable. Add a tool-based gate that runs Semgrep and fails on any finding of medium severity or above. Use `hard-mandatory` enforcement -- no one can override a security scan failure.

Add a second gate to the same resource:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: security-standards
  namespace: team-alpha
spec:
  scope:
    authorTypes: ["ai-agent", "human"]
  gates:
    - name: semgrep-security-scan
      enforcement: hard-mandatory
      rule:
        tool: semgrep
        maxSeverity: medium
        rulesets:
          - "owasp-top-10"
```

Key details:

- **scope** applies to both AI agents and humans -- security scanning applies to everyone.
- The **rule** is tool-based: it runs `semgrep` with the `owasp-top-10` ruleset and rejects any finding with severity `medium` or higher (i.e., medium, high, or critical findings cause failure).
- There is **no override block** because `hard-mandatory` gates cannot be overridden. Even if you include one, it will be ignored.

## Step 3: Add a Reviewer-Based Gate

Code review is essential, especially for AI-generated code. Add a reviewer-based gate that requires at least two reviewers and adds an extra reviewer when the author is an AI agent.

Create `gates/review-requirements.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: human-approval
  namespace: team-alpha
spec:
  gates:
    - name: minimum-reviewers
      enforcement: advisory
      rule:
        minimumReviewers: 2
        aiAuthorRequiresExtraReviewer: true
```

Key details:

- The **enforcement** is `advisory`, which means a PR that does not meet the reviewer requirement will still be allowed to merge, but a warning will be logged and displayed.
- **minimumReviewers** requires at least 2 human reviewers.
- **aiAuthorRequiresExtraReviewer** means AI-authored PRs need 3 reviewers (2 + 1 extra), providing additional scrutiny for AI-generated code.

Why advisory? You might start a new review policy as advisory to measure compliance before making it mandatory. Once the team is consistently meeting the requirement, promote it to `soft-mandatory`.

## Step 4: Add Evaluation Configuration

Quality gates need to know when and how to run. Add an `evaluation` block to control timing, timeouts, and retry behavior.

Here is a complete QualityGate that combines multiple gates with evaluation configuration:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: ai-code-standards
  namespace: team-alpha
spec:
  scope:
    repositories: ["org/service-*"]
    authorTypes: ["ai-agent"]
  gates:
    - name: test-coverage
      enforcement: soft-mandatory
      rule:
        metric: line-coverage
        operator: ">="
        threshold: 80
      override:
        requiredRole: engineering-manager
        requiresJustification: true
    - name: security-scan
      enforcement: hard-mandatory
      rule:
        tool: semgrep
        maxSeverity: medium
        rulesets: ["owasp-top-10"]
    - name: human-review
      enforcement: soft-mandatory
      rule:
        minimumReviewers: 2
        aiAuthorRequiresExtraReviewer: true
      override:
        requiredRole: engineering-manager
        requiresJustification: true
  evaluation:
    pipeline: pre-merge
    timeout: 300s
    retryPolicy:
      maxRetries: 3
      backoff: exponential
```

The **evaluation** block configures:

- **pipeline** -- When to run the gates. Options are `pre-merge` (before PR merge), `post-merge` (after merge, for auditing), or `continuous` (ongoing monitoring).
- **timeout** -- Maximum time for the evaluation to complete (300 seconds here). If a gate does not finish in time, it fails.
- **retryPolicy** -- If a gate evaluation fails due to a transient error (e.g., a tool service is temporarily unavailable), retry up to 3 times with exponential backoff between attempts.

## Step 5: Wire Quality Gates into Pipeline Stages

Quality gates are standalone resources. To enforce them, reference their names in your pipeline stages. Return to the pipeline from Tutorial 1 and verify the references match:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-first-pipeline
  namespace: team-alpha
spec:
  triggers:
    - event: issue.assigned
      filter:
        labels: ["ai-eligible"]
  providers:
    issueTracker:
      type: linear
      config:
        teamId: "ENG"
    sourceControl:
      type: github
      config:
        org: "my-org"
  stages:
    - name: implement
      agent: code-agent
      qualityGates:
        - ai-code-standards
    - name: review
      agent: reviewer-agent
      qualityGates:
        - human-approval
  routing:
    complexityThresholds:
      low:
        min: 1
        max: 3
        strategy: "fully-autonomous"
      medium:
        min: 4
        max: 6
        strategy: "ai-with-review"
      high:
        min: 7
        max: 8
        strategy: "ai-assisted"
      critical:
        min: 9
        max: 10
        strategy: "human-led"
```

The `implement` stage references `ai-code-standards`, which bundles test coverage, security scanning, and review requirements into a single QualityGate resource. The `review` stage references `human-approval` for additional reviewer checks.

All gates within a referenced QualityGate must pass (or be overridden, for soft-mandatory gates) before the stage completes. A single hard-mandatory failure blocks the entire stage.

## Step 6: Build and Enforce Gates with the SDK

Instead of writing YAML, use the `QualityGateBuilder` and `enforce()` for programmatic gate evaluation:

```typescript
import { QualityGateBuilder, enforce } from "@ai-sdlc/reference";

// Build the gate resource
const gate = new QualityGateBuilder("ai-code-standards")
  .withScope({
    repositories: ["org/service-*"],
    authorTypes: ["ai-agent"],
  })
  .addGate({
    name: "test-coverage",
    enforcement: "soft-mandatory",
    rule: { metric: "line-coverage", operator: ">=", threshold: 80 },
    override: { requiredRole: "engineering-manager", requiresJustification: true },
  })
  .addGate({
    name: "security-scan",
    enforcement: "hard-mandatory",
    rule: { tool: "semgrep", maxSeverity: "medium", rulesets: ["owasp-top-10"] },
  })
  .addGate({
    name: "human-review",
    enforcement: "soft-mandatory",
    rule: { minimumReviewers: 2, aiAuthorRequiresExtraReviewer: true },
    override: { requiredRole: "engineering-manager", requiresJustification: true },
  })
  .withEvaluation({
    pipeline: "pre-merge",
    timeout: "300s",
    retryPolicy: { maxRetries: 3, backoff: "exponential" },
  })
  .build();

// Enforce the gate against actual metrics
const result = enforce(gate, {
  authorType: "ai-agent",
  repository: "org/service-api",
  metrics: { "line-coverage": 85 },
  toolResults: {
    semgrep: { findings: [] },
  },
  reviewerCount: 3, // 2 base + 1 extra for AI author
});

console.log("Allowed:", result.allowed); // true
for (const r of result.results) {
  console.log(`  ${r.gate}: ${r.verdict}`);
}
// test-coverage: pass
// security-scan: pass
// human-review: pass
```

### Expression Rules

You can also use expression-based rules for dynamic evaluation:

```typescript
import { evaluateExpressionRule, createSimpleExpressionEvaluator } from "@ai-sdlc/reference";

const verdict = evaluateExpressionRule(
  { expression: "metrics['line-coverage'] >= 80" },
  {
    authorType: "ai-agent",
    repository: "org/repo",
    metrics: { "line-coverage": 92 },
  },
);
console.log(verdict.passed); // true
```

### Mutating Gates

Mutating gates transform resources before enforcement:

```typescript
import { createLabelInjector, createMetadataEnricher, applyMutatingGates } from "@ai-sdlc/reference";

const gates = [
  createLabelInjector({ "managed-by": "ai-sdlc", team: "platform" }),
  createMetadataEnricher({ "ai-sdlc.io/generated": "true" }),
];

const mutated = applyMutatingGates(pipeline, gates, { timestamp: new Date().toISOString() });
console.log(mutated.metadata.labels); // includes 'managed-by' and 'team'
```

## Step 7: Validate from YAML

Validate each QualityGate YAML file against the schema:

```typescript
import { readFileSync } from "fs";
import { parse } from "yaml";
import { validate } from "@ai-sdlc/reference";

const files = [
  "gates/test-coverage.yaml",
  "gates/security-standards.yaml",
  "gates/review-requirements.yaml",
];

for (const file of files) {
  const raw = readFileSync(file, "utf-8");
  const gate = parse(raw);
  const result = validate("QualityGate", gate);

  if (result.valid) {
    console.log(`${file}: valid`);
  } else {
    console.error(`${file}: invalid`);
    for (const error of result.errors!) {
      console.error(`  - ${error.path}: ${error.message}`);
    }
  }
}
```

Run the validation:

```bash
npx tsx validate-gates.ts
```

## Summary

In this tutorial, you created three types of quality gates:

1. **Metric-based** -- Test coverage threshold with soft-mandatory enforcement and override capability.
2. **Tool-based** -- Semgrep security scan with hard-mandatory enforcement and no possible override.
3. **Reviewer-based** -- Minimum reviewer requirements with extra scrutiny for AI-authored code.
4. **Evaluation configuration** -- Timing, timeout, and retry settings for gate evaluation.
5. **Pipeline integration** -- Wired quality gates into pipeline stages by name reference.

The three-tier enforcement model gives you fine-grained control: start new policies as advisory, promote them to soft-mandatory as the team adapts, and reserve hard-mandatory for non-negotiable requirements.

## Next Steps

- [Tutorial 3: Configuring Progressive Autonomy](03-progressive-autonomy.md) -- Define autonomy levels with promotion criteria and demotion triggers.
- [Policy specification](../../spec/policy.md) -- Full normative reference for enforcement levels, evaluation pipelines, and override semantics.
- [QualityGate specification](../../spec/spec.md#53-qualitygate) -- Schema reference for QualityGate resources.
