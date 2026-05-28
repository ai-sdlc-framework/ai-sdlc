# Decision Catalog Phase 10 — Adopter Integration Path

**Audience**: AI-SDLC adopters wiring the RFC-0035 Phase 10 (AISDLC-294)
optional surfaces — research subagent, visual decision graphs, and
NotebookLM-style summaries — into their project.

> **Phase 10 is OPTIONAL.** v1 catalog operation (Stages A/B/C, support
> surface, calibration) does not require any of these surfaces. Add them
> when the operator workflow benefits — typically once decision volume
> exceeds ~10/week and operators want richer support.

## TL;DR

| Surface | What it gives you | Required wiring | Default |
|---|---|---|---|
| Research subagent | On-demand "compare how X / Y / Z handle this" findings for low-confidence Stage C recommendations | `ResearchSubagentInvoker` injected at the library call site | OFF (no invoker shipped) |
| Visual decision graphs | Mermaid (markdown / web) + standalone HTML page | Built-in; `cli-decisions graph <id>` | ON |
| NotebookLM summaries | 3-5 sentence executive summary per decision | `AI_SDLC_DECISION_NOTEBOOK_SUMMARIES=on` + `NotebookSummaryInvoker` | OFF |
| SubscriptionLedger cost cap | RFC-0010 §14.6 ledger debit per LLM call | `SubscriptionLedgerWriter` already wired in the substrate | n/a |

---

## 1. Init scaffold

The init scaffold ships
`.ai-sdlc/templates/decisions-config.yaml` as the canonical config
template. To adopt the Phase 10 config knobs:

```bash
# Copy the template (idempotent — overwrites if present):
cp .ai-sdlc/templates/decisions-config.yaml .ai-sdlc/decisions-config.yaml

# Edit to taste — the Phase 10 fields are:
#   - researchSubagentConfidenceThreshold (default 0.6)
```

The framework reads defaults from `loadDecisionsConfig()` /
`resolveDecisionsConfig()` — both wired into `cli-decisions`. There's no
runtime requirement to materialise the file at all; the template exists
as documentation + scaffold convenience.

## 2. Research subagent integration

The Decision Catalog ships the GATE (`shouldInvokeResearchSubagent`),
the INVOCATION CONTRACT (`ResearchSubagentInvoker`), and the
PERSISTENCE LAYER (`writeResearchArtifact` /
`readResearchArtifacts`) — but it does NOT bake in a transport. You
inject the invoker:

```ts
import {
  loadDecisionsConfig,
  projectDecision,
  resolveResearchSubagentThreshold,
  runResearchSubagent,
  type ResearchSubagentInvoker,
} from '@ai-sdlc/pipeline-cli';

// 1. Implement the invoker. Production wires a Claude Code subagent
//    spawn / `claude -p` shellout / Codex / etc.
const invoker: ResearchSubagentInvoker = async (input) => {
  // input.summary, input.body, input.options, input.recommendation
  // are all present. Return findings + model + token counts.
  const { stdout } = await runClaude({
    prompt: `Research the following decision: ${input.summary}`,
    options: input.options,
    framing: input.framing,
  });
  return {
    findingsMarkdown: stdout,
    model: 'claude-sonnet-4-5',
    inputTokens: 1500,
    outputTokens: 800,
  };
};

// 2. Wire the runner.
const workDir = process.cwd();
const decision = projectDecision('DEC-0042', { workDir });
const config = loadDecisionsConfig({ workDir });
const threshold = resolveResearchSubagentThreshold(config);
const stageC = decision?.status.evaluation?.stageC ?? null;

const result = await runResearchSubagent({
  decision: decision!,
  stageC,
  threshold,
  invoker,
  workDir,
  ledgerWriter: mySubscriptionLedger.append,  // AC#5
});

if (result.invoked) {
  console.log(`Research findings written to ${result.artifact!.path}`);
}
```

The runner returns `{ invoked: false, skipReason }` when the gate doesn't
fire — surface the skip reason in your UI rather than spawning silently.

### Read-only inspection (no invoker required)

`cli-decisions research <id>` is **read-only** by design — it lists
persisted findings without spawning a subagent. The CLI deliberately
does not bake in a transport so each adopter project can wire their own
without monkey-patching the CLI:

```bash
# List findings persisted to .ai-sdlc/_decisions/research/
node pipeline-cli/bin/cli-decisions.mjs research DEC-0042

# Report the gate decision based on current Stage C output:
node pipeline-cli/bin/cli-decisions.mjs research DEC-0042 --gate
```

## 3. Visual decision graphs

Built-in. No invoker required.

```bash
# Mermaid (default — pipe to a .md file or paste into a web surface):
node pipeline-cli/bin/cli-decisions.mjs graph DEC-0042 --format mermaid

# Standalone HTML (Mermaid renderer ships from CDN):
node pipeline-cli/bin/cli-decisions.mjs graph DEC-0042 --format html \
    > /tmp/dec-0042.html && open /tmp/dec-0042.html

# JSON (for programmatic consumption):
node pipeline-cli/bin/cli-decisions.mjs graph DEC-0042 --format json
```

The graph is also embedded in `cli-decisions show <id>` (Mermaid fence
+ text outline fallback for TUI consumers).

## 4. NotebookLM-style summaries

Gated behind `AI_SDLC_DECISION_NOTEBOOK_SUMMARIES`. To enable + wire:

```bash
# 1. Turn on the flag:
export AI_SDLC_DECISION_NOTEBOOK_SUMMARIES=on
```

```ts
// 2. Wire the invoker (same pattern as research subagent):
import {
  isNotebookSummariesEnabled,
  projectDecision,
  runNotebookSummary,
  type NotebookSummaryInvoker,
} from '@ai-sdlc/pipeline-cli';

if (!isNotebookSummariesEnabled()) return;  // respect the flag

const invoker: NotebookSummaryInvoker = async (input) => ({
  summaryMarkdown: await callYourLlm(input),
  model: 'claude-haiku-4-5',
  inputTokens: 800,
  outputTokens: 200,
});

const decision = projectDecision('DEC-0042', { workDir: process.cwd() });
const result = await runNotebookSummary({
  decision: decision!,
  invoker,
  workDir: process.cwd(),
  ledgerWriter: mySubscriptionLedger.append,
});
```

Summaries are single-file per decision (`.ai-sdlc/_decisions/summaries/<DEC>.md`)
— re-running overwrites. Read with:

```bash
node pipeline-cli/bin/cli-decisions.mjs summary DEC-0042
```

## 5. SubscriptionLedger cost cap (AC#5)

Both `runResearchSubagent` and `runNotebookSummary` accept the
RFC-0010 `SubscriptionLedgerWriter` already in use by the shared
classifier substrate (`pipeline-cli/src/classifier/substrate/types.ts`).
Wire ONCE per session:

```ts
import type { SubscriptionLedgerWriter } from '@ai-sdlc/pipeline-cli';

const ledgerWriter: SubscriptionLedgerWriter = async (entry) => {
  await myLedger.append({
    timestamp: entry.timestamp,
    taskType: entry.taskType,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    // your own cost calculation goes here
  });
};
```

Pass `ledgerWriter` to BOTH runners so research + summary debits land in
the same ledger. The substrate already debits Stage C; no extra wiring
required there.

## 6. Verification

After wiring:

```bash
# 1. Confidence gate fires below threshold:
node pipeline-cli/bin/cli-decisions.mjs research DEC-0042 --gate --format json

# 2. Graph renders for decisions with sub-decisions:
node pipeline-cli/bin/cli-decisions.mjs graph DEC-0042 --format mermaid

# 3. Summary read returns persisted body (after `runNotebookSummary`):
node pipeline-cli/bin/cli-decisions.mjs summary DEC-0042

# 4. Ledger entries land per-call (inspect via your ledger tooling).
```

## References

- [RFC-0035 §8.2](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md#82-on-demand-elements) — On-demand decision-support elements
- [RFC-0035 OQ-10](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md#15-open-questions) — Sub-decision graph fidelity resolution
- [RFC-0010 §14.6](../../spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md) — SubscriptionLedger contract
- [decisions-config template](../../.ai-sdlc/templates/decisions-config.yaml)
- Library API: `pipeline-cli/src/decisions/{research-subagent,notebook-summary,decision-support-surface}.ts`
