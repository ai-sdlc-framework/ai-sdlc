# Tutorial 3: Configuring Progressive Autonomy

The AI-SDLC Framework treats autonomy as something agents **earn through demonstrated reliability**, not something granted by default. The AutonomyPolicy resource defines four progressive levels, each with increasing permissions and decreasing supervision:

| Level | Name | Philosophy |
| --- | --- | --- |
| 0 | Intern | Observe only. Learn the codebase without making changes. |
| 1 | Junior | Recommend changes. Every action requires human approval. |
| 2 | Senior | Execute within guardrails. Only security-critical changes need pre-approval. |
| 3 | Principal | Autonomous within domain. Continuous validation replaces pre-approval. |

This tutorial walks through building an AutonomyPolicy from scratch, defining all four levels, configuring promotion criteria, and setting up automatic demotion triggers.

## Prerequisites

- Familiarity with [Tutorial 1: Setting Up a Basic Pipeline](01-basic-pipeline.md) and [Tutorial 2: Adding Quality Gates](02-quality-gates.md)
- Understanding of Pipeline and QualityGate resource structure

## Step 1: Define Level 0 (Intern)

Start with the most restrictive level. An Intern agent has read-only access, cannot write or execute anything, and is monitored continuously. Every agent begins here.

Create `policies/standard-progression.yaml`:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: standard-progression
  namespace: team-alpha
spec:
  levels:
    - level: 0
      name: "Intern"
      description: "Read-only observation, no code generation"
      permissions:
        read: ["*"]
        write: []
        execute: []
      guardrails:
        requireApproval: all
      monitoring: continuous
      minimumDuration: "2w"
  promotionCriteria:
    "0-to-1":
      minimumTasks: 20
      conditions:
        - metric: recommendation-acceptance-rate
          operator: ">="
          threshold: 0.90
      requiredApprovals: [engineering-manager]
  demotionTriggers:
    - trigger: critical-security-incident
      action: demote-to-0
      cooldown: "4w"
```

Key details for Level 0:

- **permissions** -- Read everything, write nothing, execute nothing. The agent can observe the codebase, issues, and PRs, but cannot produce any artifacts.
- **guardrails.requireApproval: all** -- Every action (if any were allowed) would require approval. This is effectively a formality at Level 0 since no write or execute permissions exist.
- **monitoring: continuous** -- All agent activity is monitored in real time.
- **minimumDuration: "2w"** -- The agent must spend at least 2 weeks at this level before being eligible for promotion, regardless of task count or metrics.

## Step 2: Define Levels 1 through 3

Now add the remaining levels with progressively increasing permissions and decreasing oversight. Each level unlocks new capabilities.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: standard-progression
  namespace: team-alpha
spec:
  levels:
    - level: 0
      name: "Intern"
      description: "Read-only observation, no code generation"
      permissions:
        read: ["*"]
        write: []
        execute: []
      guardrails:
        requireApproval: all
      monitoring: continuous
      minimumDuration: "2w"

    - level: 1
      name: "Junior"
      description: "Recommend changes with mandatory human approval"
      permissions:
        read: ["*"]
        write: ["draft-pr", "comment"]
        execute: ["test-suite"]
      guardrails:
        requireApproval: all
        maxLinesPerPR: 200
        blockedPaths: ["**/auth/**", "**/payment/**"]
      monitoring: continuous
      minimumDuration: "4w"

    - level: 2
      name: "Senior"
      description: "Execute within guardrails with real-time notification"
      permissions:
        read: ["*"]
        write: ["branch", "pr", "comment"]
        execute: ["test-suite", "lint", "build"]
      guardrails:
        requireApproval: security-critical-only
        maxLinesPerPR: 500
        blockedPaths: ["**/auth/**"]
        transactionLimit: "$100/day"
      monitoring: real-time-notification
      minimumDuration: "8w"

    - level: 3
      name: "Principal"
      description: "Autonomous within domain, continuous validation"
      permissions:
        read: ["*"]
        write: ["branch", "pr", "comment", "merge-non-critical"]
        execute: ["test-suite", "lint", "build", "deploy-staging"]
      guardrails:
        requireApproval: architecture-changes-only
        maxLinesPerPR: 1000
      monitoring: audit-log
      minimumDuration: null
  promotionCriteria: {}
  demotionTriggers: []
```

Notice the progression across levels: write permissions grow from nothing to draft PRs to full PRs to merging. Approval requirements decrease from "all" to "architecture changes only." Monitoring shifts from continuous real-time observation to async audit logs. Blocked paths shrink and PR size limits increase as trust is established.

## Step 3: Configure Promotion Criteria

Promotion is not automatic -- it requires meeting quantitative thresholds and receiving explicit human approval. Define criteria for each level transition.

Replace the placeholder `promotionCriteria` with the full configuration:

```yaml
  promotionCriteria:
    "0-to-1":
      minimumTasks: 20
      conditions:
        - metric: recommendation-acceptance-rate
          operator: ">="
          threshold: 0.90
        - metric: security-incidents
          operator: "=="
          threshold: 0
      requiredApprovals:
        - engineering-manager

    "1-to-2":
      minimumTasks: 50
      conditions:
        - metric: pr-approval-rate
          operator: ">="
          threshold: 0.90
        - metric: rollback-rate
          operator: "<="
          threshold: 0.02
        - metric: average-review-iterations
          operator: "<="
          threshold: 1.5
        - metric: security-incidents
          operator: "=="
          threshold: 0
        - metric: code-coverage-maintained
          operator: ">="
          threshold: 0.80
      requiredApprovals:
        - engineering-manager
        - security-lead

    "2-to-3":
      minimumTasks: 100
      conditions:
        - metric: pr-approval-rate
          operator: ">="
          threshold: 0.95
        - metric: rollback-rate
          operator: "<="
          threshold: 0.01
        - metric: production-incidents-caused
          operator: "=="
          threshold: 0
      requiredApprovals:
        - engineering-manager
        - security-lead
        - vp-engineering
```

Each transition requires ALL three categories to be satisfied: minimum task count, metric conditions, and human approvals. Notice how the bar rises at each level -- more tasks, tighter metrics, and more senior approvers.

## Step 4: Configure Demotion Triggers

Trust must be continuously verified. Demotion triggers automatically reduce an agent's autonomy level when serious incidents occur.

Replace the placeholder `demotionTriggers`:

```yaml
  demotionTriggers:
    - trigger: critical-security-incident
      action: demote-to-0
      cooldown: "4w"
    - trigger: rollback-rate-exceeds-5-percent
      action: demote-one-level
      cooldown: "2w"
    - trigger: unauthorized-access-attempt
      action: demote-to-0
      cooldown: "4w"
```

Each trigger defines:

- **trigger** -- The event that fires the demotion. These are implementation-defined event names that the reconciliation loop watches for.
- **action** -- How far to demote. `demote-to-0` resets the agent to Intern level (for serious incidents). `demote-one-level` reduces by one (for performance degradation).
- **cooldown** -- How long the agent must wait before re-promotion is even evaluated. During cooldown, task counts reset to zero, so the agent effectively starts the promotion process over.

| Trigger | Action | Cooldown | Rationale |
| --- | --- | --- | --- |
| `critical-security-incident` | Reset to Level 0 | 4 weeks | Security violations require full re-evaluation |
| `rollback-rate-exceeds-5-percent` | Drop one level | 2 weeks | Performance degradation warrants reduced autonomy |
| `unauthorized-access-attempt` | Reset to Level 0 | 4 weeks | Trust boundary violations are severe |

## Step 5: Validate the AutonomyPolicy

Validate the complete resource against the JSON Schema:

```typescript
import { readFileSync } from "fs";
import { parse } from "yaml";
import { validate } from "@ai-sdlc/reference";

const raw = readFileSync("policies/standard-progression.yaml", "utf-8");
const policy = parse(raw);

const result = validate(policy);

if (result.valid) {
  console.log("AutonomyPolicy is valid.");
} else {
  console.error("Validation errors:");
  for (const error of result.errors) {
    console.error(`  - ${error.path}: ${error.message}`);
  }
}
```

Run the validation:

```bash
npx tsx validate-policy.ts
```

## Summary

In this tutorial, you built a complete AutonomyPolicy that governs how AI agents earn and lose trust:

1. **Level 0 (Intern)** -- Read-only observation with continuous monitoring and a 2-week minimum duration.
2. **Levels 1-3** -- Progressive expansion of write permissions, execution capabilities, and PR size limits, with decreasing approval requirements and monitoring intensity.
3. **Promotion criteria** -- Quantitative thresholds (task counts, approval rates, rollback rates) with escalating human approvals at each transition.
4. **Demotion triggers** -- Automatic safety mechanisms that reduce autonomy when security incidents or performance degradation occur.

The key principle is that autonomy is earned incrementally and can be revoked instantly. An agent that has been operating at Level 3 for months will be immediately demoted to Level 0 if a critical security incident occurs -- and will need to re-earn trust from scratch after a 4-week cooldown.

## Next Steps

- [Tutorial 4: Building a Custom Adapter](04-custom-adapter.md) -- Implement an adapter for your tool of choice.
- [Autonomy specification](../../spec/autonomy.md) -- Full normative reference for autonomy levels, promotion criteria, and demotion triggers.
- [AutonomyPolicy specification](../../spec/spec.md#54-autonomypolicy) -- Schema reference for AutonomyPolicy resources.
