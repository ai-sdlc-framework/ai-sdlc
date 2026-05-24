# Shared classifier substrate

Public-API reference for the framework-level shared classifier introduced
by AISDLC-321 / RFC-0024 Refit Phase 2. This substrate is the keystone
serving OQ-2 (capture auto-triage), OQ-3 (PR-comment auto-classify),
OQ-5 (severity inference), OQ-11 (DoR-clarification classifier), and
RFC-0035 Phase 5 (Stage C decision recommendation).

Implementing one substrate prevents 4-5 duplicate classifier pipelines
and gives the calibration loop a single corpus to learn from.

## Import

```ts
import { substrate } from '@ai-sdlc/pipeline-cli/classifier';

// Pick the pieces you need from the namespace:
const { classify, recordOperatorOverride, resolveSilenceAsPositive } = substrate;
```

The substrate is exposed as a namespace re-export to avoid name clashes
with the existing conditional-review classifier under
`@ai-sdlc/pipeline-cli/classifier` (which exports `ClassifierDecision`,
`ClassifierOutput`, etc. with different shapes — RFC-0010 §12 reviewer
fan-out).

## `classify(input, taskType, opts) → ClassifierDecision`

The single public entry point.

### Arguments

| Name | Type | Required | Description |
|---|---|---|---|
| `input` | `ClassifierInput` | yes | `{ text: string, context?: Record<string, unknown> }` |
| `taskType` | `ClassifierTaskType` | yes | One of the 5 supported task types (see below) |
| `opts` | `ClassifyOpts` | no | Per-call overrides + dependency injection |

### `ClassifierTaskType` (the 5 supported task types)

| Task type | Allowed classifications | Caller |
|---|---|---|
| `capture-triage` | `quick-fix-task` \| `new-feature-issue` \| `scope-extension` \| `won't-fix` \| `tbd` | OQ-2 capture-triage rubric |
| `capture-severity` | `low` \| `medium` \| `high` \| `critical` | OQ-5 severity inference |
| `pr-comment-is-capture` | `is-capture` \| `not-capture` | OQ-3 PR-comment auto-classify |
| `dor-answer-is-new-concern` | `clarification` \| `new-concern` \| `ambiguous` | OQ-11 DoR-clarification classifier |
| `decision-recommendation` | caller-supplied `optionIds` (via `input.context.optionIds`) | RFC-0035 Stage C |

### `ClassifyOpts`

| Field | Default | Description |
|---|---|---|
| `threshold` | per-org config or `0.7` | Per-call confidence threshold override |
| `invoker` | required when calling | The `LlmInvoker` implementation (production = Anthropic Haiku adapter; tests = `FakeLlmInvoker`) |
| `repoRoot` | `process.cwd()` | Project root for config + corpus resolution |
| `corpusDir` | `<repoRoot>/.ai-sdlc/classifier-corpus/` | Per-task-type corpus directory |
| `model` | per-org config or `claude-haiku-4-5` | Model identifier passed to the invoker |
| `ledgerWriter` | none | SubscriptionLedger writer for cost accounting (AC-9) |
| `skipCorpus` | `false` | When true, skip the corpus write (useful for dry-run previews) |

### Return value

```ts
interface ClassifierDecision {
  classification: string;       // the LLM's choice (per task-type allowed set)
  confidence: number;           // [0, 1]
  reasoning: string;            // 1-2 sentence explanation
  metBehindThreshold: boolean;  // true iff confidence >= effectiveThreshold
  effectiveThreshold: number;   // the threshold that was actually applied
  corpusEntryId: string | null; // id for later `recordOperatorOverride()`
  model: string;                // model id that produced this decision
}
```

`metBehindThreshold === true` means **auto-apply**: the caller can take
the classification as-is. `false` means **route to operator**: surface to
TUI / Slack / queue, let a human confirm.

`classify()` never throws — failure modes (network, parse error,
disallowed classification) return a `pending` sentinel with confidence 0
so the caller doesn't need a try/catch wrapper.

## Configuration

### Per-org config files

The substrate reads from one of two YAML files based on task type:

- **`capture-*` / `pr-comment-*` / `dor-answer-*` task types** →
  `.ai-sdlc/capture-config.yaml`
- **`decision-recommendation`** → `.ai-sdlc/decisions-config.yaml`

Both honour the same shape:

```yaml
classifier:
  threshold: 0.7                   # global default for this file
  model: claude-haiku-4-5          # global default model
  dailyTokenCap: 1000000           # audit-only daily token budget
  overrideWindowHours: 24          # how long the operator has to override (capture-config only)
  perTaskType:
    capture-severity:              # tighter threshold for severity
      threshold: 0.85
      model: claude-sonnet-4-5
    pr-comment-is-capture:         # looser for noisier classification
      threshold: 0.55
```

Missing file / missing block / typo → falls back to defaults. The
substrate never throws on config issues.

### LLM invoker

`LlmInvoker` is a one-method interface:

```ts
interface LlmInvoker {
  invoke(req: LlmInvocationRequest): Promise<LlmInvocationResponse>;
}
```

Production callers wire an Anthropic Haiku adapter (the substrate doesn't
depend on `@anthropic-ai/sdk` directly — that adapter lives in a
downstream consumer module). Tests inject `FakeLlmInvoker` with scripted
responses:

```ts
import { substrate } from '@ai-sdlc/pipeline-cli/classifier';

const invoker = new substrate.FakeLlmInvoker({
  'capture-triage': {
    classification: 'quick-fix-task',
    confidence: 0.85,
    reasoning: 'small fix in one file',
    inputTokens: 120,
    outputTokens: 30,
  },
});
```

## Override + silence-as-positive

Per AC-6 / AC-7:

### `recordOperatorOverride()`

Call when the operator overrides an auto-classification within the
override window. Flips the corpus entry's polarity from `pending` to
`negative` and records the operator's chosen classification + reason.

```ts
const result = substrate.recordOperatorOverride({
  repoRoot,
  taskType: 'capture-triage',
  corpusEntryId: decision.corpusEntryId,    // from classify()
  newClassification: 'new-feature-issue',
  reason: 'belongs in its own Issue — needs a separate PR',
});
// result.flipped === true | false
// result.reason ∈ { 'no-corpus-entry-id', 'entry-not-found', 'window-expired', 'already-resolved' }
```

### `resolveSilenceAsPositive()`

Call periodically (cron / TUI background task) to sweep `pending`
entries past the override window and flip them to `positive`.
Idempotent.

```ts
const result = substrate.resolveSilenceAsPositive({ repoRoot });
// result.promotedCount  — number of entries flipped this run
// result.perTaskType    — { 'capture-triage': 5, 'capture-severity': 2, ... }
// result.windowHours    — the window that was applied
```

The CLI `cli-classifier corpus resolve-silence` exposes this for cron
wiring.

## Calibration corpus

Per AC-4: entries land in
`<repoRoot>/.ai-sdlc/classifier-corpus/<task-type>.yaml` — one YAML
file per task type. Each entry is a `CalibrationCorpusEntry`:

```ts
interface CalibrationCorpusEntry {
  id: string;                                    // UUIDv4
  timestamp: string;                              // ISO-8601
  taskType: ClassifierTaskType;
  input: ClassifierInput;
  model: string;
  classification: string;
  confidence: number;
  reasoning: string;
  threshold: number;
  metBehindThreshold: boolean;
  polarity: 'pending' | 'positive' | 'negative';
  operatorOverrideClassification?: string;       // present iff polarity === 'negative'
  operatorOverrideReason?: string;
  operatorOverrideTimestamp?: string;
}
```

The corpus is written via rename-after-write for atomicity. Cross-
process write contention is rare (orchestrator + TUI is the realistic
deployment shape); last-writer-wins is acceptable for an append-only
audit log.

## `cli-classifier` — aggregator + sweeper

| Subcommand | Purpose | AC |
|---|---|---|
| `corpus aggregate` | Emit the aggregated training corpus | AC-5 |
| `corpus stats` | Per-task-type accuracy + override-rate summary | (operator visibility) |
| `corpus resolve-silence` | Sweep pending entries past the window → positive | AC-7 |

All subcommands accept `--task-type <type>`, `--corpus-dir <path>`,
`--repo-root <path>`, and `--format json|table` (aggregate + stats).

```bash
# Aggregate the training corpus across all 5 task types.
node pipeline-cli/bin/cli-classifier.mjs corpus aggregate

# Per-task-type stats with the ASCII table.
node pipeline-cli/bin/cli-classifier.mjs corpus stats --format table

# Sweep pending entries (idempotent — safe to run from cron).
node pipeline-cli/bin/cli-classifier.mjs corpus resolve-silence
```

## Subscription cost tracking (AC-9)

Pass a `ledgerWriter` to `classify()` to record token spend:

```ts
import { substrate } from '@ai-sdlc/pipeline-cli/classifier';

await substrate.classify(
  { text: 'some finding' },
  'capture-triage',
  {
    invoker,
    repoRoot,
    ledgerWriter: async (entry) => {
      // Wire to your SubscriptionLedger:
      await subscriptionLedger.append({
        harness: 'anthropic-haiku',
        accountId: 'default',
        tenant: 'main',
        tokens: entry.inputTokens + entry.outputTokens,
        timestamp: entry.timestamp,
      });
    },
  },
);
```

The writer is called once per `classify()` invocation, with the
LLM-reported token counts. Per-org daily token cap is surfaced via
`loadSubstrateConfig().dailyTokenCap` (audit-only — the substrate does
NOT enforce, since hard caps would silently drop classifications and
contaminate the corpus; enforcement belongs in the harness adapter).

## Downstream consumers — wiring guide

| Surface | Task type | Wiring task |
|---|---|---|
| OQ-2 capture auto-triage | `capture-triage` | RFC-0024 Refit Phase 3 (AISDLC-275) |
| OQ-3 PR-comment auto-classify | `pr-comment-is-capture` | RFC-0024 Refit Phase 4 (AISDLC-276) |
| OQ-5 severity inference | `capture-severity` | RFC-0024 Refit Phase 3 (AISDLC-275) |
| OQ-11 DoR-clarification classifier | `dor-answer-is-new-concern` | RFC-0024 Refit Phase 5 (AISDLC-277) |
| RFC-0035 Stage C decision recommendation | `decision-recommendation` | RFC-0035 Phase 5 (AISDLC-289) |

The substrate ships **without** the per-surface integrations — those land
in their own tasks. This task ships only the shared substrate: the
`classify()` API, the corpus storage, the override capture, the cost
hook, the CLI.

## See also

- [`spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md`](../../spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md) — OQ-2 / OQ-3 / OQ-5 / OQ-11 resolutions
- [`spec/rfcs/RFC-0035-decision-catalog-operator-routing.md`](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) — Stage C decision recommendation
- `pipeline-cli/src/classifier/classifier.ts` — sibling conditional-review classifier (RFC-0010 §12)
