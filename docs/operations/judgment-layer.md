# Judgment layer: operator runbook and adopter guide

**Audience**: operators who turn the judgment layer on, and adopters who need to know
what it sends and where. Design reference: RFC-0049
([`spec/rfcs/RFC-0049-system-one-judgment-layer.md`](../../spec/rfcs/RFC-0049-system-one-judgment-layer.md)).
Promoting a judgment from `shadow` to `enforce` is a separate runbook:
[`judgment-promotion.md`](judgment-promotion.md). The rules a judgment definition must
satisfy are in [`judgment-definitions.md`](judgment-definitions.md).

## What it does and does not do

The judgment layer asks a provider a closed-set question about a piece of text (pick
one option, pick a level, or answer yes or no) and gets back probabilities, not
generated text. A small, per-judgment function turns those probabilities and your
thresholds into one of three outcomes:

- `act`: the judgment decided.
- `escalate`: the judgment is unsure, and the work goes to an operator or a model.
- `abstain`: the judgment declined. **The caller does exactly what it did before the
  layer existed.**

It does not write code, review code, merge anything, or run on its own: each call site
asks one catalogued judgment. It is off unless you configure a provider. Every judgment
starts in `shadow`: the call is made and logged, but its answer is ignored and the
existing path decides. A `tighten-only` judgment can only add scrutiny; on work that is
not from the trusted backlog, every judgment is treated as `tighten-only`, so a steered
answer cannot dismiss or wave through anything.

## Enable it

Enabling is one config file and, for the hosted provider, one environment variable.

1. Commit `.ai-sdlc/judgment-config.yaml` to your base branch (see the minimal configs
   below). The runtime reads the copy committed on the trusted base branch only
   (`origin/main` by default), so a pull request cannot relax the configuration that
   governs it.
2. For `jev`, export the key in the environment that runs the pipeline:
   `TYPESAFE_API_KEY`. The key is read at call time and never from the file.
3. Check the setup:

   ```bash
   node pipeline-cli/bin/cli-judgment.mjs doctor --config .ai-sdlc/judgment-config.yaml
   node pipeline-cli/bin/cli-judgment.mjs list --config .ai-sdlc/judgment-config.yaml
   ```

   `--config` reads a local file instead of the base-branch copy, which is how you
   check a config before you commit it. `doctor` reports whether the layer is
   enabled, the provider, whether its credential is present, and whether the model is
   pinned to an exact version. `list` shows every registered judgment with its
   configured and effective mode. `doctor --live` sends one minimal request; it needs a
   registered provider and a set credential variable, and exits non-zero (skipping the
   request) without them. An `openai-compatible` provider on a keyless endpoint, even a
   local one that works at call time, has no credential variable, so the CLI skips
   `--live` for it unless `apiKeyEnv` names a variable that is set. `ai-sdlc doctor` also runs the
   `judgment-layer` checks described in [`doctor.md`](doctor.md).

A config that is missing, unreadable or fails schema validation turns the layer off
silently; run `doctor` to see `judgment layer: disabled`. The schema is
`spec/schemas/judgment-config.v1.schema.json`.

## Providers

### `jev`

Posts to the Jev system-one endpoint with a bearer key. Reads `TYPESAFE_API_KEY`
(required) and optionally `TYPESAFE_BASE_URL` to point at another host. It calibrates
its probabilities, so it is the only built-in provider that can run a judgment in
`enforce`.

Minimal config:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: JudgmentConfig
metadata:
  name: ai-sdlc-judgment
spec:
  provider: jev
  model: jev-1.13.0
  egress:
    allow: [work-item-text]
  defaults:
    mode: shadow
    timeoutMs: 10000
    cache: true
```

### `openai-compatible`

Posts to any chat-completions endpoint (`<baseUrl>/chat/completions`), which covers
Ollama, OpenAI and compatible gateways. It asks the model for a JSON object with one
answer per question and validates each answer against the question's options; a
missing, malformed or out-of-set answer fails the whole call and the judgment
abstains. Its probabilities are the model's own self-report, so it declares
uncalibrated probabilities and **every judgment on it runs in `shadow` only**, whatever
the config says (downgrade reason `uncalibrated-provider`).

Options live under `spec.providerOptions.openai-compatible`:

| Option | Meaning | Default |
|---|---|---|
| `baseUrl` | Endpoint base, for example `http://localhost:11434/v1`. Required. | none |
| `model` | Model id sent to the endpoint. Taken from `spec.model` when omitted. | none |
| `apiKeyEnv` | Name of the environment variable that holds the key. Optional for a local endpoint. | none |
| `timeoutMs` | Per-attempt timeout. | 10000 |
| `maxRetries` | Retries after the first attempt on 429 and 5xx. | 2 |
| `maxStateTokens`, `maxRequestTokens`, `maxChoiceOptions`, `maxScoreLevels` | Size limits the runtime enforces before calling. | 8000, 16000, 50, 10 |
| `inputCostPer1MTokens`, `outputCostPer1MTokens` | Prices used for cost attribution. | 0 |

Minimal config for a local Ollama endpoint:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: JudgmentConfig
metadata:
  name: ai-sdlc-judgment
spec:
  provider: openai-compatible
  model: llama3.1:8b
  providerOptions:
    openai-compatible:
      baseUrl: http://localhost:11434/v1
  egress:
    allow: [work-item-text]
  defaults:
    mode: shadow
    timeoutMs: 30000
    cache: true
```

For a hosted gateway, use an `https` `baseUrl` and add `apiKeyEnv: <YOUR_KEY_VAR>`;
the variable must be set or the provider reports itself unavailable and every judgment
abstains.

## Egress classes

Each judgment declares one egress class, the kind of data its question sends to the
provider. `spec.egress.allow` lists the classes you permit. Naming a provider enables
`work-item-text` only; add the others explicitly.

| Class | What is sent |
|---|---|
| `work-item-text` | Task and issue text, decision summaries, capture findings, review-comment text. |
| `code-diff` | Pull request diffs and code. |
| `agent-output` | Output produced by an agent run. |

A judgment whose class is not allowed abstains with `egress-not-permitted` and makes
no call. Before anything leaves the process, the state and the question text are
passed through secret redaction. The one exemption: a provider whose `baseUrl` is on
the local machine (`localhost`, `127.x.x.x`, `::1`) skips `spec.egress.allow` entirely,
for **every** class including `code-diff` and `agent-output`. The check looks only at
the address. It assumes the endpoint serves the model itself and does not forward the
request. A loopback gateway that forwards upstream (a LiteLLM-style proxy, an Ollama
setup that offloads to a cloud model, an SSH tunnel to a remote host) would receive
all of that data even though `egress.allow` appears to block it. Only point a
loopback `baseUrl` at an endpoint you have confirmed runs the model locally. Config
text cannot grant the exemption; it comes from the endpoint address.

## Modes

Set per judgment under `spec.judgments.<id>.mode`, with `spec.defaults.mode` as the
fallback (`shadow` when a provider is named).

| Mode | Behaviour |
|---|---|
| `off` | No call is made. The judgment abstains with `disabled`. |
| `shadow` | The call is made and logged. The caller gets `abstain` (`shadow`) and uses its existing path. Safe default. |
| `enforce` | The caller receives the outcome. Takes effect only when every condition below holds. |

### Why an `enforce` judgment runs as `shadow`

The runtime runs a judgment configured `enforce` as `shadow` instead, and records the
reason as `downgradeReason` in the log and in `list` output, when any of these holds:

| Reason | Meaning | Fix |
|---|---|---|
| `model-alias` | The model is a moving alias (an id that is, or ends after a `-`, `:` or `@` with, `latest`, `preview`, `beta`, `exp` or `nightly`, case-insensitive; for example `jev-latest`). | Pin an exact version in `spec.model`. |
| `model-mismatch` | `spec.model` differs from the model the provider uses, or the provider reports a different version than the one pinned. | Align `spec.model` with the provider and re-evaluate. |
| `uncalibrated-provider` | The provider does not return calibrated probabilities (all `openai-compatible` use). | None in v1: those judgments stay in `shadow`. |
| `no-thresholds` | No thresholds exist for the active `provider@model` key. | Add `thresholds` from an `eval` run. |
| `no-promotion` | No promotion record satisfies the judgment's risk class bar. | Follow [`judgment-promotion.md`](judgment-promotion.md). |

## Kill switch

`AI_SDLC_JUDGMENT=off` (exactly the lowercase value `off`; `OFF`, `0` or `false` do nothing) in the environment disables the layer entirely: every judgment
abstains and nothing is written. It takes precedence over any config file.

```bash
AI_SDLC_JUDGMENT=off node pipeline-cli/bin/cli-judgment.mjs doctor --config .ai-sdlc/judgment-config.yaml
```

Removing the `provider` key or the file also disables the layer, but only once the
change is on the base branch, because the runtime reads the committed copy
(`origin/main` by default); it is not a quick stop. In an emergency use the
environment variable. To leave the layer on but stop one judgment from acting, set
its mode back to `shadow`.

`AI_SDLC_JUDGMENT_CONFIG_PATH` (an operator-controlled environment variable) names a
local config file to use instead of the base-branch copy.

## Judgment log

Every evaluation appends one JSON line to
`$ARTIFACTS_DIR/_judgment/log-YYYY-MM-DD.jsonl` (UTC date; mode `0600`). When
`ARTIFACTS_DIR` is unset the runtime writes under `./artifacts`, while `cli-judgment`
reads `.ai-sdlc/artifacts` by default, so set `ARTIFACTS_DIR` or pass
`--artifacts-dir` to make them agree.

| Field | Meaning |
|---|---|
| `ts`, `judgmentId`, `version` | When, which judgment, which definition version. |
| `questionSetHash`, `stateHash` | Hashes of the questions and of the state. The state text is never written. The state hash is unsalted SHA-256: do not export the log where it could confirm a guessed state. |
| `provider`, `modelVersion` | Provider name and the model version the provider reported. |
| `configuredMode`, `effectiveMode`, `downgradeReason` | The mode you asked for, the mode that ran, and why they differ (`null` when they do not). |
| `answers` | The provider's probabilities (redacted, size-capped). |
| `thresholds` | The thresholds in force (`null` in `shadow`). |
| `outcome` | `act`, `escalate` or `abstain`, with the decision or reason. |
| `incumbent` | What the existing path decided, recorded so agreement can be computed. |
| `latencyMs`, `inputTokens`, `outputTokens` | Call size and timing. |
| `costUsd`, `cacheHit` | Cost attribution; `cacheHit` is true when the answers came from the cache. |
| `taskId`, `sourceKind` | The work item, when the caller supplied them. |

`cli-judgment replay --since <date>` recomputes outcomes from this log under other
thresholds without calling the provider:

```bash
node pipeline-cli/bin/cli-judgment.mjs replay --since 2026-10-01 --config .ai-sdlc/judgment-config.yaml
```

An optional content-addressed cache (`defaults.cache: true`) keyed on model version,
question set and state returns stored answers on a repeat evaluation. It is used only
when the model is pinned to an exact version.

## Cost attribution

Each log record carries `costUsd`: the input tokens times the provider's declared input
rate (`jev` declares USD 0.042 per million input tokens; `openai-compatible` uses
`inputCostPer1MTokens`, 0 unless you set it). A cache hit costs 0. When the
orchestrator attaches its cost sink, it also writes one `cost_ledger` row per uncached
call, with `pipelineType` `judgmentTokens`, the judgment's consumer label as the agent
name, and the model as `<provider>@<version>`. Calls that abstain before reaching the
provider cost nothing and write no row.

## Troubleshooting by abstain reason

Abstain always means "behave as before the layer existed", so none of these breaks a
pipeline. `cli-judgment ask <id> --input <file>` prints the reason when it gets no
answers.

| Abstain reason | Cause | What to do |
|---|---|---|
| `disabled` | No provider configured, the mode is `off`, `AI_SDLC_JUDGMENT=off` is set, or the provider is unavailable (not registered, key missing, `baseUrl` unset). | Run `cli-judgment doctor`. Check the key variable and `baseUrl`. |
| `egress-not-permitted` | The judgment's egress class is not in `spec.egress.allow`. | Add the class if you accept that data leaving, otherwise leave it. |
| `provider-error` | Timeout, network error, rate limit after retries, or the provider returned an answer that is missing, malformed or out of the option set. | Check connectivity, raise `timeoutMs`, or try a larger model for `openai-compatible`. |
| `state-too-large` | The state exceeds the provider's size budget. | None: the caller falls back. Raise `maxStateTokens` for `openai-compatible` if the model can take more. |
| `definition-error` | The definition is invalid or its question or compose step threw. | A framework bug: report it with the judgment id. |
| `shadow` | Not a fault: the judgment ran in `shadow` and its answer was logged. | Promote it when the evidence supports it. |

## For adopters: what leaves your machine

- **Off by default.** Nothing is sent unless `.ai-sdlc/judgment-config.yaml` names a
  provider on your base branch.
- **What is sent.** Only the state of judgments whose egress class you allow. By
  default that is `work-item-text`: the text of tasks, issues, decisions and capture
  findings. Diffs (`code-diff`) and agent output (`agent-output`) are sent only if you
  list those classes. Secrets matching the framework's secret patterns are redacted
  first.
- **To whom.** With `jev`, to the Jev API (or the host in `TYPESAFE_BASE_URL`). The
  vendor documents that it does not train on customer requests; zero data retention is
  an enterprise-plan feature, so check your plan. With `openai-compatible`, to
  whatever `baseUrl` points at.
- **A local endpoint that serves the model itself sends nothing to a third party.**
  An `openai-compatible` `baseUrl` on `localhost` keeps all data on your machine only
  if that endpoint runs the model and does not forward requests. A loopback `baseUrl`
  also bypasses `spec.egress.allow` for all classes, so a forwarding gateway (a proxy,
  a cloud-offloaded model, an SSH tunnel) would receive diffs and agent output too.
- **You decide the classes.** For a remote provider, `spec.egress.allow` is the
  control; a smaller list means fewer judgments run. It is not applied to a loopback
  `baseUrl` (see above). Version 1 does not enforce a compliance posture (RFC-0022):
  if your organisation requires one, apply it by hand, by keeping the config absent
  or restricting `allow` to match.
- **Kill switch.** `AI_SDLC_JUDGMENT=off` stops all calls immediately.
- **What stays on disk.** The judgment log holds hashes of the state, not the state,
  but it does hold the provider's answers, each outcome and the `incumbent` value the
  caller supplied (all redacted and size-capped). An `incumbent` can summarise the
  work item, so treat the log as internal.

## References

- RFC-0049, System One Judgment Layer
- [`judgment-promotion.md`](judgment-promotion.md), promotion runbook
- [`judgment-definitions.md`](judgment-definitions.md), definition safety rules
- [`doctor.md`](doctor.md), the `judgment-layer` checks
- `pipeline-cli/README.md`, the `cli-judgment` command reference
