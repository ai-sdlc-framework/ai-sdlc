# @ai-sdlc/pipeline-cli

Shared core library for the AI-SDLC pipeline. Implements **RFC-0012** —
extracts Step 0-13 logic from `ai-sdlc-plugin/agents/execute-orchestrator.md`
(now superseded by the inline `commands/execute.md` slash command body —
AISDLC-98) and `orchestrator/src/` into pure step functions exposed three ways:

1. **TypeScript library** — `import { executePipeline, ... } from '@ai-sdlc/pipeline-cli'`
2. **CLI subcommands** — `ai-sdlc-pipeline <command>` (yargs-driven, JSON on stdout)
3. **MCP tools** — Phase 3 (AISDLC-100.3) wraps each step as an MCP tool from
   the plugin's MCP server

The package is published publicly as **`@ai-sdlc/pipeline-cli`** on npm
(AISDLC-245.1 makes it publishable; the actual `runtimeDependencies`
declaration in `ai-sdlc-plugin/plugin.json` lands in AISDLC-248.1's release
PR once the first version is published, so adopters don't fail install on
an unpublished version reference).

## Why two tiers?

The pipeline ships in two tiers (RFC-0012 §2):

- **Tier 1 — slash command body.** `/ai-sdlc execute <task-id>` runs in the
  main Claude Code session. The slash command body interleaves CLI subcommands
  (`ai-sdlc-pipeline validate-task ...`, `... compute-branch ...`) with `Agent`
  tool calls for the LLM dispatch boundaries (Step 5b developer, Step 7b three
  reviewers in parallel). Subscription billing via Claude Code Max-20x.
  Operator-driven and interactive.

- **Tier 2 — `executePipeline()` composite.** A single `import` + one async
  call drives Step 0-13 end-to-end. The two LLM dispatch boundaries go through
  an injected `SubagentSpawner` (subscription via `claude --print`, API key via
  `@anthropic-ai/claude-code` SDK, or `MockSpawner` for tests). Designed for
  unattended programmatic use: CLI invocation, GitHub Actions, webhooks, cron,
  and the existing `pnpm watch` flow once Phase 5 (AISDLC-100.5) migrates
  `dogfood/src/watch.ts` to call it.

**Both tiers run the same Step 0-13 functions from this package**, so behaviour
is identical — only the LLM dispatch boundary differs. See
[`docs/spawner.md`](./docs/spawner.md) for the SubagentSpawner deep-dive and
[`docs/steps.md`](./docs/steps.md) for the per-step contract reference.

## Install

### As part of the plugin (recommended)

If you've installed `ai-sdlc-plugin` in Claude Code, `@ai-sdlc/pipeline-cli` is
pulled in automatically via the plugin's `runtimeDependencies` declaration. The
Claude Code plugin runtime installs it under the plugin's own `node_modules/`:

```
<CLAUDE_PLUGIN_ROOT>/node_modules/@ai-sdlc/pipeline-cli/
```

All 16 `bin/` entries are then resolvable as
`${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/pipeline-cli/bin/<bin>.mjs`:

```bash
ai-sdlc-pipeline.mjs            # Step 0-13 umbrella (RFC-0012)
cli-backlog-verify.mjs          # Backlog drift gate (CI)
cli-classify-budget.mjs         # AISDLC-141 classifier-budget filter
cli-classify-pr.mjs             # AISDLC-141 reviewer subset classifier
cli-deps.mjs                    # AISDLC-117 dependency-graph CLI
cli-deps-corpus.mjs             # AISDLC-167.5 deps-composition aggregator
cli-dor-corpus.mjs              # AISDLC-161 DoR calibration aggregator
cli-dor-digest.mjs              # AISDLC-162 DoR Slack digest
cli-dor-stats.mjs               # AISDLC-162 DoR analytics
cli-incremental-decide.mjs      # AISDLC-142 incremental review gate
cli-orchestrator.mjs            # RFC-0015 autonomous orchestrator
cli-orchestrator-corpus.mjs     # AISDLC-178.7 orchestrator soak aggregator
cli-pr-unstick.mjs              # PR queue rescue helper
cli-task-complete.mjs           # AISDLC-203 atomic task lifecycle
cli-tui.mjs                     # RFC-0023 operator TUI
cli-tui-corpus.mjs              # AISDLC-178.7 TUI soak aggregator
```

AISDLC-245.4 will update the slash command bodies to use this resolution path
so adopters don't need the full monorepo checked out.

### As a workspace dependency (monorepo / dogfood)

The package lives at `pipeline-cli/` in the `ai-sdlc-framework/ai-sdlc` monorepo:

```bash
git clone https://github.com/ai-sdlc-framework/ai-sdlc.git
cd ai-sdlc
pnpm install
pnpm --filter @ai-sdlc/pipeline-cli build
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs --help
```

Add it to a sibling workspace package's `package.json`:

```jsonc
{
  "dependencies": {
    "@ai-sdlc/pipeline-cli": "workspace:*"
  }
}
```

### Invoking from CI / GitHub Actions (AISDLC-156)

**Always invoke pipeline-cli CLIs via `node ./pipeline-cli/bin/<bin>.mjs`,
never via `pnpm --filter @ai-sdlc/pipeline-cli exec <bin>`.**

`pnpm exec` resolves binaries via the package's `node_modules/.bin/`
symlink directory, but a workspace package's OWN `bin` entries are NOT
symlinked into its own `node_modules/.bin/` — only its DEPENDENCIES'
bins are. Invoking via `pnpm exec` from the workspace itself therefore
returns:

```
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "cli-classify-budget" not found
```

…on every invocation. In the AISDLC-156 incident, this silent failure
caused the `|| echo '<fallback-json>'` safety net in
`.github/workflows/ai-sdlc-review.yml` to fire on every PR for the three
cost-saver CLIs (`cli-classify-pr`, `cli-incremental-decide`,
`cli-classify-budget`), defeating the AISDLC-141/142/147/149/154
optimizations entirely — every PR ran full-budget reviewers, blowing
through Anthropic credits and posting `CHANGES_REQUESTED` whenever the
key was exhausted.

The workflow now invokes each CLI as:

```yaml
RESULT=$(node pipeline-cli/bin/cli-classify-pr.mjs classify --paths-file ... \
  || echo '{"reviewers":["testing","critic","security"],"fellOpen":true,...}')
```

`pipeline-cli/src/cli/bin-invocation.test.ts` is the regression guard:
it spawns each `bin/cli-*.mjs` via `node` and asserts `--help` exits 0,
AND asserts that the broken `pnpm --filter ... exec` form still fails
(so a future operator who reverts the workflow trips a loud test
failure instead of re-introducing the silent regression). When pnpm
eventually fixes own-bin resolution — or we move to a different package
manager — that test will fail and force a deliberate re-evaluation of
whether the simpler form can be reintroduced.

### From npm (standalone / non-plugin usage)

`@ai-sdlc/pipeline-cli` is published publicly on npmjs.org (AISDLC-245.1):

```bash
pnpm add @ai-sdlc/pipeline-cli
# Optional: only when using the API-key-billed ClaudeCodeSDKSpawner.
pnpm add @anthropic-ai/claude-code
```

The `@anthropic-ai/claude-code` SDK is a **lazy import** (NOT a hard
dependency) so subscription-only consumers don't pay for ~50MB of SDK code
they'll never use. See [`docs/spawner.md`](./docs/spawner.md#the-lazy-sdk-import--why-and-how)
for the lazy-import rationale and how the failure surfaces when the SDK isn't
installed.

## Choosing an entry point — `execute` (CLI), `/ai-sdlc execute` (slash), `pnpm dogfood watch` (API key)

The Step 0-13 pipeline can be invoked three ways. They differ on **who** can
call them, **what** drives the LLM dispatch, and **how** the work is billed.
Pick the row that matches your situation:

| Entry point | Invoker | Spawner | Billing | When to use |
|---|---|---|---|---|
| `/ai-sdlc execute <task-id>` (slash command body, `ai-sdlc-plugin/commands/execute.md`) | Operator typing in their Claude Code session | `Agent` tool calls in the SAME session | Subscription (Claude Code Max) | The default for internal dogfood. Operator drives, sees progress in real-time, decisions surface inline. |
| `ai-sdlc-pipeline execute <task-id>` (this CLI subcommand, AISDLC-182) | Anything that can shell out — AI assistant in operator session, cron, webhook, GitHub Action | Safe default plan with `mock`; real runs require `--run --spawner api-key` until `claude-cli` ships | Depends on `--spawner` | A bare invocation is non-mutating: it validates the task and prints the planned branch/worktree without calling `executePipeline()`. An AI assistant working alongside the operator (or any non-slash-command context) that needs the FULL pipeline including reviewers + verdict-file write must pass explicit run intent and a real spawner: `--run --spawner api-key`. `--spawner mock` is dry-run/plumbing only and refuses with `--run`. **Wires AISDLC-177 rollback** on every real-run outcome in the orchestrator's `ROLLBACK_OUTCOMES` set — `developer-failed`, `developer-json-contract-violated`, `aborted`, `unknown-failure` (the constant is imported from `orchestrator/loop.ts` so both surfaces stay in lockstep, AISDLC-191) — the slash command body does NOT yet wire rollback, so the umbrella is the consistency-over-parity win when an unattended dispatch fails mid-flight. |
| `pnpm --filter @ai-sdlc/dogfood watch --issue <id>` | Cron / GitHub Action / unattended | `ClaudeCodeSDKSpawner` (resolved internally) | API key (paid Anthropic API) | GitHub-issue-driven flow. Designed for unattended use where no operator session is available. |

### Why the `execute` umbrella subcommand exists (AISDLC-182)

Before this subcommand existed, an AI assistant working alongside the
operator (e.g. Claude in the main conversation, NOT a slash command) had no
clean way to invoke the full pipeline. The two existing surfaces both had
gaps:

- **`/ai-sdlc execute`** is a slash command body. Only the operator can
  type slash commands; an assistant cannot invoke them.
- **`pnpm dogfood watch`** is API-key-billed. Acceptable for the
  GitHub-issue path; not appropriate for backlog-task internal dogfood per
  the dual-workflow architecture (subscription billing).

The per-step subcommands (`validate-task`, `compute-branch`, …) were
exposed but **no umbrella composed them into the Step 0-13 sequence**. The
2026-05-04 dogfood incident — ~10 PRs shipped to main without reviewer
verdicts because the assistant skipped Steps 7 (reviewers), 8 (aggregate),
and 10 (verdict-file write that triggers DSSE auto-sign in the pre-push
hook) — happened precisely because manually composing those steps was
error-prone.

The `execute` subcommand is a **thin wrapper** around the existing
`executePipeline()` library function. It does NOT re-implement Step 0-13;
it composes them via the same in-package composite. The wrapper's only
real responsibilities:

1. Resolve a `SubagentSpawner` from the `--spawner` flag.
2. Hook into `onProgress` so the per-iteration aggregated verdict lands
   at `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` — the husky
   pre-push hook (`scripts/check-attestation-sign.sh`) reads from this
   exact path to auto-sign the DSSE envelope.
3. Emit `[ai-sdlc-progress] execute: <stage>` lines so the dispatching
   session can surface progress.

```bash
# Safe default / plumbing check — validates and prints the planned branch/worktree.
# Does not call executePipeline(), create worktrees, flip task status, or push.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-182

# Equivalent explicit dry-run form.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-182 --dry-run

# Real run with API-key billing (requires ANTHROPIC_API_KEY in env)
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-182 --run --spawner api-key

# Mock spawner (default) is dry-run/plumbing only. This plans safely:
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-182 --spawner mock

# This refuses before validation/worktree setup because mock cannot do real work:
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-182 --run --spawner mock
```

#### `--spawner` options

| Value | Status | Behaviour |
|---|---|---|
| `mock` | shipped (default) | Dry-run/plumbing only. A no-`--run` invocation validates and prints the plan without resolving the spawner or mutating files. `--run --spawner mock` refuses before filesystem mutation. |
| `api-key` | shipped | Constructs the `ClaudeCodeSDKSpawner` (lazy SDK import). Requires `ANTHROPIC_API_KEY` in env and explicit `--run`. Same billing model as `pnpm dogfood watch`. |
| `claude-cli` | shipped (AISDLC-198) | Constructs the `ClaudeCliInlineSpawner` (Option 3 inline-orchestrator pattern). Writes a dispatch manifest to `$ARTIFACTS_DIR/_orchestrator/dispatch-manifest.json`; the calling slash command body reads the manifest and invokes the `Agent` tool. Subscription-billed via the operator's session. Design: `docs/operations/claude-cli-spawner.md`. |
| `codex` | shipped (AISDLC-202.2) | Constructs the `CodexHarnessAdapter` (callback-driven Codex `spawn_agent` bridge). The CLI resolver wires a subprocess bridge whose path is read from `CODEX_SPAWN_AGENT_BIN`; when that env var is unset the resolver fails with a configuration message before any pipeline mutation. Programmatic callers can construct `CodexHarnessAdapter` directly with their own `CodexSpawnAgentFn`. Design map: `docs/operations/codex-execution-path.md`. |

##### `--spawner codex` — Codex CLI host-bridge dispatch (AISDLC-202.2 + AISDLC-251)

Phase 2 of the Codex execution path ships the `CodexHarnessAdapter`, a
host-agnostic `SubagentSpawner` over Codex's `spawn_agent` host tool.
Codex CLI does not expose Claude Code's plugin `Agent` system, so the
adapter centralises the developer + reviewer dispatch contract that the
AISDLC-201 run had to reconstruct by hand:

- Per-`SubagentType` system prompts derived from
  `ai-sdlc-plugin/agents/<type>.md` (overridable via constructor option).
- A single injected `spawnAgent` callback that wraps the operator's host
  bridge — no Codex CLI version coupling lives in `pipeline-cli`.
- Reviewer envelopes returned by the adapter pass through Step 8
  aggregation **without manual reshaping** (`coerceReviewerVerdict`
  consumes them directly; verdicts are tagged `harness: 'codex'`).

**Canonical bridge script (AISDLC-251):** The repo ships a ready-to-use bridge
at `scripts/codex-spawn-agent-bridge.mjs`. Set `CODEX_SPAWN_AGENT_BIN` to this
script — no hand-written bridge needed:

```bash
# Canonical setup — set CODEX_SPAWN_AGENT_BIN to the canonical bridge script,
# then run ai-sdlc-pipeline execute with --spawner codex.
export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-NNN --run --spawner codex
```

The canonical bridge uses the verified flag set for codex-cli 0.128.0:
`codex exec -s read-only --skip-git-repo-check --color never`.
DO NOT use `--quiet` (errors with "unexpected argument") or `--model o4-mini`
(HTTP 400 on ChatGPT-account auth) — see AISDLC-249/247 smoke test notes.

Two ways to use it:

```bash
# CLI form — requires CODEX_SPAWN_AGENT_BIN (use canonical bridge above or your own).
export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-202 --run --spawner codex
```

```typescript
// Programmatic form — inject any CodexSpawnAgentFn (host-tool wrapper,
// in-process bridge, etc.). Tests use a deterministic mock.
import { CodexHarnessAdapter } from '@ai-sdlc/pipeline-cli';

const adapter = new CodexHarnessAdapter({
  spawnAgent: async ({ agentType, systemPrompt, userPrompt, cwd, timeoutMs }) => {
    // Wrap Codex's spawn_agent host tool here.
    return { output: '<agent JSON return>', parsed: { /* optional pre-parse */ } };
  },
});
```

Bridge JSON-line protocol (the wire format `subprocessCodexSpawnAgent`
produces / consumes):

| Direction | Stream | Shape |
|---|---|---|
| Adapter → bridge | `stdin` (single JSON line) | `{ agentType, systemPrompt, userPrompt, cwd, timeoutMs }` |
| Bridge → adapter | `stdout` (single JSON envelope) | `{ output: string, parsed?: unknown }` |
| Bridge → adapter | exit code | `0` for success; non-zero surfaces `stderr` as the error |

The adapter normalises reviewer responses into the canonical
`ReviewerVerdict` envelope (`{ approved, findings, summary, harness:
'codex' }`) before returning, so Step 8 aggregation runs unchanged.

## Quickstart — Tier 1 (slash command body)

The `/ai-sdlc execute` slash command body (in `ai-sdlc-plugin/commands/execute.md`)
calls the CLI directly. To rebuild a fragment of that flow by hand:

```bash
# Always passes JSON on stdout.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs --help

# Step 0 — sweep merged worktrees.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs sweep-worktrees

# Step 1 — validate the task is ready to execute.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs validate-task AISDLC-100.7

# Step 2 — compute the branch name + worktree path.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs compute-branch AISDLC-100.7

# Step 3 — create the worktree.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs setup-worktree AISDLC-100.7

# Step 4 — flip status + write .active-task sentinel.
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs begin-task AISDLC-100.7

# Step 5 — render the developer subagent prompt (caller dispatches separately).
node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs build-dev-prompt AISDLC-100.7
```

Tier 1's distinctive trait is that the LLM dispatch boundaries (Step 5b — spawn
developer, Step 7b — spawn 3 reviewers) are NOT calls into pipeline-cli — they
are direct `Agent(developer, code-reviewer, test-reviewer, security-reviewer)`
tool calls in the main Claude Code session. The slash command body parses the
JSON each pipeline-cli subcommand emits and feeds the next step.

## Quickstart — Tier 2 (`executePipeline()`)

For unattended use — webhooks, cron, GitHub Actions, custom dashboards —
import the composite and pass a spawner:

```ts
import { executePipeline, defaultSpawner } from '@ai-sdlc/pipeline-cli';

const spawner = await defaultSpawner();
//   ↳ resolves to ShellClaudePSpawner if `claude` CLI is on PATH
//     (subscription, no tokens spent), otherwise to ClaudeCodeSDKSpawner
//     if ANTHROPIC_API_KEY is set (API key billing), otherwise throws.

const result = await executePipeline({
  taskId: 'AISDLC-100.7',
  workDir: process.cwd(),
  spawner,
  // optional: cap on TOTAL review iterations (default 2 — initial + 1 retry)
  maxReviewIterations: 2,
  // optional: progress callback per iteration
  onProgress: (iteration, verdict) => {
    console.log(`iteration ${iteration}: ${verdict.decision}`);
  },
});

console.log(result.outcome);
//   ↳ 'approved' | 'needs-human-attention' | 'developer-failed' | 'aborted'
console.log(result.prUrl);          // string | null
console.log(result.siblingPrUrls);  // string[]
```

This **is** the canonical Tier 2 pattern. Phase 5 (AISDLC-100.5) migrates the
existing `dogfood/src/watch.ts` to call `executePipeline()` directly instead of
re-implementing the orchestration in TypeScript prose. New unattended consumers
(webhooks, cron, GitHub Actions) should follow the same shape: build a
`SubagentSpawner` once, then `await executePipeline({ taskId, workDir, spawner })`
per task.

For tests, swap `defaultSpawner()` for `MockSpawner`:

```ts
import { executePipeline, MockSpawner } from '@ai-sdlc/pipeline-cli';

const spawner = new MockSpawner({
  developer: {
    type: 'developer',
    output: '...',
    parsed: { /* DeveloperReturn shape */ },
    status: 'success',
    durationMs: 0,
  },
  'code-reviewer':     { /* ReviewerVerdict shape */ },
  'test-reviewer':     { /* ... */ },
  'security-reviewer': { /* ... */ },
});

const result = await executePipeline({
  taskId: 'AISDLC-EXAMPLE',
  workDir: tmpProjectRoot,
  spawner,
  skipFinalizeCommit: true, // tests usually don't have a real git repo
});
```

See [`docs/spawner.md`](./docs/spawner.md) for the full SubagentSpawner
catalogue (`ShellClaudePSpawner`, `ClaudeCodeSDKSpawner`, `defaultSpawner()`,
`MockSpawner`, custom spawner howto).

## Layout

Tests live next to the code they exercise (one `*.test.ts` per source file).
The integration test for the Tier 2 composite is colocated with `execute-pipeline.ts`.

```
pipeline-cli/
├── package.json
├── README.md                       (this file)
├── docs/
│   ├── spawner.md                  # SubagentSpawner deep-dive (when to use which, custom-spawner howto)
│   └── steps.md                    # Per-step contract / inputs / outputs / side effects
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── ai-sdlc-pipeline.mjs        # shebang wrapper around dist/cli/index.js
└── src/
    ├── index.ts + index.test.ts    # public barrel + barrel re-export coverage
    ├── types.ts + types.test.ts    # PipelineOptions, StepResult, SubagentSpawner, etc.
    ├── execute-pipeline.ts         # Tier 2 composite entry point
    ├── execute-pipeline.test.ts    # full Step 0-13 integration with MockSpawner
    ├── __test-helpers/             # FakeRunner + tmp backlog task fixture builder
    │   ├── fake-runner.ts
    │   └── make-task.ts
    ├── runtime/
    │   ├── index.ts                # barrel — exports SubagentSpawner + Runner surface
    │   ├── exec.ts                                                   # Runner abstraction over child_process.execFile
    │   ├── subagent-spawner.ts                                       # SubagentSpawner interface + MockSpawner
    │   ├── shell-claude-p-spawner.ts                                 # Tier 2 default — `claude --print --agent <type>` shell-out (subscription)
    │   ├── claude-code-sdk-spawner.ts                                # Tier 2 alternative — @anthropic-ai/claude-code SDK (API key)
    │   └── default-spawner.ts                                        # `defaultSpawner()` resolver: which→shell, env→sdk, else throw
    ├── steps/                      # each step.ts has a colocated step.test.ts
    │   ├── index.ts                # barrel
    │   ├── 00-sweep.ts             # Step 0 — sweep merged worktrees
    │   ├── 01-validate.ts          # Step 1 — validate backlog task spec
    │   ├── 02-compute-branch.ts    # Step 2 — branch name + worktree path
    │   ├── 03-setup-worktree.ts    # Step 3 — git worktree add
    │   ├── 04-flip-status.ts       # Step 4 — status flip + .active-task sentinel
    │   ├── 05-build-dev-prompt.ts  # Step 5 — developer prompt template
    │   ├── 06-parse-dev-return.ts  # Step 6 — parse + gate developer JSON
    │   ├── 07-build-review-prompts.ts # Step 7 — 3 reviewer prompts
    │   ├── 08-aggregate-verdicts.ts   # Step 8 — verdict aggregation
    │   ├── 09-iterate.ts           # Step 9 — review iteration loop
    │   ├── 10-finalize.ts          # Step 10 — Done + completed/ + attestation + chore commit
    │   ├── 11-push-and-pr.ts       # Step 11 — push + gh pr create
    │   ├── 12-sibling-prs.ts       # Step 12 — cross-repo sibling PRs
    │   └── 13-cleanup.ts           # Step 13 — sentinel cleanup
    └── cli/
        └── index.ts                # yargs subcommand router
```

## Step contracts

Every step exports a pure async function. The return shape is documented in
`src/types.ts` + the per-step JSDoc and consolidated in
[`docs/steps.md`](./docs/steps.md). The JSON returned by the CLI subcommands
matches the TypeScript return shape exactly.

| # | Step | Function | CLI command |
|---|------|----------|-------------|
| 0 | Sweep merged worktrees | `sweepMergedWorktrees` | `sweep-worktrees` |
| 1 | Validate task | `validateTask` | `validate-task <id>` |
| 2 | Compute branch | `computeBranchName` | `compute-branch <id>` |
| 3 | Setup worktree | `setupWorktree` | `setup-worktree <id>` |
| 4 | Begin task (flip status + sentinel) | `beginTask` | `begin-task <id>` |
| 5 | Build developer prompt | `buildDeveloperPrompt` | `build-dev-prompt <id>` |
| 6 | Parse developer return | `parseDeveloperReturn` | `parse-dev-return --return <json>` |
| 7 | Build review prompts | `buildReviewPrompts` | `build-review-prompts <id>` |
| 8 | Aggregate verdicts | `aggregateVerdicts` | `aggregate-verdicts --verdicts <json>` |
| 9 | Iterate review loop | `iterateReviewLoop` | (Tier 2 composite only) |
| 10 | Finalize task | `finalizeTask` | `finalize-task <id> --developer-return <json> --verdict <json>` |
| 11 | Push + open PR | `pushAndPr` | `push-and-pr <id> --developer-return <json> --verdict <json>` |
| 12 | Sibling PRs | `siblingPrs` | `sibling-prs <id> --developer-return <json> --main-pr-url <url>` |
| 13 | Cleanup sentinel | `cleanupTask` | `cleanup-task <id>` |

## SubagentSpawner contract (LLM dispatch boundary)

The pipeline is purely deterministic except for two LLM dispatch points:

- **Step 5b** — spawn the `developer` subagent with the prompt rendered in Step 5
- **Step 7b** — spawn `code-reviewer`, `test-reviewer`, `security-reviewer` in parallel

Both go through the `SubagentSpawner` interface (RFC-0012 §8). That's the only
piece of the pipeline that varies between Tier 1 (`Agent` tool from the main
session), Tier 2 subscription (`claude --print`), Tier 2 API key (Claude Code
SDK), and tests (`MockSpawner`).

```ts
interface SubagentSpawner {
  spawn(opts: SpawnOpts): Promise<SubagentResult>;
  spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]>;
}
```

Production spawners (Phase 2 — AISDLC-100.2):

- **`ShellClaudePSpawner`** (subscription billing) — shells out to the
  operator's installed `claude` CLI with
  `claude --print --output-format json --permission-mode bypassPermissions --agent <type> <prompt>`.
  No API tokens consumed; reuses the operator's logged-in Claude Code session.
  RFC §8.2's sketch said `--subagent <type>` but the actual flag is
  **`--agent <type>`** (verified empirically against the installed CLI on
  2026-04-30). See [`docs/spawner.md`](./docs/spawner.md#q5-rfc-15-resolution--agent-type-not---subagent-type)
  for the full Q5 (RFC §15) resolution.
- **`ClaudeCodeSDKSpawner`** (API-key billing) — uses `@anthropic-ai/claude-code`
  programmatically. The SDK is **lazy-imported** (NOT a hard dependency of
  `pipeline-cli`) so subscription-only consumers don't have to install ~50MB
  of SDK code they'll never use; install it with
  `pnpm add @anthropic-ai/claude-code` only when you need API-key billing.
- **`defaultSpawner()`** — convenience resolver: prefers `claude` CLI on PATH
  (subscription), falls back to `ANTHROPIC_API_KEY` (API key), throws with an
  instructional error if neither is available.

`MockSpawner` (shipped here for tests) accepts either fixed results per
subagent type or a callback per type so iteration N>1 can return different
fixtures than iteration 1.

Full deep-dive — selection guide, custom spawner howto, lazy-import mechanics,
Q5 resolution: [`docs/spawner.md`](./docs/spawner.md).

## Hard rules (NEVER violated by any step)

These come from RFC-0012 §3.1 + the AI-SDLC governance hooks:

1. **Never `gh pr merge`.** Step 11 only opens PRs.
2. **Never `git push --force` / `-f`.** Step 11 aborts cleanly on non-fast-forward.
3. **Never delete branches** (no `git branch -D` / `-d`).
4. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.** Pre-tool-use hook blocks anyway.
5. **Never run destructive git ops** (no `reset --hard`, `checkout -- .`, `restore .`).
6. **Step 13 is mandatory** — the sentinel is removed in a `finally` block from `executePipeline`.

## Testing

- **Unit tests** are colocated with the source they exercise — `src/steps/<step>.ts` ↔ `src/steps/<step>.test.ts`. Each step has happy-path + error-path coverage.
- **Integration test** lives at `src/execute-pipeline.test.ts` and runs the full Step 0-13 against `MockSpawner` + `FakeRunner` in a tmp project root.
- **Test helpers** (`FakeRunner`, `makeTmpProject`, `writeTaskFile`) live in `src/__test-helpers/` so they're picked up by Vitest's default include glob alongside the colocated `*.test.ts` files.
- **Coverage gate** is 80% lines/functions, enforced by `vitest.config.ts` and the workspace-level `scripts/check-coverage.sh`.

```bash
pnpm test                  # vitest run
pnpm test:coverage         # with v8 coverage + thresholds
pnpm test:watch            # iteration mode
```

## Documentation

- [`docs/spawner.md`](./docs/spawner.md) — SubagentSpawner selection guide
  (when to use ShellClaudeP / ClaudeCodeSDK / Mock / custom), lazy SDK import,
  Q5 resolution.
- [`docs/steps.md`](./docs/steps.md) — per-step contract, inputs, outputs,
  side effects, when each step runs.
- [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)
  — the full design.

## Phases

| Phase | Task | What changes | Status |
|---|---|---|---|
| 1 | AISDLC-100.1 | Create `pipeline-cli/` — Step 0-13 pure functions + CLI router + `executePipeline()` composite | shipped |
| 2 | AISDLC-100.2 | `ShellClaudePSpawner` + `ClaudeCodeSDKSpawner` + `defaultSpawner()` | shipped |
| 3 | AISDLC-100.3 | Wrap each step function as an MCP tool in `ai-sdlc-plugin/mcp-server/` | in flight |
| 4 | AISDLC-100.4 | Refactor `commands/execute.md` to use the CLI; delete `agents/execute-orchestrator.md` | in flight |
| 5 | AISDLC-100.5 | Migrate `dogfood/src/watch.ts` to call `executePipeline()` | in flight |
| 6 | AISDLC-100.6 | Add `pipelineVersion` to attestation envelope | shipped |
| 7 | AISDLC-100.7 | Documentation pass — README + spawner doc + per-step docs | shipped |
| 8 | AISDLC-100.8 / AISDLC-245.1 | Publish as `@ai-sdlc/pipeline-cli` to npm; `ai-sdlc-plugin` declares it as `runtimeDependencies` | shipped |

See [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)
for the full design.
