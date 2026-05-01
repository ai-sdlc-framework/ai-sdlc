# Tutorial: Cost Governance with CostPolicy

This tutorial walks a team through declaring an enforceable cost posture for their AI-SDLC pipeline using the `costPolicy` extension introduced in [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md). By the end you will have:

- A pipeline with a hard per-execution cost ceiling so a single runaway agent cannot burn through the team's monthly budget in one afternoon.
- Per-stage `tokenLimit` and `costLimit` fields so the implementation stage gets the headroom it needs while the lint stage stays cheap.
- A monthly `BudgetPolicy` with notify / require-approval / block alerts at 60%, 80%, and 100%.
- Cost-aware `modelSelection` on the implementing agent, so simple tasks route to the cheapest model and expensive models are only used when complexity warrants it.
- `budgetPressure` rules that downshift models automatically as the team consumes its monthly budget.

The mental model: RFC-0004 treats cost governance like a circuit breaker, not a dashboard. The pipeline reconciler enforces the limits in real time during agent execution rather than reporting the overspend after the bill arrives. Every threshold below corresponds to a deterministic action the orchestrator MUST take per RFC-0004 §4 (Real-Time Cost Circuit Breaker).

## Prerequisites

- A working pipeline from [Tutorial 1: Setting Up a Basic Pipeline](01-basic-pipeline.md).
- An [AgentRole](03-progressive-autonomy.md) for the agent doing the implementing work.
- A current model pricing table. RFC-0004 deliberately does NOT bundle pricing because providers change rates often — you maintain `modelPricing.models` in the pipeline (or fetch it from your provider via an adapter).

## Step 1: Add the cost ceiling

Start with the smallest piece of cost governance that pays for itself: a hard per-execution cap. Without this, a single looping agent can burn through hundreds of dollars before a human notices.

Edit your pipeline:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: feature-delivery
  namespace: team-alpha
spec:
  costPolicy:
    perExecution:
      hardLimit:
        amount: 100
        currency: USD
        action: abort # RFC-0004: kill the pipeline, no override
  stages:
    - name: implement
      agent: code-agent
```

What the orchestrator does with this: when running a stage's agent, the orchestrator monitors token consumption from each model API response. As soon as the running cost — `Σ (input_tokens × input_price + output_tokens × output_price)` — crosses `100 USD`, the agent is interrupted, partial work is saved, the stage is marked `Failed (cost limit exceeded)`, and the stage's `onFailure` policy kicks in.

This is the absolute minimum cost governance per RFC-0004 §4. Ship this first.

## Step 2: Add per-stage token and cost limits

The per-execution ceiling catches end-state runaways but not early-stage loops. A reasoning agent stuck in a loop on a single stage can blow past a sensible per-stage budget long before the per-execution hard cap trips.

Add `perStage`:

```yaml
spec:
  costPolicy:
    perExecution:
      hardLimit:
        amount: 100
        currency: USD
        action: abort
    perStage:
      defaults:
        tokenLimit: 100000 # max input + output tokens per stage
        timeLimit: PT30M # ISO 8601 duration
        costLimit:
          amount: 15
          currency: USD
      overrides:
        implement:
          tokenLimit: 200000 # implementation gets more headroom
          costLimit:
            amount: 25
            currency: USD
        review:
          tokenLimit: 50000 # review is bounded
          costLimit:
            amount: 5
            currency: USD
```

Per RFC-0004 §1, each `StageCostLimit` carries three independent ceilings (`tokenLimit`, `timeLimit`, `costLimit`). Whichever trips first triggers the stage's `onFailure`. This matters because a slow stage can be cheap in dollars but expensive in wall-clock time, and a token-cheap stage that uses an expensive model can blow the dollar limit. All three are evaluated.

A defensive default for a typical workflow:

| Stage         | Token limit | Cost limit (USD) | Time limit | Why                                                         |
| ------------- | ----------: | ---------------: | ---------- | ----------------------------------------------------------- |
| triage        |      30,000 |              2.0 | PT5M       | Triage is read-heavy, low-output                            |
| implement     |     200,000 |             25.0 | PT45M      | Implementation runs the most tokens                         |
| review        |      50,000 |              5.0 | PT10M      | Review is bounded scope                                     |
| validate (CI) |      10,000 |              0.5 | PT2M       | Validation is mostly external CI, agent only summarises     |

## Step 3: Add the monthly budget with tiered alerts

The cost ceiling protects you from a single bad execution. The `BudgetPolicy` protects you from the slow death of 200 small executions adding up to a $5,000 surprise.

```yaml
spec:
  costPolicy:
    # ... perExecution + perStage from steps 1-2 ...
    budget:
      period: month
      amount: 5000
      currency: USD
      alerts:
        - threshold: 0.60 # 60% — informational
          action: notify
          targets: ['#engineering']
        - threshold: 0.80 # 80% — require approval for new pipelines
          action: require-approval
          approver: engineering-manager
        - threshold: 1.00 # 100% — hard stop
          action: block
          message: 'Monthly budget exhausted. Contact engineering-manager.'
```

Per RFC-0004 §1 (BudgetPolicy + BudgetAlert), the `CostReconciler` evaluates these thresholds on a 5-minute cycle. Each threshold fires at most once per budget period. The `notify` action posts to Slack, `require-approval` blocks new pipeline executions until an approver clicks through, and `block` is a hard stop.

The 60/80/100 split is RFC-0004's default recommendation:

- **60% (notify)** — purely informational. The team sees consumption in Slack but no friction is added. This is the "are we trending normally?" signal.
- **80% (require-approval)** — friction. New pipeline executions need engineering-manager approval. This forces the team to consciously decide which features ship for the rest of the month.
- **100% (block)** — hard stop. No new executions until the next budget period or until the budget is raised. In-flight executions complete normally; only new ones are blocked.

## Step 4: Add cost-aware model selection

Model pricing varies up to 300x between models — RFC-0004's motivation cites Claude Haiku at $0.25/MTok input vs Claude Opus at $15/MTok input. Letting every stage default to the most expensive model is the single biggest source of cost waste. The `modelSelection` field on `AgentRole` routes by complexity to the right price/performance point.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  role: 'Software Engineer'
  goal: 'Implement features and fix bugs cost-effectively'
  tools: [code_editor, terminal, git_client, test_runner]
  modelSelection:
    rules:
      - complexity: [1, 3]
        model: claude-haiku-4-5
        rationale: 'Simple tasks: fast, cheap, sufficient'
      - complexity: [4, 6]
        model: claude-sonnet-4-5
        rationale: 'Medium tasks: balanced cost/capability'
      - complexity: [7, 10]
        model: claude-opus-4-6
        rationale: 'Complex tasks: maximum reasoning capability'
    fallbackChain:
      - claude-sonnet-4-5
      - claude-haiku-4-5
```

Per RFC-0004 §3, the orchestrator scores task complexity (typically from the issue body and history) and routes to the model whose `complexity` range covers the score. The `fallbackChain` handles transient outages — if the preferred model is rate-limited or unavailable, the orchestrator walks down the chain.

## Step 5: Tune `budgetPressure` to downshift on threshold

The crown jewel of RFC-0004's cost-aware routing is the interaction between `budget` and `modelSelection.budgetPressure`. As the team's monthly budget depletes, `budgetPressure` rules force model downshifts automatically — without humans having to remember to flip a flag.

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: code-agent
spec:
  modelSelection:
    rules:
      - complexity: [1, 3]
        model: claude-haiku-4-5
      - complexity: [4, 6]
        model: claude-sonnet-4-5
      - complexity: [7, 10]
        model: claude-opus-4-6
    budgetPressure:
      - above: 0.80 # at 80% budget consumed
        downshift: 1 # use one tier cheaper than the rule says
        notify: ['#engineering']
      - above: 0.95 # at 95% budget consumed
        downshift: 2 # use the cheapest available model
        notify: ['#engineering', '@tech-lead']
```

How to read the worked example: a complexity-7 task at 50% budget would route to `claude-opus-4-6` (per the rules). The same complexity-7 task at 85% budget consumed would downshift one tier to `claude-sonnet-4-5`. At 96% consumed it would downshift two tiers to `claude-haiku-4-5`. The `notify` arrays make the downshift visible so the team can decide whether to raise the budget or accept the temporary quality reduction.

## Step 6: Verify the policy

After editing, validate against the schema:

```bash
ai-sdlc validate pipelines/feature-delivery.yaml
ai-sdlc validate agents/code-agent.yaml
```

Then dry-run an execution to see the cost-receipt shape per RFC-0004 §5 (Cost Attribution in Provenance):

```bash
ai-sdlc dry-run --pipeline feature-delivery --task TASK-123
```

Expected output includes the `provenance.cost` block:

```yaml
provenance:
  model: claude-sonnet-4-5
  cost:
    totalCost: 2.34
    currency: USD
    breakdown:
      tokenCost: 1.89
      cacheSavings: -0.45
      humanReviewCost: 18.75
    execution:
      inputTokens: 42000
      outputTokens: 8500
      cacheReadTokens: 15000
      modelCalls: 12
      wallClockSeconds: 147
      retryCount: 0
```

Every PR the orchestrator opens carries a cost receipt. Over time, this becomes your dataset for answering "what does it cost to ship a feature at complexity tier N?" and "which model gives the best quality-per-dollar?" — questions a finance team will eventually ask, and questions you cannot answer without provenance-level cost attribution.

## What you have now

- A pipeline that cannot, per RFC-0004, exceed `$100` on any single execution.
- Per-stage limits that catch a looping agent within ~30 minutes / 200K tokens.
- A monthly budget with three escalating action tiers (notify → require-approval → block) so finance has predictability and engineering has guardrails.
- An agent that picks the cheapest model that can do the job, and downshifts further as budget pressure increases.
- A cost receipt on every PR so chargeback / showback is data-driven, not estimated.

## Related

- [RFC-0004 — Cost Governance and Attribution](../../spec/rfcs/RFC-0004-cost-governance-and-attribution.md) — full normative spec
- [API Reference — Cost Governance](../api-reference/cost.md) — type signatures for `CostPolicy`, `BudgetPolicy`, `CostReceipt`
- [Operator Runbook — Quota and cost events](../operations/operator-runbook.md#quota-and-cost-events) — what to do when a `BudgetExceeded` event fires
- [Tutorial 3: Progressive Autonomy](03-progressive-autonomy.md) — RFC-0004's cost-based demotion triggers (§7) plug into the autonomy ladder
