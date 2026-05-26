# GitHub Copilot CLI Execution Path

**Status:** Design (Phase 1 of AISDLC-429). This document is paper-only —
no adapter code, no `SpawnerKind` extension, no operator runbook entry
ships in this PR. Phase 2 (AISDLC-429.2) will land
`CopilotHarnessAdapter` + `--spawner copilot` resolver; Phase 3
(AISDLC-429.3) will land orchestrator wiring + `pipeline-cli/README.md`
table row + `docs/operations/copilot-spawner.md` runbook.

**Applies to:** RFC-0012 Step 0-13 execution via GitHub Copilot CLI — the
**standalone `copilot` CLI** (GitHub Copilot CLI, GA 2025), NOT the
`gh copilot suggest` / `gh copilot explain` subcommands of `gh`. Those
are autocomplete helpers, not coding-agent dispatchers, and are out of
scope for this design.

**Companion to:** [`docs/operations/codex-execution-path.md`](./codex-execution-path.md) —
the architectural template (AISDLC-202.1) that this design mirrors. Read
that first if you want context on why every Step 0-13 box is a "shared
deterministic primitive" except the LLM-boundary boxes 5b and 7b.

## Positioning

RFC-0012 defines two execution tiers; Copilot CLI maps the same way
Codex CLI does:

| Tier | Claude Code path | Copilot CLI status |
|---|---|---|
| Tier 1 attended | `/ai-sdlc execute <task-id>` runs in the main Claude Code session and dispatches plugin agents with `Agent(developer, code-reviewer, test-reviewer, security-reviewer)`. | Copilot CLI can be the attended driver from a terminal session, but it does not expose Claude Code's plugin `Agent` tool. The operator-driven attended path needs either (a) a documented "run reviewer prompts one-at-a-time by hand" procedure or (b) the Phase 2 `CopilotHarnessAdapter` available as a programmatic dispatcher invoked from outside the Copilot session. |
| Tier 2 unattended | `executePipeline()` runs deterministic steps and uses an injected `SubagentSpawner` for LLM boundaries. | Once the Phase 2 `CopilotHarnessAdapter` ships, `--spawner copilot` becomes selectable from `cli-execute` / `cli-orchestrator tick`. A TypeScript spawner CAN call the `copilot` CLI because it advertises a non-interactive prompt mode (see Step 5b row below) — unlike Codex's `spawn_agent`, which is a host tool reachable only from within a Codex session. |

The Copilot path must preserve the RFC-0012 boundary: deterministic work
stays in `@ai-sdlc/pipeline-cli` and MCP tools; LLM work is the only
harness-specific part.

## Step Map

| RFC-0012 step | Claude Code Tier 1 primitive | Copilot CLI equivalent | Classification | Proposed Copilot adapter shape |
|---|---|---|---|---|
| 0. Sweep merged worktrees | Slash command Bash and shared step/MCP wrapper. | Shell command or MCP `pipeline_step_0_sweep`. | No change needed (shared deterministic primitives). | Copilot dispatch is irrelevant here — Step 0 is pure git/GitHub cleanup. The operator's environment runs the shared step. |
| 1. Validate task | Backlog MCP plus shared `validateTask`. | MCP `pipeline_step_1_validate` or `node pipeline-cli/bin/ai-sdlc-pipeline.mjs validate-task`. | No change needed (shared deterministic primitives). | Copilot should fail closed on validation errors before any worktree is created. |
| 2. Compute branch | Shared `computeBranchName` or MCP Step 2. | MCP `pipeline_step_2_compute_branch` or CLI compute branch command. | No change needed (shared deterministic primitives). | Step 2's `computeBranchSlug` already carries the AISDLC-202.2 block-scalar fix; no Copilot-specific work needed. |
| 3. Setup worktree | Shared `setupWorktree`. | MCP `pipeline_step_3_setup_worktree` or CLI setup command. | No change needed (shared deterministic primitives). | Copilot should run this only after Step 2 returns a valid branch and worktree path. |
| 4. Begin task and write sentinel | Plugin task edit plus per-worktree `.active-task`. | MCP `pipeline_step_4_begin_task` or plugin/backlog MCP plus sentinel write. | No change needed (shared deterministic primitives), with Copilot workflow constraint. | Per-worktree sentinel must live INSIDE the worktree (matches the Pattern C contract in CLAUDE.md). The Copilot CLI invocation will be cwd'd to the worktree per Step 5b below, so the sentinel resolves correctly. |
| 5. Build developer prompt | Shared `buildDeveloperPrompt`. | MCP `pipeline_step_5_build_dev_prompt` or CLI prompt builder. | No change needed (shared deterministic primitives). | The prompt should include a `harness: copilot` note only outside the task contract, not by changing the developer return schema. |
| **5b. Spawn developer** | Claude Code `Agent(developer)`. | `copilot` CLI invocation in non-interactive mode (see "Copilot CLI invocation grammar" below). | **Needs Copilot adapter.** | `CopilotHarnessAdapter.spawn({ type: 'developer', prompt, cwd, … }) -> SubagentResult`. The adapter loads the system prompt from `options.systemPrompts.developer` (defaulting to the built-in "behave like the ai-sdlc developer + return canonical JSON" string), spawns the CLI cwd'd to the worktree, and demands the same `DeveloperReturn` JSON envelope Step 6 expects. |
| 6. Parse developer return | Shared `parseDeveloperReturnWithRetry`. | Same shared parser after Copilot developer output is captured. | No change needed after adapter normalisation. | Adapter passes raw stdout + (when available) the bridge's pre-parsed JSON in a `SubagentResult`-compatible envelope so existing parser/retry code runs unmodified. `tryParseJson()` in `codex-harness.ts` already tolerates ``` ```json ... ``` ``` fenced output; the Copilot adapter MUST reuse the same lenient extraction (Copilot CLI may also emit fenced JSON despite a system prompt asking for raw). |
| 7. Build review prompts | Shared `buildReviewPrompts`. | MCP `pipeline_step_7_build_review_prompts` or CLI prompt builder. | No change needed (shared deterministic primitives). | Copilot must preserve the returned reviewer-specific prompts and harness note. |
| **7b. Spawn reviewers** | Claude Code `Agent(code-reviewer)`, `Agent(test-reviewer)`, `Agent(security-reviewer)` in parallel. | Three concurrent `copilot` CLI invocations (one per reviewer). | **Needs Copilot adapter.** | `CopilotHarnessAdapter.spawnParallel([…])` fans out via `Promise.all`. Each reviewer dispatch must return canonical `ReviewerVerdict` envelopes (`{approved, findings, summary, harness: 'copilot'}`) — see "Reviewer verdict shape" below. |
| 8. Aggregate verdicts | Shared `aggregateVerdicts`. | MCP `pipeline_step_8_aggregate_verdicts` or shared function. | No change needed after adapter normalisation. | Adapter output must be accepted directly by Step 8. Counts and approval are derived by the shared aggregator, not by Copilot prose. |
| 9. Iterate | Slash command prose loop plus shared prompt builders and aggregator. | Programmatic `executePipeline()` loop with Copilot spawner. | **Needs Copilot adapter.** | Adapter must support repeated developer + reviewer calls with feedback. Iteration count and cap stay in shared pipeline logic. The Copilot CLI is invoked fresh for each iteration (no session reuse); this matches the Codex bridge's per-call model. |
| 10. Finalize and sign | Shared `finalizeTask`, plugin `task_complete`, verdict file, signer. | Shared finalize plus Backlog MCP `task_complete` or equivalent atomic move. | No change needed (shared deterministic primitives). | Copilot finalisation must not manually copy task files. It must use the AISDLC-203 atomic helper or Backlog MCP `task_complete`, then verify the task ID exists in exactly one backlog location. Attestation signing is harness-agnostic — the signer reads the verdict file the adapter wrote during Step 8. |
| 10.5. Rebase / hash oracle where configured | Signer / hash helper. | Same signer / hash helper. | No change needed (shared deterministic primitives). | Copilot should not re-sign if the reviewed content hash changed without rerunning reviewers. The v5/v6 contentHash + Merkle-transcript logic is harness-agnostic. |
| 11. Push and open PR | Shared `pushAndPr`. | MCP `pipeline_step_11_push_and_pr` or shared function. | No change needed (shared deterministic primitives). | Copilot must never force-push (except `--force-with-lease` after rebase), merge, close PRs, or delete branches. The pre-push hook chain is harness-agnostic. |
| 12. Sibling PRs | Shared `siblingPrs`. | MCP `pipeline_step_12_sibling_prs` or shared function. | No change needed (shared deterministic primitives). | Copilot should pass through `filesChangedExternal` from the developer return. |
| 13. Cleanup sentinel | Shared `cleanupTask`. | MCP `pipeline_step_13_cleanup` or shared function. | No change needed (shared deterministic primitives). | Copilot must run cleanup in a finally-style path on success and failure. |

**Summary by classification:**

- **No change needed (shared deterministic primitives):** Steps 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 10.5, 11, 12, 13 (14 of 16 boxes).
- **Needs Copilot adapter:** Steps 5b, 7b, 9 (the LLM-boundary boxes — same set as Codex).
- **Blocked / needs upstream change in Copilot CLI:** None confirmed at the time of writing; several **open questions** below could surface a blocked classification if the CLI's actual invocation grammar diverges from the assumptions stated below. Phase 2 cannot start until those OQs are routed to the operator (see "Open questions blocking Phase 2 dispatch").

## Harness comparison callout

The Codex execution path (AISDLC-202.1) had to distinguish two adapter
options because Codex's `spawn_agent` is a *host tool* (only reachable
from inside a Codex CLI session, not callable from TypeScript). Copilot
CLI does NOT have that constraint — it ships as a standalone binary
intended to be invoked non-interactively from a parent shell or CI
script. Consequently:

- The "Host-tool adapter" row in `codex-execution-path.md`'s "Codex
  Adapter Contract" table does **NOT** have a Copilot analogue. The
  attended Copilot operator does not need a separate documented manual
  procedure analogous to the Codex one — they would simply invoke
  `--spawner copilot` from a regular shell (no Copilot CLI session
  needs to wrap the pipeline call).
- The "CLI subprocess adapter" row IS the canonical path for Copilot.
  `subprocessCopilotSpawnAgent()` is therefore the only default bridge
  Phase 2 needs to ship — there is no second-flavour bridge competing
  for primacy.

That said, the AISDLC-202.2 contract surface (`CopilotSpawnAgentFn`
callback boundary) is retained verbatim from Codex to keep the
architectural template aligned — operators who want to wrap the
`copilot` CLI in their own auth/transport (`COPILOT_SPAWN_AGENT_BIN`
env var) get the same ergonomics they have today with Codex.

## Copilot CLI invocation grammar (proposed, with open questions)

This section captures the proposed invocation grammar Phase 2's
`subprocessCopilotSpawnAgent()` bridge will use. Each detail is marked
**confirmed** (publicly documented behaviour of the standalone Copilot
CLI as of the Phase 1 writing window) or **OQ** (unverified — see "Open
questions" below).

### Binary discovery

1. **Preferred** — `$COPILOT_SPAWN_AGENT_BIN` env var pointing to the
   operator's own wrapper script (mirrors `$CODEX_SPAWN_AGENT_BIN`).
   Lets operators inject auth, transport, model-pin overrides, or a
   thin shim that translates the JSON-line wire protocol into whatever
   Copilot's actual flag surface looks like.
2. **Fallback** — `copilot` resolved on `PATH`.
3. **Throw** — neither configured: emit the operator-facing
   "configure `COPILOT_SPAWN_AGENT_BIN` or install the `copilot` CLI"
   error BEFORE any pipeline mutation (mirrors the Codex resolver's
   pre-flight pattern, AISDLC-429.2 AC #4).

### Non-interactive invocation

**Proposed grammar (subject to OQ-1 / OQ-2 / OQ-3 confirmation):**

```bash
copilot \
  --prompt-file <path-to-temp-file-containing-userPrompt> \
  --system-prompt-file <path-to-temp-file-containing-systemPrompt> \
  --cwd <worktree-path> \
  --no-interactive \
  --output-format json
```

Rationale for the proposed shape:

- **`--prompt-file` over stdin or positional args:** the developer
  prompts can be ~5-20 KB (full task spec + AC list + previous
  iteration feedback). Passing via a temp file is shell-safe (no
  quoting / argv-length-limit risk) and matches how the Codex bridge
  buffers large prompts.
- **Separate `--system-prompt-file`:** keeps the per-`SubagentType`
  role context distinct from the user prompt. The adapter writes both
  to `os.tmpdir()` and unlinks on completion.
- **`--cwd`:** every developer/reviewer dispatch needs to run inside
  the task worktree. If the CLI honours the parent shell's cwd
  instead of a flag, the bridge will simply `cd` before exec rather
  than passing the flag.
- **`--no-interactive`:** required to ensure the CLI does not block on
  TTY (subagent-wrapping gotcha — see "Subprocess wrapping gotchas"
  below).
- **`--output-format json`:** if the CLI supports a structured-output
  mode, the bridge passes it through as the `parsed` field of
  `CopilotSpawnAgentResponse`. If not, the bridge falls through to
  raw stdout and lets `tryParseJson()` (reused from Codex) extract a
  fenced or bare JSON envelope from the model's reply.

**The above is the PROPOSAL — every flag listed is contingent on
OQ-1 / OQ-2 / OQ-3 being answered before Phase 2 dispatches.** Phase 2
MUST NOT guess the flag surface; the operator's walkthrough of the
`copilot` CLI's actual help output is the prerequisite.

### Per-`SubagentType` system prompt strategy

Mirrors the Codex adapter (`DEFAULT_SYSTEM_PROMPTS` in
`pipeline-cli/src/runtime/spawners/codex-harness.ts`):

| `SubagentType` | Built-in default | Operator override channel |
|---|---|---|
| `developer` | Minimal "you are the AI-SDLC developer agent dispatched via GitHub Copilot CLI; implement the task end-to-end inside the worktree; your FINAL message MUST be the canonical `DeveloperReturn` JSON envelope". | `new CopilotHarnessAdapter({ systemPrompts: { developer: readFile('ai-sdlc-plugin/agents/developer.md') } })` — injects the full plugin agent body verbatim. |
| `code-reviewer` | "Return canonical `{approved, findings, summary, harness: 'copilot'}` JSON; severities = critical/major/minor/suggestion." | Same `systemPrompts` constructor option. |
| `test-reviewer` | Same shape as code-reviewer, scoped to test coverage / regression guards. | Same. |
| `security-reviewer` | Same shape as code-reviewer, scoped to OWASP-class vulns + secret exposure + injection. | Same. |
| `refinement-reviewer` | Same shape as code-reviewer, scoped to simplification + consistency without behaviour change. | Same. |

The built-in defaults are intentionally minimal — they reinforce role
semantics + the `harness: 'copilot'` marker the Step 8 verdict
aggregator needs for correct attribution, but they leave the
heavy-lifting (diff analysis, verification commands, commit + push
contract) to the *user prompt* that `buildDeveloperPrompt` /
`buildReviewPrompts` already construct.

This matches the Codex precedent: the pipeline-built user prompts
already carry the task spec, diff, AC list, and JSON envelope contract.
The system prompt is a thin role-reinforcement layer that operators can
swap for the full plugin-agent body when they want stricter behavioural
parity.

## Reviewer verdict shape

Identical to the Codex path. Copilot reviewer dispatch must return
canonical `ReviewerVerdict` objects before Step 8:

```json
{
  "agentId": "test-reviewer",
  "harness": "copilot",
  "approved": true,
  "findings": [],
  "summary": "No blocking findings."
}
```

Findings must use the shared severity vocabulary:

```json
{
  "severity": "major",
  "file": "pipeline-cli/src/cli/execute.test.ts",
  "line": 123,
  "message": "Regression coverage is missing for explicit real spawner planning."
}
```

If the `copilot` CLI does NOT emit structured JSON natively (see
**OQ-3**), the adapter's only lever is the **prompt-side instruction**:
the system prompts above explicitly demand the canonical envelope as
the FINAL assistant message, and `normalizeReviewerVerdict()` (reused
verbatim from `codex-harness.ts`) coerces whatever object-shaped
response comes back into the canonical shape (defaulting
`approved=false`, `findings=[]`, `harness='copilot'` when fields are
missing). Non-object responses fall through to Step 8's "no parseable
verdict" branch, which surfaces a critical finding rather than silently
treating the dispatch as approved.

## Subprocess-wrapping gotchas

The default `subprocessCopilotSpawnAgent()` must handle the same
substrate concerns the Codex bridge handles, plus a Copilot-specific
TTY consideration:

1. **TTY requirement.** GitHub Copilot CLI's interactive mode draws a
   TUI; if it's not explicitly disabled it can block on `isatty(stdin)`.
   The bridge MUST pass an explicit non-interactive flag (proposed:
   `--no-interactive`, OQ-2) AND spawn with `stdio: ['pipe', 'pipe',
   'pipe']` (not `'inherit'`) so the child does not inherit the
   operator's terminal. **OQ-2** covers the exact flag name.
2. **`PATH` + auth env-var passthrough.** Copilot CLI authenticates
   against the operator's GitHub Copilot subscription via a token
   stored by `gh auth login` (or the CLI's own `copilot auth login`
   step — **OQ-5**). The bridge passes the parent process's `env`
   through unmodified so whichever auth path the operator's machine
   uses works. Tests inject a mock so no real auth is required.
3. **Streaming stdout + stderr.** Use `child_process.spawn` (not
   `execFile`) so large transcripts don't buffer in memory. Same
   pattern as `subprocessCodexSpawnAgent()`. The `output` field on
   `CopilotSpawnAgentResponse` accumulates the full transcript;
   `parsed` is set when the bridge extracts a JSON envelope.
4. **Per-call timeout.** Honour `request.timeoutMs` — default 30
   minutes (matches `ShellClaudePSpawner` + `CodexHarnessAdapter`).
   `SIGTERM` on timeout, surface as `error` on the `SubagentResult`.
5. **Temp-file cleanup.** If the proposed `--prompt-file` /
   `--system-prompt-file` grammar is correct (OQ-1), the bridge MUST
   `unlink()` both files on EXIT/INT/TERM. Mirror the
   `$TMPDIR/aisdlc-393-spec-<n>-$$.json` cleanup pattern from the
   AISDLC-393 `dispatch-from-issue.ts` round-2 fix.
6. **`AI_SDLC_*` env-var passthrough.** The pipeline expects
   `AI_SDLC_ACTIVE_TASK_ID` to be set inside the worktree so the
   plugin MCP server's Pattern C router resolves the correct project
   root. The bridge must NOT strip these env vars when spawning
   Copilot.
7. **Non-zero exit handling.** A non-zero exit code from `copilot`
   maps to a `SubagentResult` with `status: 'error'` and the trimmed
   stderr in the `error` field — same shape Codex uses. Step 6's
   retry loop (`parseDeveloperReturnWithRetry`) consumes that
   directly.

## Auth / billing constraints

**Confirmed:** GitHub Copilot CLI bills against the operator's GitHub
Copilot subscription. The standalone `copilot` CLI requires (at
minimum) GitHub Copilot Pro+ / Business / Enterprise tier; the older
Copilot Individual tier MAY not be entitled to the standalone coding
agent — **OQ-4** covers the exact tier matrix.

**Implication for the Phase 2 resolver:** `resolveSpawner('copilot')`
MUST refuse-loud when neither `$COPILOT_SPAWN_AGENT_BIN` is set nor
`copilot` is resolvable on PATH — DO NOT silently fall back to
`ANTHROPIC_API_KEY` / paid API tokens (mirrors the AISDLC-393
"billing safety" pattern that refuses dispatch when `claude` is
missing on the GH-issue path). The error message must name BOTH the
env var AND the install hint.

**Implication for the operator runbook (Phase 3):** the `docs/operations/copilot-spawner.md`
runbook must document:

- Which Copilot subscription tiers are entitled (pending OQ-4).
- How `gh auth login` vs. `copilot auth login` interacts (OQ-5).
- That `--spawner copilot` consumes Copilot subscription quota, not
  Claude Code Max or `ANTHROPIC_API_KEY` budget.
- That CI use of `--spawner copilot` requires a Copilot-entitled
  token in the runner's env (separate from `GITHUB_TOKEN`).

## Tier 1 deviation from Claude Code `Agent` dispatch

The Tier 1 attended path is meaningfully different from Claude Code:

- **Claude Code Tier 1:** the operator runs `/ai-sdlc execute` inside a
  Claude Code session. The session itself drives Step 0-13; subagents
  dispatch via the plugin `Agent` tool; verdicts are emitted as JSON
  in the subagent's final assistant message and consumed back in the
  parent session's slash-command-body context.
- **Copilot Tier 1 (this design):** the operator's primary terminal is
  NOT a Copilot CLI session. Step 0-13 are driven by `cli-execute`
  (or `cli-orchestrator tick`) shelling out to `copilot` *per
  dispatch* — every developer + reviewer call is a fresh `copilot`
  invocation. There is no long-lived Copilot session that wraps the
  pipeline. This is closer to how `--spawner claude` (`claude -p`)
  works than how Claude Code Tier 1 works.

This is a deliberate choice, not a limitation: it keeps the Copilot
adapter symmetric with `ShellClaudePSpawner` and `CodexHarnessAdapter`
(both per-call shell-outs), and it sidesteps the "how does an LLM-driven
slash-command body call back into another LLM" recursion problem that
`/ai-sdlc execute` solves via the plugin `Agent` tool but `copilot`
does not currently expose.

A future task (out of scope for AISDLC-429) could explore a "Copilot
Workspace as long-lived session" model where the operator drives the
pipeline from inside a Copilot session, dispatching to itself for
sub-tasks. That would be a Tier 1 attended analogue of Claude Code's
slash-command body. Phase 1 / Phase 2 / Phase 3 do not block on it.

## Open questions blocking Phase 2 dispatch

Per CLAUDE.md "Subagent Governance — OQ-resolution prohibition
(AISDLC-298)", these questions are surfaced for operator routing
through the [Decision Catalog (RFC-0035)](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md).
**This document does NOT resolve them; Phase 2 cannot start until they
are answered by the operator.**

### OQ-1 — Prompt-passing mechanism

Does the standalone `copilot` CLI accept a system prompt and user
prompt via:

- **(a)** Separate `--system-prompt` / `--prompt` flags? *(matches
  this design's proposed grammar)*
- **(b)** A single prompt where the system prompt is concatenated
  with a delimiter (e.g. `<SYSTEM>...</SYSTEM>\n<USER>...</USER>`)?
- **(c)** Stdin with a JSON envelope (e.g. `{ system, user }`)?
- **(d)** Only positional argv (no system-prompt distinction)?

**Why it matters:** the bridge wire protocol's stability depends on
this. If the CLI only accepts a single concatenated prompt (option b
or d), the adapter's per-`SubagentType` system-prompt strategy still
works — but the bridge has to do the concatenation, and operator-injected
plugin-agent bodies become harder to debug (the system/user boundary
gets blurred in the transcript).

**Recommended escalation route:** operator runs `copilot --help` and
`copilot prompt --help` (or equivalent) on a Copilot-entitled machine
and pastes the relevant subcommands into the AISDLC-429.2 ticket.

### OQ-2 — Non-interactive mode flag

Does the CLI gate non-interactive mode behind:

- **(a)** `--no-interactive` (proposed)?
- **(b)** `--non-interactive`?
- **(c)** Auto-detection from `!isatty(stdin)` (no flag required)?
- **(d)** A different mechanism entirely (e.g. `COPILOT_NO_TTY=1`
  env var)?

**Why it matters:** if the flag name is wrong the dispatch hangs
forever in a CI / cron context (where stdin is non-TTY but the CLI
might still try to spin up its TUI). The pre-push hook chain
serialises at Step 11, so a hung dispatch wastes the operator's
30-minute timeout window before surfacing.

**Recommended escalation route:** same as OQ-1 — operator's `copilot
--help` output is the answer.

### OQ-3 — Structured-output mode

Does the CLI emit:

- **(a)** Structured JSON natively when `--output-format json` (or
  similar) is passed?
- **(b)** Only free-form text (Markdown + code fences typical)?
- **(c)** A mix — e.g. JSON for some operations, text for others?

**Why it matters:** if (a), the bridge can populate
`CopilotSpawnAgentResponse.parsed` directly and skip the lenient
`tryParseJson` step. If (b) or (c), the bridge falls through to raw
stdout and the adapter relies entirely on the prompt-side instruction
("your FINAL message MUST be a single JSON object…") plus
`tryParseJson`'s fenced-extraction tolerance.

This decision affects reviewer-verdict reliability the most — if
reviewers emit prose instead of JSON, Step 8's aggregation either
loses the verdict (treated as a critical finding by
`coerceReviewerVerdict`) or has to be tightened via a stricter system
prompt + retry path.

**Recommended escalation route:** operator runs a smoke dispatch of
the proposed grammar on a real Copilot-entitled machine and captures
the raw stdout for a developer-class prompt + a reviewer-class
prompt. Same procedure AISDLC-247 used for the Codex cross-harness
review pilot.

### OQ-4 — Subscription tier matrix

Which Copilot subscription tiers entitle the standalone `copilot` CLI?

- **(a)** Pro+ / Business / Enterprise only?
- **(b)** Pro+ only?
- **(c)** All paid Copilot tiers including Individual?
- **(d)** Currently in beta / public preview with a separate
  entitlement gate?

**Why it matters:** the operator runbook (Phase 3) must state the
required tier upfront. AI-SDLC's positioning targets enterprise +
indie operators alike — if `--spawner copilot` is locked to
Business/Enterprise, that meaningfully narrows the audience and we
should adjust the README's "supported harnesses" table accordingly.

**Recommended escalation route:** GitHub's published Copilot
documentation + the standalone CLI's own release notes. Operator
links the canonical source into the AISDLC-429.3 ticket.

### OQ-5 — Auth flow

Does the standalone `copilot` CLI authenticate via:

- **(a)** `gh auth login` (reuses the `gh` CLI's token)?
- **(b)** Its own `copilot auth login` flow with a separately
  persisted token?
- **(c)** Both, with one fallback to the other?
- **(d)** Environment variable (e.g. `GITHUB_TOKEN` or
  `COPILOT_TOKEN`)?

**Why it matters:** Phase 3's runbook needs to give operators the
right install + login command list. In CI contexts, the bridge needs
the right env-var to set (the runner does not have an interactive
login flow available).

**Recommended escalation route:** operator's first dispatch attempt
on a fresh machine documents the actual auth handshake.

### OQ-6 — Concurrent dispatch safety

Does invoking `copilot` three times concurrently from the same
machine (the Step 7b reviewer fan-out via `Promise.all`):

- **(a)** Work correctly with three independent sessions?
- **(b)** Rate-limit at the CLI level (sequentialise internally)?
- **(c)** Conflict on a shared lockfile / token cache?
- **(d)** Race-condition the shared transcript directory?

**Why it matters:** if (b), (c), or (d), `CopilotHarnessAdapter.spawnParallel`
needs an internal serialisation layer (or a per-call subdir cwd) that
the Codex adapter does not need. The AISDLC-202.2 Codex precedent has
the host bridge handle this internally if it matters; the Copilot
bridge may need to handle it itself.

**Recommended escalation route:** smoke test from the AISDLC-429.2
dev — three concurrent `copilot` invocations against trivial prompts;
verify all three return independently.

### OQ-7 — Worktree cwd handling

The pipeline cwd's every dispatch into the task worktree. Does
`copilot`:

- **(a)** Honour the parent process's cwd by default?
- **(b)** Require an explicit `--cwd <path>` flag (proposed in the
  grammar above)?
- **(c)** Walk up to the nearest `.git` (which in Pattern C would be
  the parent repo, NOT the worktree)?

**Why it matters:** option (c) would break Pattern C — Copilot would
inspect the wrong tree. The bridge would need a defensive `--cwd`
flag or a pre-flight check. If the answer is (a), the bridge simply
sets `cwd` on `child_process.spawn`. If (b), the bridge passes the
flag explicitly.

**Recommended escalation route:** operator inspects `copilot --help`
+ runs a smoke dispatch with no `--cwd` flag inside a worktree to
verify behaviour.

### OQ-8 — Failure-mode parity with `parseDeveloperReturnWithRetry`

If a developer dispatch returns prose (not JSON) on first attempt,
Step 6's retry loop re-prompts the same agent up to N times for a
canonical envelope. Does the `copilot` CLI:

- **(a)** Maintain a session across re-prompts in a way that's
  reachable from a bridge subprocess?
- **(b)** Spawn a fresh session every invocation (Step 6's retry
  loses prior context)?

**Why it matters:** if (b), the retry prompt has to carry the prior
attempt's diff + reviewer feedback inline, which inflates the prompt
size. The Codex bridge currently does (b) and it works; we should
verify Copilot does not behave differently in a way that breaks the
retry loop.

**Recommended escalation route:** operator's first AISDLC-429.2
smoke dispatch with a deliberately malformed developer return.

## What ships in Phase 2 vs. what Phase 3 owns

Per the parent task (AISDLC-429) and the AISDLC-202 precedent:

| Phase 2 (AISDLC-429.2) | Phase 3 (AISDLC-429.3) |
|---|---|
| `pipeline-cli/src/runtime/spawners/copilot-harness.{ts,test.ts}` | `pipeline-cli/README.md` spawner-kinds table row |
| `SpawnerKind` extension to include `'copilot'` | `CLAUDE.md` "Spawner kinds for `cli-orchestrator tick --spawner <kind>`" list entry |
| `SPAWNER_KINDS` array update | `docs/operations/copilot-spawner.md` operator runbook (mirroring `cross-harness-review.md`'s pilot procedure section) |
| `resolveSpawner('copilot')` resolver + missing-binary pre-flight | Orchestrator umbrella flag wiring in `pipeline-cli/src/orchestrator/loop.ts` (`umbrellaSpawnerKind` / `resolveUmbrellaSpawnerKind`) |
| Hermetic tests (no real `copilot` binary required) | Cross-link from this design doc to the new runbook |
| 80%+ patch coverage gate | Cross-harness review extension (out of scope for the initial cut, per parent-task non-goal) |

Phase 2 cannot start until OQ-1, OQ-2, OQ-3, OQ-4, OQ-5, OQ-7 are
resolved by the operator. OQ-6 and OQ-8 are non-blocking — they
inform the test matrix but don't change the contract surface.

## References

- [`docs/operations/codex-execution-path.md`](./codex-execution-path.md) — the architectural template this design mirrors.
- [`docs/operations/cross-harness-review.md`](./cross-harness-review.md) — for the eventual Copilot-as-reviewer extension (out of scope here).
- [`pipeline-cli/src/runtime/spawners/codex-harness.ts`](../../pipeline-cli/src/runtime/spawners/codex-harness.ts) — the reference adapter; `CopilotHarnessAdapter` will be structurally parallel.
- [`pipeline-cli/src/cli/execute.ts`](../../pipeline-cli/src/cli/execute.ts) — `SpawnerKind`, `SPAWNER_KINDS`, `resolveSpawner()`; Phase 2 extends all three.
- [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md) — §8 `SubagentSpawner` contract.
- [`spec/rfcs/RFC-0035-decision-catalog-operator-routing.md`](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) — the routing mechanism for the open questions above.
- Parent task: `backlog/tasks/aisdlc-429 - feat-copilot-cli-spawner-for-pipeline-execute-and-orchestrator.md`.
- This phase: `backlog/completed/aisdlc-429.1 - Phase-1-document-copilot-execution-path-and-identify-gaps.md`.
