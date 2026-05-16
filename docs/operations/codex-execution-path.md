# Codex CLI Execution Path

**Status:** Operational. AISDLC-202.1 (design map), AISDLC-202.2
(`CodexHarnessAdapter` + `--spawner codex`), AISDLC-202.3 (attestation harness
context), AISDLC-247 (Codex reviewer agents), and AISDLC-202.4 (pilot
validation) have all shipped. Codex CLI is now a supported harness option for
cross-harness review. For the full operator-facing procedure, see
[`docs/operations/cross-harness-review.md`](./cross-harness-review.md).

**Applies to:** RFC-0012 Step 0-13 execution from Codex CLI.

**Observed Codex CLI surface:** `codex-cli 0.128.0` exposes interactive
sessions, `codex exec`, `codex review`, MCP management, plugin management,
and Codex-as-MCP-server. In this host, Codex also exposes conversation-level
subagents through `spawn_agent`, but that is a Codex host tool, not a
TypeScript API that `@ai-sdlc/pipeline-cli` can call directly today.

## Positioning

RFC-0012 defines two execution tiers:

| Tier | Claude Code path | Codex CLI status |
|---|---|---|
| Tier 1 attended | `/ai-sdlc execute <task-id>` runs in the main Claude Code session and dispatches plugin agents with `Agent(developer, code-reviewer, test-reviewer, security-reviewer)`. | Codex can act as the attended orchestrator, but it does not expose Claude Code's plugin `Agent` tool. Codex needs a host-level adapter or documented operator procedure for developer and reviewer dispatch. |
| Tier 2 unattended | `executePipeline()` runs deterministic steps and uses an injected `SubagentSpawner` for LLM boundaries. | Codex can be a future spawner only after there is a callable adapter boundary. A TypeScript spawner cannot call the conversation-only `spawn_agent` tool unless Codex exposes that bridge. |

The Codex path must preserve the RFC-0012 boundary: deterministic work stays
in `@ai-sdlc/pipeline-cli` and MCP tools; LLM work is the only harness-specific
part.

## Step Map

| RFC-0012 step | Claude Code Tier 1 primitive | Codex equivalent | Classification | Proposed Codex adapter shape |
|---|---|---|---|---|
| 0. Sweep merged worktrees | Slash command Bash and shared step/MCP wrapper. | Shell command or MCP `pipeline_step_0_sweep`. | No change needed. Uses shared deterministic primitives. | Prefer MCP when available; shell fallback is acceptable because this step is pure git/GitHub cleanup. |
| 1. Validate task | Backlog MCP plus shared `validateTask`. | MCP `pipeline_step_1_validate` or `node pipeline-cli/bin/ai-sdlc-pipeline.mjs validate-task`. | No change needed. Uses shared deterministic primitives. | Codex should fail closed on validation errors and should not create a worktree before this passes. |
| 2. Compute branch | Shared `computeBranchName` or MCP Step 2. | MCP `pipeline_step_2_compute_branch` or CLI compute branch command. | Needs Codex adapter guard. | Codex must trust the shared step only when it returns a valid slug and branch. If the task parser returns a block-scalar marker such as `>-` as the title, Codex must stop and file/fix the parser bug rather than hand-patching branch names. AISDLC-202.2 owns the durable fallback/regression test. |
| 3. Setup worktree | Shared `setupWorktree`. | MCP `pipeline_step_3_setup_worktree` or CLI setup command. | No change needed. Uses shared deterministic primitives. | Codex should run this only after Step 2 returns a valid branch and worktree path. |
| 4. Begin task and write sentinel | Plugin task edit plus per-worktree `.active-task`. | MCP `pipeline_step_4_begin_task` or plugin/backlog MCP plus sentinel write. | No change needed, with Codex workflow constraint. | Codex must write the sentinel inside the worktree and must not use a project-level sentinel. If parent and worktree backlog files diverge, stop and reconcile through the shared step. |
| 5. Build developer prompt | Shared `buildDeveloperPrompt`. | MCP `pipeline_step_5_build_dev_prompt` or CLI prompt builder. | No change needed. Uses shared deterministic primitives. | The prompt should include the Codex harness note only outside the task contract, not by changing the developer return schema. |
| 5b. Spawn developer | Claude Code `Agent(developer)`. | Codex host `spawn_agent` worker, `codex exec`, or future Codex spawner. | Needs Codex adapter. | `CodexHarnessAdapter.spawnDeveloper({prompt, cwd, taskId}) -> DeveloperReturn`. It must load or embed the plugin developer instructions, set cwd to the worktree, and require the same JSON return expected by Step 6. |
| 6. Parse developer return | Shared `parseDeveloperReturnWithRetry`. | Same shared parser after Codex developer output is captured. | No change needed after adapter normalization. | Adapter must pass raw output and parsed JSON in a `SubagentResult`-compatible envelope so existing parser/retry code can run. |
| 7. Build review prompts | Shared `buildReviewPrompts`. | MCP `pipeline_step_7_build_review_prompts` or CLI prompt builder. | No change needed. Uses shared deterministic primitives. | Codex must preserve the returned reviewer-specific prompts and harness note. |
| 7b. Spawn reviewers | Claude Code `Agent(code-reviewer)`, `Agent(test-reviewer)`, `Agent(security-reviewer)` in parallel. | Codex host `spawn_agent` reviewers, `codex review`, or future Codex spawner. | Needs Codex adapter. | `CodexHarnessAdapter.spawnReviewers({prompts, cwd, taskId}) -> ReviewerVerdict[]`. It should run the three reviewers concurrently where the host supports it and return canonical reviewer verdicts, not prose summaries that need manual reshaping. |
| 8. Aggregate verdicts | Shared `aggregateVerdicts`. | MCP `pipeline_step_8_aggregate_verdicts` or shared function. | No change needed after adapter normalization. | Adapter output must be accepted directly by Step 8. Counts and approval should be derived by the shared aggregator, not by Codex prose. |
| 9. Iterate | Slash command prose loop plus shared prompt builders and aggregator. | Codex main-session loop or future `executePipeline()` with Codex spawner. | Needs Codex adapter. | Adapter must support repeated developer and reviewer calls with feedback. Iteration count and cap stay in shared pipeline logic. |
| 10. Finalize and sign | Shared `finalizeTask`, plugin `task_complete`, verdict file, signer. | Shared finalize plus Backlog MCP `task_complete` or equivalent atomic move. | Needs Codex adapter and AISDLC-203 dependency. | Codex finalization must not manually copy task files. It must use Backlog MCP `task_complete` or a shared deterministic completion helper, then verify the task ID exists in exactly one backlog location. |
| 10.5. Rebase/hash oracle where configured | Signer/hash helper. | Same signer/hash helper. | No change needed. Uses shared deterministic primitives. | Codex should not re-sign if the reviewed content hash changed without rerunning reviewers. |
| 11. Push and open PR | Shared `pushAndPr`. | MCP `pipeline_step_11_push_and_pr` or shared function. | No change needed. Uses shared deterministic primitives. | Codex must never force-push, merge, close PRs, or delete branches. |
| 12. Sibling PRs | Shared `siblingPrs`. | MCP `pipeline_step_12_sibling_prs` or shared function. | No change needed. Uses shared deterministic primitives. | Codex should pass through `filesChangedExternal` from the developer return. |
| 13. Cleanup sentinel | Shared `cleanupTask`. | MCP `pipeline_step_13_cleanup` or shared function. | No change needed. Uses shared deterministic primitives. | Codex must run cleanup in a finally-style path on success and failure. |

## Codex Adapter Contract

AISDLC-202.2 should introduce a small adapter boundary rather than letting
each Codex run reconstruct the JSON contracts by hand.

Minimum interface:

```typescript
export interface CodexHarnessAdapter {
  readonly harness: { name: 'codex-cli'; version: string };

  spawnDeveloper(args: {
    taskId: string;
    prompt: string;
    cwd: string;
  }): Promise<SubagentResult>;

  spawnReviewers(args: {
    taskId: string;
    prompts: Array<{ reviewer: ReviewerType; prompt: string }>;
    cwd: string;
  }): Promise<SubagentResult[]>;
}
```

The adapter can be implemented in one of two ways:

| Option | How it works | Status |
|---|---|---|
| Host-tool adapter | Codex main session dispatches `spawn_agent` and passes normalized results into shared steps. | Works manually today, but cannot be called from TypeScript without host support. Good for a documented attended Codex workflow. |
| CLI subprocess adapter | `@ai-sdlc/pipeline-cli` shells out to `codex exec` with prompts that embed the plugin agent instructions. | Candidate for `--spawner codex`, but needs tests proving non-interactive Codex output can reliably return the required JSON. |

The adapter must return `SubagentResult` envelopes compatible with the existing
pipeline parser:

```typescript
{
  type: 'developer' | 'code-reviewer' | 'test-reviewer' | 'security-reviewer',
  output: string,
  parsed?: unknown,
  status: 'success' | 'timeout' | 'error',
  error?: string,
  durationMs: number
}
```

## Reviewer Verdict Shape

Codex reviewer dispatch must return canonical `ReviewerVerdict` objects before
Step 8. The AISDLC-201 run manually converted Codex reviewer summaries into
the signer input. That is the wrong long-term shape.

Canonical verdict:

```json
{
  "agentId": "test-reviewer",
  "harness": "codex-cli",
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

The Step 8 aggregator accepts `findings` as an array. The signing script in
`ai-sdlc-plugin/scripts/sign-attestation.mjs` currently expects the verdict
file to be a raw array of reviewer verdicts. AISDLC-202.3 should remove the
manual wrapper-to-array reshaping by making the Codex finalization path write
the shape the signer consumes.

## Known Gaps From AISDLC-201

| Gap | What happened | Resolution path |
|---|---|---|
| Step 2 branch slug fallback | MCP Step 2 returned a malformed branch based on a parsed title of `>-`, so the Codex run hand-created `ai-sdlc/aisdlc-201-safe-execute-default-mock`. | AISDLC-202.2 should add a regression for block-scalar titles and ensure the shared parser/slug step returns a valid slug or fails before worktree creation. Codex should not hand-patch branch names during normal operation. |
| Reviewer dispatch context | Codex generic subagents received Step 7 prompts, but not the native Claude Code plugin agent runtime. | AISDLC-202.2 should define how the Codex adapter loads plugin agent instructions or equivalent role context for developer, code-reviewer, test-reviewer, and security-reviewer. |
| Reviewer verdict JSON reshaping | The aggregate MCP result was wrapped, while the signer expected a raw reviewer verdict array. Codex manually rewrote `.ai-sdlc/verdicts/<task>.json`. | AISDLC-202.3 should make the Codex finalization path write signer-ready verdict files and record `harness: codex-cli` in the signed claims. |
| Backlog completion | The first Codex run added a completed task file in the PR worktree while the parent checkout still had the original task file in `backlog/tasks/`. | AISDLC-203 and AISDLC-202.3 must require Backlog MCP `task_complete` or an equivalent shared atomic move helper, plus a duplicate check across `backlog/tasks/` and `backlog/completed/`. |
| TypeScript spawner bridge | `spawn_agent` is a Codex host tool, not a library API available to `executePipeline()`. | AISDLC-202.2 must choose between a host-tool attended adapter and a `codex exec` subprocess adapter before advertising `--spawner codex` as a real CLI option. |

## Current Operator Guidance

AISDLC-202.2 through AISDLC-202.4 + AISDLC-247 + AISDLC-251 have shipped.
The Codex execution path is operational for cross-harness review and for
programmatic `--spawner codex` dispatch.

1. **Default path:** Use `/ai-sdlc execute <task-id>` in Claude Code for the
   supported subscription-billed Tier 1 path. This remains the primary
   production path.
2. **Cross-harness review (Claude develops, Codex reviews):** Spawn
   `code-reviewer-codex` and `test-reviewer-codex` alongside the standard
   `security-reviewer`. See
   [`docs/operations/cross-harness-review.md`](./cross-harness-review.md)
   for the full procedure.
3. **Programmatic Codex dispatch (`--spawner codex`):** Use the canonical
   bridge script shipped at `scripts/codex-spawn-agent-bridge.mjs` (AISDLC-251).
   You no longer need to write your own bridge. Set `CODEX_SPAWN_AGENT_BIN`
   to the canonical script and pass `--spawner codex` to
   `ai-sdlc-pipeline execute`:

   ```bash
   export CODEX_SPAWN_AGENT_BIN="$(pwd)/scripts/codex-spawn-agent-bridge.mjs"
   node ./pipeline-cli/bin/ai-sdlc-pipeline.mjs execute AISDLC-NNN --run --spawner codex
   ```

   **Pilot procedure:**

   a. Ensure `codex` CLI 0.128.0+ is on your PATH and authenticated.
   b. Set the env var as shown above — point it at the canonical bridge.
   c. Run `ai-sdlc-pipeline execute <task-id> --run --spawner codex`.
   d. The bridge invokes `codex exec -s workspace-write --skip-git-repo-check
      --color never` for developer dispatch and `codex exec -s read-only
      --skip-git-repo-check --color never` for reviewer dispatch. The developer
      agent needs write access to the task worktree; reviewers remain read-only.
      The composed prompt is sent on stdin with `-` as the prompt argument.
      DO NOT add `--quiet` or `--model o4-mini` — those flags fail on codex
      0.128.0 with ChatGPT-account auth (verified empirically in AISDLC-249/247
      smoke testing: `--quiet` → "unexpected argument", `--model o4-mini` →
      HTTP 400).
   e. Per-field overrides: add safe model/provider options such as
      `"extraArgs": ["--model", "gpt-5.4"]` in the request envelope if your
      Codex auth supports them. The canonical bridge strips config, sandbox,
      cwd, and writable-root overrides so callers cannot relax the selected
      sandbox mode.

   The bridge implements the JSON-line wire protocol from
   `pipeline-cli/src/runtime/spawners/codex-harness.ts`:
   reads `{ agentType, systemPrompt, userPrompt, cwd, timeoutMs }` from stdin,
   invokes `codex exec`, writes `{ output, parsed? }` to stdout. Empty stdout
   from the bridge or from `codex exec` is treated as a bridge error with
   diagnostics, not as an empty developer JSON envelope.

4. **Developer dispatch via Codex (Codex develops, Claude reviews):** The
   attended path works today via the Codex host's `spawn_agent` tool. Use the
   Claude Code reviewer variants (no `-codex` suffix) as reviewers — they
   provide the cross-harness independence benefit in this direction.
