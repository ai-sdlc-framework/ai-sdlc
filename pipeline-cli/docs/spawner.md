# SubagentSpawner — selection guide and contract reference

> **RFC-0012 §8** — the `SubagentSpawner` interface is the only piece of the
> pipeline that varies between Tier 1 (slash command body), Tier 2 subscription
> (`claude --print`), Tier 2 API key (Claude Code SDK), and tests
> (`MockSpawner`). Everything else in `@ai-sdlc/pipeline-cli` is pure +
> deterministic. This doc covers when to pick which implementation, how to wire
> a custom one, and the empirical resolutions to the open questions that
> RFC-0012 §15 left for implementation.

> **Adopters / billing**: this doc is the engineer-facing reference. For the
> adopter-facing "which dispatch path costs what" guide, see
> [`docs/operations/billing-and-cost-optimization.md`](../../docs/operations/billing-and-cost-optimization.md).
> Notably, the 2026-06-15 Anthropic Agent SDK credit changes the billing
> footprint of both `ShellClaudePSpawner` (`claude -p`) and
> `ClaudeCodeSDKSpawner` (Anthropic SDK + API key) — both now draw from the
> per-plan monthly Agent SDK credit pool ($200/mo on Max-20x) BEFORE any
> API-key overflow charges fire.

## TL;DR — which spawner do I want?

| Context | Use | Bills against (post-2026-06-15) |
|---|---|---|
| **`/ai-sdlc execute` slash command body (Tier 1)** | None — slash command body uses the main session's `Agent` tool directly | Operator's interactive Claude Code quota. `executePipeline()` is NOT called from Tier 1; the slash command body interleaves CLI subcommands with `Agent` tool calls. |
| **`cli-orchestrator tick` (default, autonomous tick from cron/daemon)** | `ShellClaudePSpawner` via `--spawner claude` (AISDLC-352 default — no flag required) | Operator's monthly Agent SDK credit ($200/mo on Max-20x). **High-throughput alternative that draws zero Agent SDK credit**: use `/ai-sdlc orchestrator-tick` inside an active Claude Code session instead — the `Agent` tool call runs in the interactive quota. See [`docs/operations/billing-and-cost-optimization.md §1b`](../../docs/operations/billing-and-cost-optimization.md) for the trade-offs and cost-projection table. |
| **RFC-0041 `in-session-agent` Workers** | N operator-opened CC sessions each running `/ai-sdlc dispatch-worker` — claims manifests from the Dispatch Board, dispatches via foreground `Agent` calls | Subscription interactive quota — **zero incremental cost**. Recommended default for autonomous drain. |
| **RFC-0041 `claude-p-shell` Workers** | `cli-dispatch-supervisor` spawns `env -u CLAUDECODE claude -p` — operator-controlled 30 min watchdog | Agent SDK credit pool ($200/mo on Max-20x) then API tokens. For headless/CI contexts. |
| **`cli-orchestrator start` (autonomous loop)** | `ShellClaudePSpawner` via the `claude` default spawner (AISDLC-352) | Operator's monthly Agent SDK credit ($200/mo on Max-20x). `claude -p` is explicitly covered by the new SDK credit pool. |
| **`pnpm --filter @ai-sdlc/dogfood watch` (Tier 2, subscription)** | `defaultSpawner()` → `ShellClaudePSpawner` | Same — Agent SDK credit pool. |
| **CI runner / webhook server / Forge tenant (Tier 2, SDK + API key)** | `defaultSpawner()` → resolves to `ClaudeCodeSDKSpawner` when `ANTHROPIC_API_KEY` is set | If the API key authenticates against a paid Claude subscription: Agent SDK credit pool first, then API-key overflow. Pure API key (no subscription): pay-as-you-go directly. Also: install `@anthropic-ai/claude-code` (lazy peer — see below). |
| **Custom auth, tenant routing, alt SDK shape** | Implement your own `SubagentSpawner` (see [Custom spawner howto](#custom-spawner-howto)) | Whatever your spawner authenticates against. |
| **Unit / integration tests** | `MockSpawner` from `@ai-sdlc/pipeline-cli` | Free — no LLM calls. |

### `--spawner claude` — the subscription-billing path

**`--spawner claude`** (AISDLC-349) shells out to `claude -p` via `child_process.spawn`. **This is the default for `cli-orchestrator tick` since AISDLC-352.** Use this for cron / daemon / sidecar dispatch from a plain shell where there is no slash command body. Uses the operator's logged-in subscription auth. Honors the per-role model split (`developer`/`code-reviewer`/`test-reviewer` → `claude-sonnet-4-6`; `security-reviewer` → `claude-opus-4-6`).

The legacy **`--spawner claude-cli`** inline-manifest spawner was removed in RFC-0041 Phase 3.3 (AISDLC-377.6). See [`docs/operations/claude-cli-spawner-removed.md`](../../docs/operations/claude-cli-spawner-removed.md) for the migration breadcrumb.

When in doubt, call `defaultSpawner()` — it picks the right one for your
environment and throws a clear instructional error if neither subscription nor
API-key billing is available.

## The contract

```ts
export interface SubagentSpawner {
  spawn(opts: SpawnOpts): Promise<SubagentResult>;
  spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]>;
}

export interface SpawnOpts {
  type: 'developer' | 'code-reviewer' | 'test-reviewer' | 'security-reviewer';
  prompt: string;
  cwd: string;
  /** Per-spawn timeout in ms. Defaults to 30 minutes if the spawner respects it. */
  timeout?: number;
}

export interface SubagentResult {
  type: SubagentType;
  /** Raw stdout/output from the subagent (may be empty on error). */
  output: string;
  /** Parsed structured payload if the subagent returned JSON. */
  parsed?: unknown;
  status: 'success' | 'timeout' | 'error';
  error?: string;
  durationMs: number;
}
```

A SubagentSpawner has exactly two responsibilities:

1. **Dispatch a single subagent** with a prompt + cwd, returning a
   `SubagentResult` whose `parsed` field carries the JSON the agent emitted
   (when parseable) and whose `output` field carries the raw stdout/stream.
2. **Dispatch N subagents in parallel** (`spawnParallel`), used at Step 7b for
   the three reviewer fan-out. Implementations are free to use real parallelism
   (`Promise.all`) or to serialise behind a queue if their backend has a
   concurrency limit.

Spawners MUST NOT throw on a subagent failure. Every error path
(timeout, network failure, SDK not installed, malformed CLI output) should
resolve with `{ status: 'error' | 'timeout', error: '<reason>', output: '...' }`
so the caller's gating logic in Step 6 (developer) and Step 8 (reviewer
aggregation) can handle it deterministically. Throwing aborts the pipeline
mid-`try/finally`, which leaves the `.active-task` sentinel in place — the
opposite of the lifecycle Step 13 cleanup is meant to enforce.

## Production spawners (Phase 2 — AISDLC-100.2)

### `ShellClaudePSpawner` — subscription billing (default)

Shells out to the operator's installed `claude` CLI (Claude Code), running one
short-lived non-interactive (`--print`) session per `spawn` call. Uses the
operator's logged-in subscription auth.

**Billing**:

- **Pre-2026-06-15**: cost lands on the operator's interactive Claude
  subscription quota (same pool that backs `/ai-sdlc execute` typed in chat).
- **Post-2026-06-15**: per the Anthropic Agent SDK credit announcement,
  `claude -p` (non-interactive) is explicitly covered by the new monthly
  Agent SDK credit ($200/mo on Max-20x). This is a SEPARATE pool from the
  interactive quota — `ShellClaudePSpawner` no longer competes with the
  operator's typing-in-chat usage. Overflow falls through to API-key
  pay-as-you-go only if explicitly enabled.

See [`docs/operations/billing-and-cost-optimization.md`](../../docs/operations/billing-and-cost-optimization.md)
for the full breakdown.

```ts
import { ShellClaudePSpawner, executePipeline } from '@ai-sdlc/pipeline-cli';

const spawner = new ShellClaudePSpawner({
  // Optional — override the binary name (default: 'claude')
  binary: 'claude',
  // Optional — per-spawn timeout in ms (default: 30 minutes)
  defaultTimeoutMs: 30 * 60 * 1000,
  // Optional — extra argv inserted BEFORE the prompt positional, e.g. model override
  extraArgs: ['--model', 'claude-opus-4-7-20260120'],
});

const result = await executePipeline({
  taskId: 'AISDLC-100.7',
  workDir: process.cwd(),
  spawner,
});
```

**Argv shape** (no shell expansion — every value passed as a separate argv entry):

```bash
claude \
  --print \
  --output-format json \
  --permission-mode bypassPermissions \
  --agent <type> \
  <prompt>
```

The prompt is the LAST positional argument so prompts containing spaces,
newlines, or quotes are passed verbatim without re-escaping.

**Output parsing** — `--output-format json` returns an envelope shaped roughly
`{ "type": "result", "result": "<text>", ... }`. The spawner records the entire
stdout as `output` and tries to extract structured JSON from `result`
(parses `result` as JSON when it looks like JSON, otherwise returns it as a
string). When parsing fails the `parsed` field stays undefined and the caller's
Step 6 logic falls back to parsing the raw `output` string.

### `ClaudeCodeSDKSpawner` — Agent SDK credit (or API-key overflow)

Uses the `@anthropic-ai/claude-code` SDK programmatically rather than shelling
out. Authenticates via an explicit `ANTHROPIC_API_KEY` (or the SDK's own
`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` env vars). Designed for
environments without subscription auth: bare CI runners, customer tenants on
their own keys, webhooks invoked from servers that aren't logged into a Claude
Code session.

**Billing**:

- **Pre-2026-06-15**: API-key pay-as-you-go for every dispatch.
- **Post-2026-06-15**: per the Anthropic Agent SDK credit announcement, SDK
  usage authenticated against a paid Claude subscription draws from the
  monthly Agent SDK credit pool FIRST ($20/Pro, $100/Max-5x, $200/Max-20x),
  with API-key overflow only firing once the credit is exhausted AND
  overflow is explicitly enabled. Operators must claim the credit one-time
  via the email Anthropic sends to eligible accounts. See
  [`docs/operations/billing-and-cost-optimization.md`](../../docs/operations/billing-and-cost-optimization.md).

```ts
import { ClaudeCodeSDKSpawner, executePipeline } from '@ai-sdlc/pipeline-cli';

const spawner = new ClaudeCodeSDKSpawner({
  apiKey: process.env.ANTHROPIC_API_KEY, // optional — defaults to env
  model: 'claude-opus-4-7-20260120',     // optional — defaults to SDK pick
  defaultTimeoutMs: 30 * 60 * 1000,      // optional — default 30 min
});

const result = await executePipeline({
  taskId: 'AISDLC-100.7',
  workDir: process.cwd(),
  spawner,
});
```

#### The lazy SDK import — why and how

`@anthropic-ai/claude-code` is **NOT a hard dependency** of
`@ai-sdlc/pipeline-cli`. Bundling it would force every Tier 1 (subscription)
consumer to install ~50MB of SDK code they will never use. Instead the SDK is
**lazy-imported** via dynamic `import()` at first `spawn()` call, which makes
it an OPTIONAL runtime requirement — only the API-key-billed path needs it on
disk.

```ts
// From pipeline-cli/src/runtime/claude-code-sdk-spawner.ts
const pkg = '@anthropic-ai/claude-code';
let sdk: SDKModule;
try {
  sdk = (await import(pkg)) as SDKModule;
} catch (err) {
  throw new Error(
    `Claude Code SDK not installed: \`${pkg}\` could not be imported. ` +
      `Install it with \`pnpm add @anthropic-ai/claude-code\` or pass a custom ` +
      `\`invoker\` to ClaudeCodeSDKSpawner. ...`
  );
}
```

The lazy import lets `defaultSpawner()` even ATTEMPT to construct
`ClaudeCodeSDKSpawner` without crashing when the SDK isn't installed; the
failure is deferred until first `spawn()` and surfaces as a clean
`{ status: 'error', error: 'Claude Code SDK not installed: ...' }` result.

To install:

```bash
pnpm add @anthropic-ai/claude-code
# OR pin a specific version
pnpm add @anthropic-ai/claude-code@^1
```

#### SDK API shape — version-tolerant dispatch

The SDK's exported entry shape varies between versions. Rather than lock to a
particular SDK release, the spawner's default dispatcher tries the documented
shapes in order:

1. **`query({ prompt, agent, cwd, ... })`** returning an async iterable — the
   SDK v1+ streaming API.
2. **`new ClaudeCode({apiKey}).runAgent({subagentType, agent, prompt, cwd})`** —
   the higher-level wrapper sketched in RFC §8.2.

Whichever shape resolves wins; the unrecognised one throws a clear
"SDK API may have shifted; pass a custom `invoker`" error. To pin to a specific
shape (or bridge a new SDK release), pass an `invoker`:

```ts
const spawner = new ClaudeCodeSDKSpawner({
  invoker: async ({ type, prompt, cwd, apiKey, model }) => {
    const sdk = await import('@anthropic-ai/claude-code');
    const client = new sdk.ClaudeCode({ apiKey, model });
    const raw = await client.runAgent({ subagentType: type, prompt, cwd });
    return { output: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  },
});
```

### `defaultSpawner()` — convenience resolver

Picks the right `SubagentSpawner` for the current environment:

```ts
import { defaultSpawner } from '@ai-sdlc/pipeline-cli';

const spawner = await defaultSpawner({
  // optional: forwarded to ShellClaudePSpawner when CLI detection wins
  shell: { defaultTimeoutMs: 60 * 60 * 1000 },
  // optional: forwarded to ClaudeCodeSDKSpawner when env detection wins
  sdk: { model: 'claude-opus-4-7-20260120' },
});
```

#### Resolution order

1. **`claude` CLI on PATH?** → `ShellClaudePSpawner` (subscription billing,
   preferred by default per RFC §2.4 — no tokens spent).
2. **`ANTHROPIC_API_KEY` in env?** → `ClaudeCodeSDKSpawner` (API-key billing
   for environments without a logged-in Claude Code session).
3. **Neither?** → throws:
   `"No Claude Code runtime available — install the 'claude' CLI ... for
   subscription billing, or set ANTHROPIC_API_KEY for API-key billing via
   @anthropic-ai/claude-code SDK."`

#### Detection mechanics

- **CLI detection** uses POSIX `which` / Windows `where` via `child_process.execFile`.
  Both are wired through an injectable `which` callback so tests can deterministically
  script "claude is on PATH" / "claude is not on PATH" without touching the real shell.
- **API key detection** is a literal `process.env.ANTHROPIC_API_KEY` truthy check.
  We deliberately do NOT pre-validate the key against the API (that would burn
  tokens just to construct a spawner) — invalid keys fail at first `spawn()`
  call with a clear SDK error.

#### Forcing a specific spawner

`defaultSpawner` resolves CLI before env. If both are present and you want the
SDK path anyway, instantiate `ClaudeCodeSDKSpawner` directly:

```ts
import { ClaudeCodeSDKSpawner } from '@ai-sdlc/pipeline-cli';
const spawner = new ClaudeCodeSDKSpawner({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Or override the detection callback to bypass the CLI probe entirely:

```ts
const spawner = await defaultSpawner({
  which: async () => false, // force fall-through to env check
});
```

## Q5 (RFC §15) resolution — `--agent <type>`, NOT `--subagent <type>`

RFC-0012 §8.2's sample code sketched a `claude --print --subagent <type>` argv.
Empirical `claude --help` (verified 2026-04-30 against the operator's installed
CLI) shows the actual flag is **`--agent <agent>`** (singular, no `sub` prefix):

```
--agent <agent>   Agent for the current session. Overrides the 'agent' setting.
```

The plugin ships its `developer`, `code-reviewer`, `test-reviewer`, and
`security-reviewer` agents under `ai-sdlc-plugin/agents/*.md`, which Claude
Code resolves by name when `--agent <name>` is passed AND the plugin is loaded
in the operator's environment. So `ShellClaudePSpawner.buildArgv()` passes
`--agent <opts.type>` and trusts that the plugin is on the operator's machine —
the same assumption Tier 1's slash command body makes.

### Other CLI quirks the spawner papers over

- **No `--cwd <path>` flag exists.** The child's working directory is set via
  `child_process.spawn`'s `options.cwd`. Same effect.
- **`--output-format json`** so the CLI emits a single JSON envelope on stdout
  instead of streaming text, making the response easier to parse than free-form
  prose.
- **`--permission-mode bypassPermissions`** so the subagent isn't prompted for
  tool grants — the spawner runs in unattended Tier 2 contexts where there is
  no human at the keyboard. The plugin's PreToolUse hook still enforces the
  worktree write-fence and the ASCII-filename / `.ai-sdlc/` / `.github/workflows/`
  blocked-path gates, so `bypassPermissions` does NOT bypass governance.

### SDK-side equivalent

The CLI's `--agent <type>` flag has a direct SDK analogue: every documented SDK
shape accepts an `agent` / `subagentType` option. The dispatcher forwards
`opts.type` so the SDK loads the right plugin agent's system prompt regardless
of which entry point shape resolves.

## `MockSpawner` — for tests

The Mock spawner ships from `@ai-sdlc/pipeline-cli` and accepts either
fixed-result fixtures per subagent type, or callbacks per type so iteration N>1
can return different fixtures than iteration 1.

```ts
import { MockSpawner, executePipeline } from '@ai-sdlc/pipeline-cli';

const spawner = new MockSpawner({
  developer: {
    type: 'developer',
    output: '{"summary":"ok","commitSha":"abc1234",...}',
    parsed: { summary: 'ok', commitSha: 'abc1234', /* ... */ },
    status: 'success',
    durationMs: 0,
  },
  'code-reviewer': (opts, callIndex) => ({
    type: 'code-reviewer',
    output: '...',
    parsed: { agentId: 'code-reviewer', harness: 'mock', approved: callIndex > 0, findings: [] },
    status: 'success',
    durationMs: 0,
  }),
  'test-reviewer':     { /* ... */ },
  'security-reviewer': { /* ... */ },
});

const result = await executePipeline({
  taskId: 'AISDLC-EXAMPLE',
  workDir: tmpProject,
  spawner,
  skipFinalizeCommit: true, // tests usually want this
});

// Test-only introspection
expect(spawner.getCallCount('developer')).toBe(2); // initial + iter 2
```

Callback fixtures receive `(opts, callIndex)`; use `callIndex` to switch
between iteration-1 and iteration-2 responses (e.g. fail review on iter 1, pass
on iter 2 to exercise Step 9's loop).

## Custom spawner howto

Any object that satisfies `SubagentSpawner` works — the interface is just two
async methods.

```ts
import type {
  SubagentSpawner,
  SpawnOpts,
  SubagentResult,
} from '@ai-sdlc/pipeline-cli';

class MyCustomSpawner implements SubagentSpawner {
  constructor(private opts: { tenantId: string; baseUrl: string }) {}

  async spawn(opts: SpawnOpts): Promise<SubagentResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.opts.baseUrl}/agents/${opts.type}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': this.opts.tenantId,
        },
        body: JSON.stringify({ prompt: opts.prompt, cwd: opts.cwd }),
        signal: AbortSignal.timeout(opts.timeout ?? 30 * 60 * 1000),
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { /* leave undefined */ }
      return {
        type: opts.type,
        output: text,
        parsed,
        status: res.ok ? 'success' : 'error',
        error: res.ok ? undefined : `HTTP ${res.status}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const isTimeout = (err as { name?: string }).name === 'TimeoutError';
      return {
        type: opts.type,
        output: '',
        status: isTimeout ? 'timeout' : 'error',
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }

  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map((o) => this.spawn(o)));
  }
}
```

### Implementation rules of thumb

1. **Never throw.** Every failure path (timeout, network, malformed payload)
   should resolve with `{ status: 'error' | 'timeout', error, output }`.
   Throwing aborts the pipeline mid-`try/finally` and leaves `.active-task`
   stale.
2. **Honour `opts.cwd`** for any tooling the subagent uses (working directory
   for git/gh, project root for file IO). The pipeline always passes the
   per-task worktree path.
3. **Honour `opts.timeout`** when the caller supplies one; pick a sane default
   (30 minutes is the convention) when they don't.
4. **Populate `parsed`** when the subagent returned JSON. Step 6 falls back to
   parsing `output` as a string when `parsed` is undefined, so omitting it is
   safe but slower.
5. **`spawnParallel` can serialise** if your backend has a concurrency limit —
   the pipeline doesn't depend on real parallelism, just on the contract that
   all N results come back in input order. (`Promise.all`, however, is the
   default for a reason: the three reviewers are read-only and dispatch
   independently, so wall-clock time wins.)

## Removed spawners

### `--spawner claude-cli` — removed in RFC-0041 Phase 3.3 (AISDLC-377.6)

The `claude-cli` inline-manifest spawner (`ClaudeCliInlineSpawner`, AISDLC-198)
was removed after a one-release deprecation window (AISDLC-377.4 shipped the
deprecation warning). Yargs `--spawner claude-cli` is rejected at parse time;
programmatic callers that bypass yargs and pass the string literal receive a
clear `CLAUDE_CLI_SPAWNER_REMOVED_MESSAGE` error pointing at the migration
breadcrumb.

**What to use instead:**

| Goal | Replacement |
|---|---|
| Subscription-quota autonomous drain | `in-session-agent` via Dispatch Board + `/ai-sdlc dispatch-worker` in N operator-opened CC sessions. Foreground `Agent` calls integrate cleanly with the operator's interactive workflow. |
| Headless/CI dispatch without active CC session | `--spawner claude` (`ShellClaudePSpawner`) — draws the operator's Agent SDK credit pool post-2026-06-15 and uses subscription auth pre-cutover. |
| Existing scripts still passing `--spawner claude-cli` | Migrate to `--spawner claude` (no behaviour difference for non-slash-command callers) or to the Dispatch Board model. See [`docs/operations/claude-cli-spawner-removed.md`](../../docs/operations/claude-cli-spawner-removed.md). |

---

## Why Tier 1 doesn't use a spawner

The `/ai-sdlc execute` slash command body runs in the main Claude Code session,
which has the `Agent` tool. It dispatches subagents directly:

```text
Use Agent(developer) with the prompt: ...
Use Agent(code-reviewer, test-reviewer, security-reviewer) in parallel: ...
```

`Agent` IS the dispatch boundary in that context — there's no separate spawner
abstraction needed. `executePipeline()` (the Tier 2 composite) is for
unattended programmatic use where the main session isn't available: CLI
invocation, GitHub Actions, webhooks, cron, and the existing `pnpm watch` flow
once Phase 5 (AISDLC-100.5) migrates `dogfood/src/watch.ts` to call it.

## See also

- `ai-sdlc-plugin/agents/{developer,code-reviewer,test-reviewer,security-reviewer}.md`
  — the agent definitions whose names the spawner passes via `--agent <type>`.
- [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)
  §8 (the SubagentSpawner abstraction), §15 Q5 (the `--agent` vs `--subagent`
  question this doc resolves empirically).
- [`pipeline-cli/docs/steps.md`](./steps.md) — per-step contracts for the
  Step 0-13 pipeline that uses these spawners at the LLM-dispatch boundaries
  (Step 5b and Step 7b).
- [`pipeline-cli/README.md`](../README.md) — package overview, install
  instructions, Tier 1 + Tier 2 quickstarts.
