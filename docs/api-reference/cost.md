# Cost Governance

API reference for cost governance types defined by [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md). These types extend `Pipeline.spec`, `AgentRole.spec`, `QualityGate.spec.gates[].rule`, and provenance metadata to support declarative cost budgets, cost-based gating, cost-aware model selection, and per-artifact cost receipts.

All fields documented here are **optional**. RFC-0004 is a non-breaking extension — existing resources validate against updated schemas without modification, and implementations that don't support cost governance MAY ignore the new fields (though they SHOULD log a warning when present).

## Import

```typescript
import type {
  // Pipeline cost policy
  CostPolicy,
  ExecutionCostLimit,
  StageCostPolicy,
  StageCostLimit,
  CostThreshold,
  BudgetPolicy,
  BudgetAlert,
  AttributionPolicy,
  ModelPricingConfig,
  // Provenance cost receipt
  CostReceipt,
  CostBreakdown,
  ExecutionCostDetail,
} from '@ai-sdlc/reference';
```

## CostPolicy

Per RFC-0004 §1, the optional `costPolicy` field on `Pipeline.spec` declares cost boundaries at three levels: per-execution, per-stage, and per-budget-period.

| Field          | Type                  | Required | Description                                                       |
| -------------- | --------------------- | -------- | ----------------------------------------------------------------- |
| `perExecution` | `ExecutionCostLimit`  | MAY      | Cost limits for the entire pipeline execution.                    |
| `perStage`     | `StageCostPolicy`     | MAY      | Cost limits applied per pipeline stage.                           |
| `budget`       | `BudgetPolicy`        | MAY      | Rolling budget window for the team or namespace.                  |
| `attribution`  | `AttributionPolicy`   | MAY      | How costs are attributed and allocated for chargeback / showback. |
| `modelPricing` | `ModelPricingConfig`  | MAY      | Model price table used for cost calculation.                      |

When a `CostPolicy` is present, the orchestrator MUST evaluate the limits in real time during agent execution per RFC-0004 §4 (Real-Time Cost Circuit Breaker), not only post-hoc. A missing `costPolicy` means no cost enforcement runs (current pre-RFC-0004 behavior).

### Example

```yaml
spec:
  costPolicy:
    perExecution:
      hardLimit: { amount: 100, currency: USD, action: abort }
    perStage:
      defaults:
        tokenLimit: 100000
        costLimit: { amount: 15, currency: USD, action: abort }
    budget:
      period: month
      amount: 5000
      currency: USD
      alerts:
        - threshold: 0.80
          action: require-approval
          approver: engineering-manager
```

## ExecutionCostLimit

Per RFC-0004 §1, soft and hard ceilings for the entire pipeline execution.

| Field       | Type             | Required | Description                                                |
| ----------- | ---------------- | -------- | ---------------------------------------------------------- |
| `softLimit` | `CostThreshold`  | MAY      | Threshold that triggers a warning or approval requirement. |
| `hardLimit` | `CostThreshold`  | MAY      | Threshold that aborts the pipeline unconditionally.        |

When both are present, the soft limit MUST trigger first (i.e., `softLimit.amount < hardLimit.amount`). Implementations SHOULD reject configurations that violate this ordering.

## CostThreshold

Per RFC-0004 §1, a single cost trigger with an action.

| Field      | Type     | Required | Description                                            |
| ---------- | -------- | -------- | ------------------------------------------------------ |
| `amount`   | `number` | MUST     | The cost threshold value.                              |
| `currency` | `string` | MUST     | ISO 4217 currency code. Defaults to `USD` if omitted.  |
| `action`   | `string` | MUST     | One of: `notify`, `require-approval`, `abort`.         |

| Action             | Behaviour                                                                             |
| ------------------ | ------------------------------------------------------------------------------------- |
| `notify`           | Emit an event to attribution dimensions and configured channels. No execution change. |
| `require-approval` | Pause execution and request a human approval before continuing.                       |
| `abort`            | Interrupt the agent, save partial work, mark the stage `Failed`, run `onFailure`.     |

## StageCostPolicy

Per RFC-0004 §1, per-stage cost ceilings with optional per-stage overrides.

| Field       | Type                                | Required | Description                                       |
| ----------- | ----------------------------------- | -------- | ------------------------------------------------- |
| `defaults`  | `StageCostLimit`                    | MAY      | Default ceilings applied to every stage.          |
| `overrides` | `Record<string, StageCostLimit>`    | MAY      | Per-stage overrides keyed by stage name.          |

When both are present, `overrides[stageName]` fields supersede `defaults` field-by-field (not whole-object replacement) so a stage can raise `tokenLimit` while inheriting the default `costLimit`.

## StageCostLimit

Per RFC-0004 §1, the three independent ceilings any stage can carry.

| Field         | Type             | Required | Description                                                                  |
| ------------- | ---------------- | -------- | ---------------------------------------------------------------------------- |
| `tokenLimit`  | `integer`        | MAY      | Maximum total tokens (input + output) for the stage.                         |
| `timeLimit`   | `string`         | MAY      | Maximum wall-clock time (ISO 8601 duration, e.g. `PT30M`).                   |
| `costLimit`   | `CostThreshold`  | MAY      | Maximum monetary cost for the stage.                                         |

Whichever ceiling trips first triggers the stage's `onFailure` policy. RFC-0004 §4 requires the orchestrator to monitor token consumption from each model API response and recompute running cost every 30 seconds (or every N API calls) so a runaway loop is interrupted before the bill arrives.

## BudgetPolicy

Per RFC-0004 §1, a rolling budget window for a team or namespace, evaluated continuously by the `CostReconciler`.

| Field      | Type                  | Required | Description                                                  |
| ---------- | --------------------- | -------- | ------------------------------------------------------------ |
| `period`   | `string`              | MUST     | Rolling window. One of: `day`, `week`, `month`, `quarter`.   |
| `amount`   | `number`              | MUST     | Budget amount for the period.                                |
| `currency` | `string`              | MUST     | ISO 4217 currency code.                                      |
| `alerts`   | `BudgetAlert[]`       | MAY      | Ordered list of consumption-threshold alerts.                |

The reconciler computes `consumption = currentSpend / amount` and walks alerts in declared order. Each alert fires at most once per budget period.

## BudgetAlert

Per RFC-0004 §1, one threshold within a `BudgetPolicy`.

| Field        | Type        | Required | Description                                                                 |
| ------------ | ----------- | -------- | --------------------------------------------------------------------------- |
| `threshold`  | `number`    | MUST     | Fraction of budget (0.0 – 1.0) that triggers this alert.                    |
| `action`     | `string`    | MUST     | One of: `notify`, `require-approval`, `block`.                              |
| `targets`    | `string[]`  | MAY      | Notification targets (Slack channels, email addresses).                     |
| `approver`   | `string`    | MAY      | Role or identity required for `require-approval`.                           |
| `message`    | `string`    | MAY      | Custom message displayed when the alert triggers.                           |

| Action             | Behaviour                                                                        |
| ------------------ | -------------------------------------------------------------------------------- |
| `notify`           | Post to `targets`. New executions continue normally.                             |
| `require-approval` | New pipeline executions wait until `approver` confirms. In-flight ones continue. |
| `block`            | Hard stop on new executions. In-flight executions complete normally.             |

## AttributionPolicy

Per RFC-0004 §1, how costs are tracked across dimensions and allocated for chargeback.

| Field         | Type        | Required | Description                                                                                    |
| ------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| `dimensions`  | `string[]`  | MUST     | Tracking dimensions. Values: `agent`, `model`, `stage`, `repository`, `complexity`, `team`, `feature`. |
| `chargeback`  | `string`    | MAY      | Cost allocation strategy. One of: `per-repository`, `per-team`, `per-agent`, `proportional`.   |

The orchestrator tags every cost data point with all configured dimensions so post-hoc analysis can group by any combination.

## ModelPricingConfig

Per RFC-0004 §1, model price table used to convert token counts into monetary cost.

| Field     | Type                                          | Required | Description                                            |
| --------- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| `source`  | `string`                                      | MUST     | One of: `config` (static table) or `api` (fetch from provider). |
| `models`  | `Record<string, { inputPerMTok, outputPerMTok, cacheReadPerMTok }>` | MAY | Per-model pricing in USD per million tokens. |

RFC-0004 deliberately does NOT bundle a pricing table in the spec — pricing changes frequently, and embedding it would force a spec revision every time a provider revised rates. Operators maintain `models` in their pipeline (or fetch it from the provider via an adapter).

### Example

```yaml
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
```

## CostReceipt

Per RFC-0004 §5, the cost block appended to provenance metadata on every PR the orchestrator produces.

| Field        | Type                    | Required | Description                                              |
| ------------ | ----------------------- | -------- | -------------------------------------------------------- |
| `totalCost`  | `number`                | MUST     | Total cost in the specified currency.                    |
| `currency`   | `string`                | MUST     | ISO 4217 currency code.                                  |
| `breakdown`  | `CostBreakdown`         | MUST     | Itemized cost components.                                |
| `execution`  | `ExecutionCostDetail`   | MAY      | Detailed execution metrics for forensic analysis.        |

A `CostReceipt` is the auditable, per-artifact answer to "what did this PR cost?". Over time, the corpus of receipts is the dataset for answering "what does it cost to ship a feature at complexity tier N?" and "which model gives the best quality-per-dollar?".

## CostBreakdown

Per RFC-0004 §5, itemized cost components within a `CostReceipt`.

| Field              | Type     | Required | Description                                                            |
| ------------------ | -------- | -------- | ---------------------------------------------------------------------- |
| `tokenCost`        | `number` | MUST     | Cost of input + output tokens.                                         |
| `cacheSavings`     | `number` | MAY      | Cost avoided through cache hits (negative value, conventionally).      |
| `computeCost`      | `number` | MAY      | Infrastructure / GPU cost for self-hosted models.                      |
| `humanReviewCost`  | `number` | MAY      | Estimated cost of human review time (per RFC-0004 Open Question §1).   |

`humanReviewCost` is the economically dominant term in most workflows — RFC-0004's motivation cites a $2 token cost vs $37.50 for 30 minutes of senior-engineer review time. Reporting it in the receipt makes that 95% of TCO visible instead of invisible.

## ExecutionCostDetail

Per RFC-0004 §5, low-level execution metrics that feed cost calculation.

| Field              | Type      | Required | Description                                                |
| ------------------ | --------- | -------- | ---------------------------------------------------------- |
| `inputTokens`      | `integer` | MUST     | Total input tokens consumed.                               |
| `outputTokens`     | `integer` | MUST     | Total output tokens consumed.                              |
| `cacheReadTokens`  | `integer` | MAY      | Tokens served from cache.                                  |
| `modelCalls`       | `integer` | MAY      | Number of API calls to the model.                          |
| `wallClockSeconds` | `number`  | MAY      | Total execution wall-clock time.                           |
| `retryCount`       | `integer` | MAY      | Number of retries (each retry adds cost).                  |

Implementations MUST populate `inputTokens` and `outputTokens` from the model API response metadata. The remaining fields are recommended for forensic analysis and cost-anomaly detection.

## See also

- [Tutorial: Cost Governance with CostPolicy](../tutorials/cost-governance.md) — worked example walking a team through declaring `costPolicy`, `budget`, and `modelSelection`.
- [Operator Runbook — Quota and cost events](../operations/operator-runbook.md#quota-and-cost-events) — operational response when a `BudgetExceeded` event fires.
- [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md) — full normative spec, alternatives considered, open questions.
