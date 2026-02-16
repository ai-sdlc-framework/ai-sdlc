# RFC-0004: Cost Governance and Attribution

**Status:** Draft
**Author:** AI-SDLC Contributors
**Created:** 2026-02-16
**Updated:** 2026-02-16
**Target Spec Version:** v1alpha1

---

## Summary

This RFC introduces comprehensive cost governance into the AI-SDLC Framework. Today, the spec defines four economic efficiency metrics (metrics.md §2.4) and a `transactionLimit` guardrail field in AutonomyPolicy — but provides no enforcement mechanism, no budget policy, no cost-aware routing, no cost attribution model, and no circuit breaker to stop runaway agent spending.

Runaway costs are the **#1 adoption blocker** for AI agent usage in organizations. A team gives an agent a task, the agent loops for 45 minutes burning tokens, and nobody notices until the bill arrives. Three agents working in parallel on a decomposed task each independently decide to use an expensive model, and a $20 feature becomes a $200 feature.

This RFC proposes:
1. A **CostPolicy** extension to Pipeline resources for declaring budgets and cost controls
2. A **cost-based rule type** for QualityGate enforcement (block PRs that exceed cost thresholds)
3. **Cost-aware model selection** in agent configuration (use the right model for the job)
4. **Real-time cost circuit breakers** in the orchestrator (kill runaway agent execution)
5. **Cost attribution** in provenance metadata (every AI artifact has a cost receipt)
6. **Expanded cost metrics** with full breakdown (tokens, compute, human review, cache savings)
7. A **CostReconciler** that continuously evaluates spend vs. budgets and triggers actions

## Motivation

### The cost problem is acute and measurable

AI agent costs are unpredictable and opaque:

- **Token costs vary 300x between models**: Claude Haiku at $0.25/MTok input vs. Claude Opus at $15/MTok input. An agent that uses Opus for a simple rename costs 60x more than one that uses Haiku.
- **Agent loops are invisible**: An agent that enters a reasoning loop can burn $50-100 in tokens in a single execution. Without real-time monitoring, nobody knows until the monthly bill.
- **Parallel execution multiplies costs**: The orchestrator's multi-agent decomposition pattern (agents.md §3.2) runs agents in parallel. If three agents each use 100K tokens on an expensive model, a feature that should cost $5 costs $45.
- **Failed retries are wasted money**: The retry strategy in RFC-0002's FailurePolicy means a 3-retry stage with a $10 agent invocation could spend $40 (including the original attempt) before failing permanently.
- **Human review time dominates TCO but is invisible**: A PR that costs $2 in tokens but takes a senior engineer 30 minutes to review costs $37.50 in human time at $75/hr. The 95% of cost is unmeasured.

### The spec has metrics but no enforcement

The current state of cost governance in the spec:

| What exists | Where | Limitation |
|---|---|---|
| `ai_sdlc.cost.per_task` metric | metrics.md §2.4 | Observable only — no enforcement, no budget, no alerting |
| `ai_sdlc.cost.model_usage_mix` metric | metrics.md §2.4 | Informational — doesn't influence model selection |
| `ai_sdlc.cost.cache_hit_rate` metric | metrics.md §2.4 | Informational — no mechanism to improve cache usage |
| `ai_sdlc.cost.tco_per_feature` metric | metrics.md §2.4 | Post-hoc — computed after the money is spent |
| `transactionLimit` guardrail | autonomy-policy.schema.json | Defined as a string (e.g., "$100/day") but has **no enforcement specification** — implementations don't know how to evaluate or enforce it |

There is no way to:
- Declare a team's monthly budget and enforce it
- Block a pipeline execution that would exceed a per-task limit
- Route tasks to cheaper models when budget is tight
- Kill an agent execution in real-time when it exceeds a cost threshold
- Attribute costs to specific agents, teams, repos, or features
- Include cost data in provenance metadata
- Trigger demotion when an agent consistently overspends

### Enterprise adoption requires cost predictability

**75% of tech leaders** cite governance as their primary deployment challenge (Gartner 2025). A significant component of "governance" is cost governance — the ability to predict, control, and attribute AI spending.

Organizations need to answer:
- "What will it cost to let agents handle 50% of our issues?"
- "Which agent is the most cost-effective for medium-complexity tasks?"
- "Are we spending more on agent token costs or human review time?"
- "If we promote this agent to Level 2, how will costs change?"
- "How do we charge AI orchestration costs back to each team?"

Without answers to these questions, finance teams block AI agent adoption regardless of engineering enthusiasm.

## Goals

- Enable declarative cost budgets at pipeline, stage, agent, team, and organization levels
- Provide real-time cost circuit breakers that kill runaway agent execution
- Support cost-aware model selection (right model for the job, budget-aware routing)
- Deliver full cost attribution across every dimension (agent, model, stage, repo, team, feature)
- Extend provenance metadata with cost data so every AI artifact has a cost receipt
- Add cost-based quality gate rules for pre-merge cost enforcement
- Add cost-based demotion triggers for agents that consistently overspend
- Maintain backward compatibility — all new fields are optional

## Non-Goals

- Integrating with billing APIs of specific cloud providers (AWS, GCP, Azure) — the spec defines the interface; adapters implement provider-specific billing
- Defining model pricing tables — pricing changes frequently; the orchestrator should fetch or configure current pricing, not embed it in the spec
- Replacing existing financial accounting systems — cost attribution produces data that feeds into existing chargeback/showback tools
- Optimizing prompt engineering for cost reduction — the spec governs cost *limits and attribution*, not cost *minimization techniques*

## Proposal

### 1. CostPolicy Extension to Pipeline

A new optional `costPolicy` field on `Pipeline.spec` that declares cost boundaries at three levels:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: feature-delivery
  namespace: team-alpha
spec:
  costPolicy:
    # --- Per-execution limits ---
    perExecution:
      softLimit:
        amount: 25
        currency: USD
        action: require-approval    # Pause and request human approval to continue
      hardLimit:
        amount: 100
        currency: USD
        action: abort               # Kill the pipeline, no override

    # --- Per-stage limits (catch a looping agent early) ---
    perStage:
      defaults:
        tokenLimit: 100000          # Max tokens (input + output) for any stage
        timeLimit: PT30M            # Max wall-clock time
        costLimit:
          amount: 15
          currency: USD
      overrides:
        implement:
          tokenLimit: 200000        # Implementation may need more tokens
          costLimit:
            amount: 25
            currency: USD
        review:
          tokenLimit: 50000
          costLimit:
            amount: 5
            currency: USD

    # --- Team-level budgets (monthly rolling window) ---
    budget:
      period: month
      amount: 5000
      currency: USD
      alerts:
        - threshold: 0.60           # 60% — informational
          action: notify
          targets: ["#engineering"]
        - threshold: 0.80           # 80% — require approval for new pipelines
          action: require-approval
          approver: engineering-manager
        - threshold: 1.00           # 100% — hard stop
          action: block
          message: "Monthly budget exhausted. Contact engineering-manager to increase."

    # --- Cost attribution ---
    attribution:
      dimensions:
        - agent                     # Track spend per agent identity
        - model                     # Track spend per model used
        - stage                     # Track spend per pipeline stage
        - repository                # Track spend per repo
        - complexity                # Track spend per complexity tier
      chargeback: per-repository    # How to allocate costs for billing

    # --- Model cost configuration ---
    modelPricing:
      source: config               # 'config' (static) or 'api' (fetch from provider)
      models:
        claude-opus-4-6:
          inputPerMTok: 15.00
          outputPerMTok: 75.00
          cacheReadPerMTok: 1.50
        claude-sonnet-4-5:
          inputPerMTok: 3.00
          outputPerMTok: 15.00
          cacheReadPerMTok: 0.30
        claude-haiku-4-5:
          inputPerMTok: 0.80
          outputPerMTok: 4.00
          cacheReadPerMTok: 0.08
```

#### CostPolicy Object

| Field | Type | Required | Description |
|---|---|---|---|
| `perExecution` | ExecutionCostLimit | MAY | Cost limits per pipeline execution. |
| `perStage` | StageCostPolicy | MAY | Cost limits per pipeline stage. |
| `budget` | BudgetPolicy | MAY | Rolling budget for the team/namespace. |
| `attribution` | AttributionPolicy | MAY | How costs are attributed and allocated. |
| `modelPricing` | ModelPricingConfig | MAY | Model cost configuration for cost calculation. |

#### ExecutionCostLimit Object

| Field | Type | Required | Description |
|---|---|---|---|
| `softLimit` | CostThreshold | MAY | Threshold that triggers a warning or approval requirement. |
| `hardLimit` | CostThreshold | MAY | Threshold that aborts the pipeline unconditionally. |

#### CostThreshold Object

| Field | Type | Required | Description |
|---|---|---|---|
| `amount` | number | MUST | The cost threshold value. |
| `currency` | string | MUST | ISO 4217 currency code. Defaults to `USD`. |
| `action` | string | MUST | One of: `notify`, `require-approval`, `abort`. |

#### StageCostPolicy Object

| Field | Type | Required | Description |
|---|---|---|---|
| `defaults` | StageCostLimit | MAY | Default limits applied to all stages. |
| `overrides` | map[string]StageCostLimit | MAY | Per-stage overrides, keyed by stage name. |

#### StageCostLimit Object

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenLimit` | integer | MAY | Maximum total tokens (input + output) for the stage. |
| `timeLimit` | string | MAY | Maximum wall-clock time (ISO 8601 duration). |
| `costLimit` | CostThreshold | MAY | Maximum monetary cost for the stage. |

#### BudgetPolicy Object

| Field | Type | Required | Description |
|---|---|---|---|
| `period` | string | MUST | Rolling budget window. One of: `day`, `week`, `month`, `quarter`. |
| `amount` | number | MUST | The budget amount for the period. |
| `currency` | string | MUST | ISO 4217 currency code. |
| `alerts` | array[BudgetAlert] | MAY | Ordered list of threshold alerts. |

#### BudgetAlert Object

| Field | Type | Required | Description |
|---|---|---|---|
| `threshold` | number | MUST | Fraction of budget (0.0 - 1.0) that triggers this alert. |
| `action` | string | MUST | One of: `notify`, `require-approval`, `block`. |
| `targets` | array[string] | MAY | Notification targets (Slack channels, email addresses). |
| `approver` | string | MAY | Role or identity required for approval (when action is `require-approval`). |
| `message` | string | MAY | Custom message displayed when alert triggers. |

#### AttributionPolicy Object

| Field | Type | Required | Description |
|---|---|---|---|
| `dimensions` | array[string] | MUST | Cost tracking dimensions. Values: `agent`, `model`, `stage`, `repository`, `complexity`, `team`, `feature`. |
| `chargeback` | string | MAY | Cost allocation strategy. One of: `per-repository`, `per-team`, `per-agent`, `proportional`. |

### 2. Cost-Based Quality Gate Rule

A new rule type in the QualityGate spec that enables cost-based enforcement:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: cost-controls
spec:
  gates:
    # Block PRs where agent cost was excessive relative to complexity
    - name: cost-efficiency
      enforcement: soft-mandatory
      rule:
        cost:
          metric: cost-per-line     # cost / lines_changed
          operator: "<="
          threshold: 0.50           # Max $0.50 per line of code changed
      override:
        requiredRole: engineering-manager
        requiresJustification: true

    # Warn on PRs with no cost attribution (advisory during rollout)
    - name: cost-attribution-present
      enforcement: advisory
      rule:
        cost:
          metric: attribution-complete
          operator: "=="
          threshold: 1              # Boolean: 1 = all cost fields present

    # Hard block on single-PR cost exceeding budget threshold
    - name: max-pr-cost
      enforcement: hard-mandatory
      rule:
        cost:
          metric: total-execution-cost
          operator: "<="
          threshold: 100            # No single PR should cost more than $100
```

#### Cost Rule Object (new addition to QualityGate rule oneOf)

| Field | Type | Required | Description |
|---|---|---|---|
| `cost` | object | MUST | Cost-based rule definition. |
| `cost.metric` | string | MUST | The cost metric to evaluate. See Cost Metrics table below. |
| `cost.operator` | string | MUST | Comparison operator. One of: `>=`, `<=`, `==`, `!=`, `>`, `<`. |
| `cost.threshold` | number | MUST | The threshold value. |

**Cost metrics available for gate evaluation:**

| Metric | Type | Unit | Description |
|---|---|---|---|
| `total-execution-cost` | number | USD | Total cost of the pipeline execution that produced this PR |
| `token-cost` | number | USD | Token costs only (input + output across all stages) |
| `cost-per-line` | number | USD/line | Total cost / lines changed |
| `cost-per-file` | number | USD/file | Total cost / files changed |
| `budget-remaining-percent` | number | 0-1 | Remaining team budget as fraction of total |
| `cost-vs-estimate` | number | ratio | Actual cost / estimated cost (values >1 indicate overrun) |
| `attribution-complete` | number | 0 or 1 | Whether all cost attribution fields are present |
| `retry-cost-ratio` | number | ratio | Cost of retries / cost of successful execution (high = wasteful retries) |

### 3. Cost-Aware Model Selection

A new `modelSelection` field on AgentRole that enables cost-optimized model routing:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  role: "Software Engineer"
  goal: "Implement features and fix bugs"
  tools: [code_editor, terminal, git_client, test_runner]

  modelSelection:
    # Route by task complexity to the right price/performance point
    rules:
      - complexity: [1, 3]
        model: claude-haiku-4-5
        rationale: "Simple tasks: fast, cheap, sufficient quality"
      - complexity: [4, 6]
        model: claude-sonnet-4-5
        rationale: "Medium tasks: balanced cost/capability"
      - complexity: [7, 10]
        model: claude-opus-4-6
        rationale: "Complex tasks: maximum reasoning capability"

    # Budget pressure: downshift models as budget depletes
    budgetPressure:
      - above: 0.80                  # Budget 80% consumed
        downshift: 1                 # Use one tier cheaper than rule says
        notify: ["#engineering"]
      - above: 0.95                  # Budget 95% consumed
        downshift: 2                 # Use cheapest available model
        notify: ["#engineering", "@tech-lead"]

    # Fallback: if preferred model is unavailable (outage, rate limit)
    fallbackChain:
      - claude-sonnet-4-5
      - claude-haiku-4-5
      - gpt-4o                       # Cross-provider fallback
```

#### ModelSelection Object

| Field | Type | Required | Description |
|---|---|---|---|
| `rules` | array[ModelRule] | MAY | Complexity-to-model routing rules. |
| `budgetPressure` | array[BudgetPressureRule] | MAY | Model downshift rules based on budget consumption. |
| `fallbackChain` | array[string] | MAY | Ordered list of fallback models. |

#### ModelRule Object

| Field | Type | Required | Description |
|---|---|---|---|
| `complexity` | array[integer] | MUST | Complexity range [min, max] for this rule. |
| `model` | string | MUST | Model identifier to use for this complexity range. |
| `rationale` | string | MAY | Human-readable explanation for the choice. |

#### BudgetPressureRule Object

| Field | Type | Required | Description |
|---|---|---|---|
| `above` | number | MUST | Budget consumption fraction (0.0 - 1.0) that triggers this rule. |
| `downshift` | integer | MUST | Number of tiers to downshift (1 = next cheaper, 2 = two tiers cheaper). |
| `notify` | array[string] | MAY | Notification targets when budget pressure forces model downshift. |

### 4. Real-Time Cost Circuit Breaker

The orchestrator MUST implement a real-time cost monitoring loop for every agent execution:

```
Agent execution with cost circuit breaker:

  BEFORE execution:
    1. Calculate cost estimate based on:
       - Task complexity score
       - Historical cost for similar tasks (from episodic memory)
       - Selected model pricing
    2. Check: estimate > stage costLimit?
       → If yes: BLOCK, notify, suggest cheaper model or task decomposition
    3. Check: current_monthly_spend + estimate > budget?
       → If yes: apply budget pressure rules (require-approval or block)
    4. Reserve the estimated cost against the budget (optimistic locking)

  DURING execution:
    5. Monitor token consumption via API response metadata
       (input_tokens, output_tokens from each model call)
    6. Every 30 seconds (or every N API calls), compute:
       running_cost = Σ (input_tokens × input_price + output_tokens × output_price)
    7. Check: running_cost > stage costLimit × 0.80?
       → If yes: WARN (log, prepare to interrupt)
    8. Check: running_cost > stage costLimit?
       → If yes: INTERRUPT agent execution
       → Save partial work summary (for context if human continues)
       → Set stage status to "Failed (cost limit exceeded)"
       → Apply stage onFailure policy

  AFTER execution:
    9. Compute final cost breakdown:
       - token_cost = Σ (input_tokens × input_price + output_tokens × output_price)
       - cache_savings = Σ (cache_read_tokens × (input_price - cache_price))
       - compute_cost = (if self-hosted: GPU-seconds × rate)
       - infrastructure_cost = allocated CI/CD + storage
    10. Release budget reservation, record actual cost
    11. Update cost attribution across all configured dimensions
    12. Append to provenance metadata on the resulting PR
    13. Update cost-per-task and tco-per-feature metrics
    14. Check: did this agent exceed its estimate by > 200%?
        → If yes: flag for cost anomaly review
```

#### Circuit Breaker Behavioral Requirements

Implementations MUST:
- Monitor token consumption during agent execution (not only after)
- Interrupt agent execution when a hard cost limit is reached
- Record the cost of interrupted executions (partial work still costs money)
- Apply the stage's `onFailure` policy when a cost limit interruption occurs
- Notify configured targets when a soft cost limit is reached

Implementations SHOULD:
- Estimate costs before execution based on historical data
- Reserve budget before execution to prevent parallel agents from collectively overspending
- Provide a grace period (e.g., 10% above limit) to allow the agent to reach a clean stopping point
- Record cost anomalies (actual >> estimate) in the autonomy ledger

### 5. Cost Attribution in Provenance

Extend the provenance metadata (metrics.md §4.1) with cost fields:

#### Extended Provenance Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | MUST | Model identifier. *(Existing, unchanged.)* |
| `tool` | string | MUST | Tool identifier. *(Existing, unchanged.)* |
| `promptHash` | string | MUST | SHA-256 of input prompt. *(Existing, unchanged.)* |
| `timestamp` | string | MUST | ISO 8601 generation time. *(Existing, unchanged.)* |
| `humanReviewer` | string | MAY | Identity of reviewer. *(Existing, unchanged.)* |
| `reviewDecision` | string | MAY | approved/rejected/revised. *(Existing, unchanged.)* |
| `cost` | CostReceipt | MAY | **NEW.** Cost breakdown for this artifact. |

#### CostReceipt Object

| Field | Type | Required | Description |
|---|---|---|---|
| `totalCost` | number | MUST | Total cost in the specified currency. |
| `currency` | string | MUST | ISO 4217 currency code. |
| `breakdown` | CostBreakdown | MUST | Itemized cost components. |
| `execution` | ExecutionCostDetail | MAY | Detailed execution metrics. |

#### CostBreakdown Object

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenCost` | number | MUST | Cost of input + output tokens. |
| `cacheSavings` | number | MAY | Cost avoided through cache hits (negative value). |
| `computeCost` | number | MAY | Infrastructure/GPU compute cost (for self-hosted models). |
| `humanReviewCost` | number | MAY | Estimated cost of human review time. |

#### ExecutionCostDetail Object

| Field | Type | Required | Description |
|---|---|---|---|
| `inputTokens` | integer | MUST | Total input tokens consumed. |
| `outputTokens` | integer | MUST | Total output tokens consumed. |
| `cacheReadTokens` | integer | MAY | Tokens served from cache. |
| `modelCalls` | integer | MAY | Number of API calls to the model. |
| `wallClockSeconds` | number | MAY | Total execution wall-clock time. |
| `retryCount` | integer | MAY | Number of retries (each retry adds cost). |

#### Example: PR Provenance with Cost Receipt

```yaml
# Appended to PR description or stored in provenance store
provenance:
  model: claude-sonnet-4-5-20250929
  tool: claude-code@1.2.0
  promptHash: "sha256:a1b2c3d4..."
  timestamp: "2026-02-16T10:30:00Z"
  humanReviewer: alice@acme.com
  reviewDecision: approved
  cost:
    totalCost: 2.34
    currency: USD
    breakdown:
      tokenCost: 1.89
      cacheSavings: -0.45
      computeCost: 0.00
      humanReviewCost: 18.75
    execution:
      inputTokens: 42000
      outputTokens: 8500
      cacheReadTokens: 15000
      modelCalls: 12
      wallClockSeconds: 147
      retryCount: 0
```

This means **every PR created by the orchestrator carries a cost receipt** showing exactly what it cost to produce. Over time, this builds a dataset for answering: "What does it cost to ship a feature by complexity tier?" and "Which model gives the best quality-per-dollar?"

### 6. Expanded Cost Metrics

Extend metrics.md §2.4 with granular cost metrics:

#### New Metrics

| Metric | Name | Type | Unit | Description |
|---|---|---|---|---|
| `ai_sdlc.cost.tokens.input` | Input tokens | Counter | tokens | Cumulative input tokens consumed |
| `ai_sdlc.cost.tokens.output` | Output tokens | Counter | tokens | Cumulative output tokens consumed |
| `ai_sdlc.cost.tokens.cache_read` | Cache read tokens | Counter | tokens | Cumulative tokens served from cache |
| `ai_sdlc.cost.token_cost` | Token cost | Histogram | USD | Token cost per pipeline execution |
| `ai_sdlc.cost.human_review_cost` | Human review cost | Histogram | USD | Estimated human review cost per pipeline execution |
| `ai_sdlc.cost.compute_cost` | Compute cost | Histogram | USD | Infrastructure cost per pipeline execution |
| `ai_sdlc.cost.cache_savings` | Cache savings | Counter | USD | Cumulative cost avoided through cache hits |
| `ai_sdlc.cost.budget_consumed` | Budget consumed | Gauge | Ratio (0-1) | Current budget consumption as fraction of total |
| `ai_sdlc.cost.budget_remaining` | Budget remaining | Gauge | USD | Remaining budget for the current period |
| `ai_sdlc.cost.cost_per_line` | Cost per line | Histogram | USD/line | Cost efficiency: total cost / lines changed |
| `ai_sdlc.cost.cost_vs_estimate` | Cost vs estimate | Histogram | Ratio | Actual cost / estimated cost (>1 = overrun) |
| `ai_sdlc.cost.retry_waste` | Retry waste | Counter | USD | Cumulative cost of failed retries |
| `ai_sdlc.cost.circuit_breaker_saves` | Circuit breaker saves | Counter | USD | Estimated cost avoided by circuit breaker interruptions |

**Dimensions** (in addition to existing `model`, `agent`, `team`):
- `stage` — Pipeline stage name
- `complexity` — Task complexity tier (low/medium/high/critical)
- `repository` — Repository identifier
- `outcome` — Pipeline outcome (success/failed/interrupted)

### 7. Cost-Based Demotion Trigger

Extend AutonomyPolicy demotion triggers (autonomy.md §6) with cost-based criteria:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: default
spec:
  demotionTriggers:
    # Existing triggers
    - event: critical-security-incident
      demoteTo: 0
    - event: rollback-rate-exceeds-5-percent
      demoteTo: 1

    # NEW: Cost-based demotion triggers
    - event: cost-overrun
      condition:
        metric: cost-vs-estimate
        operator: ">="
        threshold: 3.0              # Actual cost >= 3x estimated cost
        window: 5                   # In 5 consecutive pipeline executions
      demoteTo: 1                   # Demote to Level 1 (requires approval for all tasks)
      notification: "Agent consistently exceeding cost estimates. Demoted to Level 1 for manual oversight."

    - event: budget-breach
      condition:
        metric: budget-consumed
        operator: ">="
        threshold: 1.0              # Budget exhausted
      action: suspend               # Suspend agent until next budget period
      notification: "Agent suspended — team budget exhausted."
```

### 8. CostReconciler

A new reconciler (alongside PipelineReconciler, GateReconciler, and AutonomyReconciler) that continuously evaluates cost state:

**Reconciliation cycle:**

```
CostReconciler.reconcile():
  1. READ budget policy from Pipeline.spec.costPolicy.budget
  2. READ current spend from cost attribution store
  3. COMPUTE budget consumption ratio = current_spend / budget_amount
  4. FOR EACH alert threshold in budget.alerts:
     a. IF consumption >= threshold AND alert not yet fired:
        - Execute alert action (notify / require-approval / block)
        - Record alert in status.conditions[]
  5. FOR EACH active agent:
     a. COMPUTE agent's cost-vs-estimate ratio over recent window
     b. IF ratio exceeds demotion trigger threshold:
        - Trigger demotion via AutonomyReconciler
  6. UPDATE Pipeline.status with cost state:
     - status.cost.currentSpend
     - status.cost.budgetRemaining
     - status.cost.projectedMonthEnd (linear extrapolation)
     - status.cost.topAgentByCost
     - status.cost.topModelByCost
  7. REQUEUE with period matching budget check frequency (e.g., every 5 minutes)
```

**New Pipeline status fields:**

| Field | Type | Description |
|---|---|---|
| `status.cost` | CostStatus | Current cost state. |
| `status.cost.currentSpend` | number | Total spend in the current budget period. |
| `status.cost.budgetRemaining` | number | Remaining budget (amount - currentSpend). |
| `status.cost.projectedMonthEnd` | number | Projected spend at end of budget period (linear extrapolation). |
| `status.cost.lastUpdated` | string (date-time) | When cost status was last reconciled. |
| `status.cost.activeAlerts` | array[string] | Currently active budget alert thresholds. |

---

## Design Details

### Schema Changes

#### Pipeline Schema Extension

Add to `pipeline.schema.json` under `spec.properties`:

```json
{
  "costPolicy": {
    "type": "object",
    "description": "Cost governance policy for the pipeline.",
    "properties": {
      "perExecution": {
        "type": "object",
        "properties": {
          "softLimit": { "$ref": "#/$defs/CostThreshold" },
          "hardLimit": { "$ref": "#/$defs/CostThreshold" }
        }
      },
      "perStage": {
        "type": "object",
        "properties": {
          "defaults": { "$ref": "#/$defs/StageCostLimit" },
          "overrides": {
            "type": "object",
            "additionalProperties": { "$ref": "#/$defs/StageCostLimit" }
          }
        }
      },
      "budget": { "$ref": "#/$defs/BudgetPolicy" },
      "attribution": { "$ref": "#/$defs/AttributionPolicy" },
      "modelPricing": { "$ref": "#/$defs/ModelPricingConfig" }
    }
  }
}
```

(Full `$defs` for each sub-object follow the field tables defined in the Proposal section above.)

#### QualityGate Schema Extension

Add a new alternative to the `rule` oneOf in `quality-gate.schema.json`:

```json
{
  "type": "object",
  "title": "Cost-based rule",
  "required": ["cost"],
  "properties": {
    "cost": {
      "type": "object",
      "required": ["metric", "operator", "threshold"],
      "properties": {
        "metric": {
          "type": "string",
          "enum": [
            "total-execution-cost",
            "token-cost",
            "cost-per-line",
            "cost-per-file",
            "budget-remaining-percent",
            "cost-vs-estimate",
            "attribution-complete",
            "retry-cost-ratio"
          ]
        },
        "operator": {
          "type": "string",
          "enum": [">=", "<=", "==", "!=", ">", "<"]
        },
        "threshold": {
          "type": "number"
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

#### AgentRole Schema Extension

Add to `agent-role.schema.json` under `spec.properties`:

```json
{
  "modelSelection": {
    "type": "object",
    "properties": {
      "rules": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["complexity", "model"],
          "properties": {
            "complexity": {
              "type": "array",
              "items": { "type": "integer" },
              "minItems": 2,
              "maxItems": 2
            },
            "model": { "type": "string" },
            "rationale": { "type": "string" }
          }
        }
      },
      "budgetPressure": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["above", "downshift"],
          "properties": {
            "above": { "type": "number", "minimum": 0, "maximum": 1 },
            "downshift": { "type": "integer", "minimum": 1 },
            "notify": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        }
      },
      "fallbackChain": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

### Behavioral Changes

#### Reconciliation Loop Impact

1. **CostReconciler** — A new reconciler added alongside PipelineReconciler, GateReconciler, and AutonomyReconciler. Runs on a 5-minute period (configurable). Evaluates budget consumption, triggers alerts, and updates cost status.

2. **PipelineReconciler** — Extended to check cost policy before advancing stages. If budget is exhausted and action is `block`, the pipeline transitions to `Suspended` phase.

3. **AutonomyReconciler** — Extended to evaluate cost-based demotion triggers alongside existing performance-based triggers.

4. **Agent invocation** — The agent runtime wrapper MUST implement the cost circuit breaker loop (Section 4) around every agent execution.

#### Cost Data Flow

```
Agent API call
  → Response includes: input_tokens, output_tokens, cache_read_tokens
    → Orchestrator accumulates per-stage token counts
      → At stage completion: compute cost using modelPricing config
        → Record in cost attribution store (per-agent, per-model, per-stage)
          → Update budget consumption
            → Evaluate quality gates with cost metrics
              → Append cost receipt to provenance on PR
                → CostReconciler updates Pipeline.status.cost
```

### Migration Path

All new fields are optional. Existing resources validate without modification:

- Missing `costPolicy` → No cost enforcement (current behavior)
- Missing `cost` rule in QualityGate → No cost-based gating (current behavior)
- Missing `modelSelection` in AgentRole → Implementation uses its default model (current behavior)
- Missing `cost` in provenance → No cost receipt on PRs (current behavior)
- `transactionLimit` in AutonomyPolicy guardrails continues to function as-is; the new `costPolicy.perStage.costLimit` provides a more precise mechanism. Implementations SHOULD evaluate both if present.

---

## Backward Compatibility

- **Not a breaking change.** All new fields are optional.
- Existing Pipeline, QualityGate, AgentRole, and AutonomyPolicy resources validate against updated schemas without modification.
- Implementations that do not support cost governance MAY ignore the new fields, though they SHOULD log a warning when cost policy fields are present but unsupported.
- The extended provenance fields are additive — existing provenance consumers that don't understand `cost` will ignore it.

---

## Alternatives Considered

### Alternative 1: Separate CostBudget Resource Type

Create a 6th resource type (`kind: CostBudget`) that references pipelines and declares cost policies independently.

**Rejected because:** Cost policy is inherently tied to pipeline execution — it controls how the pipeline runs, what models are selected, and when stages are interrupted. Separating it into a standalone resource creates cross-resource validation complexity and an unclear ownership boundary. Cost policy belongs inside Pipeline (which owns execution semantics) and QualityGate (which owns enforcement semantics).

### Alternative 2: Cost Governance in Adapters Only

Implement cost tracking as adapter-level concerns — each agent adapter tracks its own costs, and the orchestrator aggregates.

**Rejected because:** Cost governance requires cross-cutting coordination that no single adapter can provide. Budget enforcement must happen *before* an agent is invoked (not after), circuit breakers must interrupt *during* execution, and attribution must span *across* all adapters in a pipeline. Adapter-level tracking is necessary for data collection but insufficient for governance.

### Alternative 3: Post-Hoc Cost Analysis Only

Track costs purely as observability metrics and provide dashboards, but don't enforce limits or interrupt execution.

**Rejected because:** Observability without enforcement is how teams end up with surprise $10,000 bills. The core value proposition is **preventing** runaway costs, not just **reporting** them. Post-hoc analysis is necessary (and included via metrics and provenance), but enforcement (budgets, circuit breakers, cost gates) is what makes cost governance actionable.

### Alternative 4: Fixed Per-Task Cost Limits Only

Instead of the full cost policy model, just enforce a single `maxCostPerTask` field.

**Rejected because:** A single limit is too blunt. Different stages have different cost profiles (implementation is expensive, linting is cheap). Different complexity tiers have different expected costs. Monthly budgets operate on a different timescale than per-task limits. The multi-level approach (per-stage, per-execution, per-budget-period) matches how organizations actually think about cost governance.

---

## Examples

### Startup: Lightweight Cost Awareness

```yaml
# Small team, just wants to avoid surprises
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: simple-pipeline
spec:
  costPolicy:
    perExecution:
      hardLimit:
        amount: 50
        currency: USD
        action: abort
    budget:
      period: month
      amount: 500
      currency: USD
      alerts:
        - threshold: 0.90
          action: notify
          targets: ["#dev"]
  stages:
    - name: implement
      agent: code-agent
    - name: validate
      qualityGates: [basic-checks]
```

### Enterprise: Full Cost Governance

```yaml
# Large org with chargebacks, compliance requirements, and multiple teams
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: enterprise-pipeline
  namespace: platform-team
spec:
  costPolicy:
    perExecution:
      softLimit:
        amount: 25
        currency: USD
        action: require-approval
      hardLimit:
        amount: 100
        currency: USD
        action: abort
    perStage:
      defaults:
        tokenLimit: 100000
        timeLimit: PT20M
        costLimit:
          amount: 15
          currency: USD
      overrides:
        implement:
          tokenLimit: 300000
          timeLimit: PT45M
          costLimit:
            amount: 40
            currency: USD
    budget:
      period: month
      amount: 25000
      currency: USD
      alerts:
        - threshold: 0.50
          action: notify
          targets: ["#platform-costs"]
        - threshold: 0.75
          action: notify
          targets: ["#platform-costs", "@vp-engineering"]
        - threshold: 0.90
          action: require-approval
          approver: vp-engineering
        - threshold: 1.00
          action: block
    attribution:
      dimensions: [agent, model, stage, repository, complexity, team]
      chargeback: per-repository
    modelPricing:
      source: config
      models:
        claude-opus-4-6:
          inputPerMTok: 15.00
          outputPerMTok: 75.00
          cacheReadPerMTok: 1.50
        claude-sonnet-4-5:
          inputPerMTok: 3.00
          outputPerMTok: 15.00
          cacheReadPerMTok: 0.30
        claude-haiku-4-5:
          inputPerMTok: 0.80
          outputPerMTok: 4.00
          cacheReadPerMTok: 0.08

  stages:
    - name: triage
      agent: triage-agent
    - name: implement
      agent: code-agent
      onFailure:
        strategy: retry
        maxRetries: 2
    - name: validate
      qualityGates: [code-quality, security-scan, cost-controls]
    - name: review
      agent: review-agent
    - name: merge
---
apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: cost-controls
spec:
  gates:
    - name: cost-efficiency
      enforcement: soft-mandatory
      rule:
        cost:
          metric: cost-per-line
          operator: "<="
          threshold: 0.50
      override:
        requiredRole: engineering-manager
        requiresJustification: true
    - name: no-runaway-retries
      enforcement: hard-mandatory
      rule:
        cost:
          metric: retry-cost-ratio
          operator: "<="
          threshold: 2.0
    - name: max-pr-cost
      enforcement: hard-mandatory
      rule:
        cost:
          metric: total-execution-cost
          operator: "<="
          threshold: 100
---
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  role: "Software Engineer"
  goal: "Implement features and fix bugs cost-effectively"
  tools: [code_editor, terminal, git_client, test_runner]
  modelSelection:
    rules:
      - complexity: [1, 3]
        model: claude-haiku-4-5
      - complexity: [4, 6]
        model: claude-sonnet-4-5
      - complexity: [7, 10]
        model: claude-opus-4-6
    budgetPressure:
      - above: 0.80
        downshift: 1
        notify: ["#platform-costs"]
      - above: 0.95
        downshift: 2
        notify: ["#platform-costs", "@vp-engineering"]
```

---

## Implementation Plan

- [ ] Update `pipeline.schema.json` with CostPolicy object definitions
- [ ] Update `quality-gate.schema.json` with cost-based rule type
- [ ] Update `agent-role.schema.json` with modelSelection object
- [ ] Update `autonomy-policy.schema.json` with cost-based demotion triggers
- [ ] Update `metrics.md` with expanded cost metrics (Section 6)
- [ ] Update `metrics.md` provenance fields with CostReceipt (Section 5)
- [ ] Update glossary with new terms: CostPolicy, CostReceipt, circuit breaker, budget pressure, cost attribution
- [ ] Update primer with cost governance concepts and examples
- [ ] Reference implementation: CostReconciler
- [ ] Reference implementation: cost circuit breaker in agent runtime
- [ ] Reference implementation: cost attribution store
- [ ] Reference implementation: cost-aware model selection in agent runner
- [ ] Conformance tests: cost policy validation
- [ ] Conformance tests: cost-based quality gate evaluation
- [ ] Conformance tests: budget alert threshold behavior

## Open Questions

1. **Human review cost estimation** — How should the orchestrator estimate the cost of human review time? Options: (a) configure an hourly rate per reviewer role, (b) measure actual review time via PR event timestamps (review_requested → review_submitted), (c) use industry averages. Option (b) is most accurate but requires tracking PR review lifecycle events.

2. **Cross-provider cost normalization** — When the fallback chain routes to a different provider (Anthropic → OpenAI), costs are not directly comparable (different pricing, different token counts for the same task). Should the spec define a normalized cost unit, or report raw provider-specific costs?

3. **Cache savings attribution** — When a cached response avoids a $2 API call, who gets credit for the $2 savings? The agent that populated the cache, or the agent that benefited from the cache hit? This affects cost-per-agent metrics.

4. **Cost forecasting model** — The CostReconciler uses linear extrapolation for `projectedMonthEnd`. Real usage patterns are often non-linear (higher at sprint start, lower at sprint end). Should the spec define a specific forecasting method, or leave it to implementations?

5. **Infrastructure cost allocation** — The orchestrator itself consumes compute (CI/CD runners, server hosting). How should this baseline cost be allocated? Options: (a) exclude from pipeline costs (treat as overhead), (b) distribute evenly across all pipeline executions, (c) allocate proportionally to execution duration.

## References

- [AI-SDLC metrics.md §2.4](../metrics.md#24-economic-efficiency) — Existing economic efficiency metrics
- [AI-SDLC metrics.md §4](../metrics.md#4-provenance-tracking) — Existing provenance tracking
- [AI-SDLC autonomy.md §6](../autonomy.md#6-demotion-triggers) — Existing demotion trigger system
- [AI-SDLC spec.md §5.1](../spec.md#51-pipeline) — Pipeline resource definition
- [AI-SDLC spec.md §5.3](../spec.md#53-qualitygate) — QualityGate resource definition
- [autonomy-policy.schema.json](../schemas/autonomy-policy.schema.json) — Existing `transactionLimit` field
- [quality-gate.schema.json](../schemas/quality-gate.schema.json) — Existing gate rule types
- [RFC-0002: Pipeline Orchestration Policy](./RFC-0002-pipeline-orchestration.md) — Stage failure policies (retry costs)
- [RFC-0003: AI-SDLC Orchestrator Product Strategy](./RFC-0003-product-first-implementation-strategy.md) — Orchestrator architecture and commercial model
- [Anthropic API Pricing](https://www.anthropic.com/pricing) — Model pricing reference
- [OpenAI API Pricing](https://openai.com/api/pricing/) — Model pricing reference
