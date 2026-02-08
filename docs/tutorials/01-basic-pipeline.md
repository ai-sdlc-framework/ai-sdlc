# Tutorial 1: Setting Up a Basic Pipeline

In the AI-SDLC Framework, a **Pipeline** is the top-level resource that ties together triggers, providers, and stages to define a complete software development lifecycle workflow. When an event occurs (such as an issue being assigned), the pipeline orchestrates which agents act, in what order, and under what quality constraints.

This tutorial walks you through creating a Pipeline resource from scratch, starting with a minimal single-stage configuration and building up to a fully-routed, multi-stage workflow.

## Prerequisites

- **Node.js 18+** installed
- **pnpm** installed (`npm install -g pnpm`)
- Clone the AI-SDLC spec repository:

```bash
git clone https://github.com/ai-sdlc/spec.git
cd spec
pnpm install
```

## Step 1: Create a Minimal Pipeline

Create a new file at `pipelines/my-first-pipeline.yaml`. Every AI-SDLC resource requires `apiVersion`, `kind`, `metadata`, and `spec` at the top level. Start with a single trigger, one provider, and one stage.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-first-pipeline
  namespace: team-alpha
spec:
  triggers:
    - event: issue.assigned
  providers:
    issueTracker:
      type: linear
      config:
        teamId: "ENG"
  stages:
    - name: implement
      agent: code-agent
```

Here is what each section does:

- **triggers** -- The pipeline fires when an issue is assigned. You can add a `filter` object to narrow which issues qualify (e.g., by label or branch).
- **providers** -- Declares tool integrations keyed by interface category. Here, `issueTracker` points to a Linear adapter. The key name (e.g., `issueTracker`) is freeform but should match the interface category.
- **stages** -- An ordered list of execution phases. Each stage has a unique `name` and optionally references an `agent` (an AgentRole resource) and `qualityGates`.

## Step 2: Add a Second Stage with Quality Gates

Real workflows have more than one stage. Add a `review` stage after `implement`, and wire quality gates into both stages.

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
        - test-coverage
        - security-scan
    - name: review
      agent: reviewer-agent
      qualityGates:
        - human-approval
```

What changed:

- **filter** on the trigger narrows activation to issues labeled `ai-eligible`.
- A second provider, `sourceControl`, integrates GitHub for source code operations.
- The `implement` stage now references two QualityGate resources (`test-coverage` and `security-scan`) that must pass before the stage completes.
- The `review` stage assigns a different agent and requires a `human-approval` gate.

Quality gate names here are references to separate `QualityGate` resources. You will define those in [Tutorial 2](02-quality-gates.md).

## Step 3: Add Complexity-Based Routing

Not every task should be handled the same way. A trivial typo fix should not require the same process as a database migration. The `routing` section maps complexity scores (1-10) to execution strategies.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-first-pipeline
  namespace: team-alpha
  labels:
    team: alpha
    environment: production
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
        - test-coverage
        - security-scan
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

The four routing strategies determine how much human involvement is needed:

| Strategy | Human Role | When to Use |
| --- | --- | --- |
| `fully-autonomous` | Post-hoc audit only | Simple, well-understood changes (score 1-3) |
| `ai-with-review` | Reviewer approves before merge | Standard feature work (score 4-6) |
| `ai-assisted` | Human collaborates, AI assists | Complex changes (score 7-8) |
| `human-led` | Human owns the task, AI supports | Critical or architectural changes (score 9-10) |

Complexity scores are assigned per task by your implementation (static analysis, AI evaluation, or manual assignment). The pipeline routes the task to the appropriate strategy automatically.

## Step 4: Validate the Pipeline

Use the reference implementation to validate your pipeline YAML against the JSON Schema.

```typescript
import { readFileSync } from "fs";
import { parse } from "yaml";
import { validate } from "@ai-sdlc/reference";

const raw = readFileSync("pipelines/my-first-pipeline.yaml", "utf-8");
const pipeline = parse(raw);

const result = validate(pipeline);

if (result.valid) {
  console.log("Pipeline is valid.");
} else {
  console.error("Validation errors:");
  for (const error of result.errors) {
    console.error(`  - ${error.path}: ${error.message}`);
  }
}
```

Run the validation:

```bash
npx tsx validate-pipeline.ts
```

If validation passes, you will see `Pipeline is valid.` If not, the error output will tell you which field failed and why -- for example, a missing required field or an invalid strategy value.

## Summary

In this tutorial, you built a Pipeline resource step by step:

1. **Minimal pipeline** -- A single trigger, provider, and stage to get started.
2. **Multi-stage pipeline** -- Added a review stage with quality gate references.
3. **Complexity routing** -- Configured four routing tiers so tasks are handled appropriately based on their complexity score.
4. **Validation** -- Used the reference implementation to verify the pipeline conforms to the AI-SDLC schema.

Pipelines are the backbone of the AI-SDLC Framework. They connect triggers to agents, enforce quality through gates, and route work based on complexity -- all declared as YAML configuration.

## Next Steps

- [Tutorial 2: Adding Quality Gates](02-quality-gates.md) -- Define the `test-coverage`, `security-scan`, and `human-approval` gates referenced in this pipeline.
- [Pipeline specification](../../spec/spec.md#51-pipeline) -- Full normative reference for Pipeline resources.
- [Complete pipeline example](../examples/complete-pipeline.yaml) -- A production-style example with all five resource types.
