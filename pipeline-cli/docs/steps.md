# Pipeline steps — per-step contract reference

> **RFC-0012 §5** — `@ai-sdlc/pipeline-cli` extracts the Step 0-13 logic
> originally embedded in `ai-sdlc-plugin/agents/execute-orchestrator.md` (now
> superseded by the inline `commands/execute.md` slash command body — AISDLC-98)
> + `orchestrator/src/` into pure step functions exposed three ways:
> as a TypeScript library, as `ai-sdlc-pipeline` CLI subcommands, and (post
> Phase 3) as MCP tools.

This page documents one step per section: contract, inputs, outputs, side
effects, when each step runs. Sourced from each step file's JSDoc + return
type. For the source of truth refer to `pipeline-cli/src/steps/<N>-*.ts` and
`pipeline-cli/src/types.ts`.

## Conventions

- Every step exports a pure async function that returns a typed object (no
  thrown exceptions for expected failure paths — failures resolve as
  `{ ok: false, reason }` or with a documented field on the result type).
- Steps that shell out (`git`, `gh`, `which`) accept an optional `runner?:
  Runner` for test injection. When omitted, `defaultRunner` runs the real
  process via `child_process.execFile`.
- Each step is colocated with its tests under `pipeline-cli/src/steps/<N>-*.ts`
  ↔ `<N>-*.test.ts` (happy-path + error-path coverage; integration test in
  `pipeline-cli/src/execute-pipeline.test.ts` runs all 14 against a `MockSpawner`).
- The CLI subcommand emits the same JSON shape the TypeScript function returns
  — so `ai-sdlc-pipeline validate-task AISDLC-100.7` prints the same payload
  `validateTask(...)` resolves to.

## Step 0 — sweep merged worktrees (`sweepMergedWorktrees`)

**Module**: `steps/00-sweep.ts` · **CLI**: `sweep-worktrees`

**Contract**: walk `<workDir>/.worktrees/`, look up each worktree's branch,
and remove the worktree if the corresponding GitHub PR has merged.

**Inputs**

```ts
interface SweepOptions {
  workDir: string;
  runner?: Runner;
}
```

**Outputs**

```ts
interface SweepResult {
  swept: Array<{ worktreePath: string; branch: string; mergedAt: string }>;
}
```

**Side effects**: shells out to `git -C <wt> rev-parse --abbrev-ref HEAD`,
`gh pr list --head <branch> --state merged`, and `git worktree remove --force
<wt>` for each merged entry.

**When it runs**: first step of every `executePipeline()` call. Idempotent and
parallel-safe — `git worktree remove --force` on an already-swept entry is a
no-op. Detached-HEAD worktrees and worktrees whose `gh pr list` lookup fails
(network/auth) are silently skipped per RFC contract.

## Step 1 — validate task spec (`validateTask`)

**Module**: `steps/01-validate.ts` · **CLI**: `validate-task <task-id>`

**Contract**: read the backlog task file from `<workDir>/backlog/tasks/<id-lower> -*.md`,
parse YAML frontmatter + AC checkboxes, and apply RFC-0012 §5.4 acceptance gates:

- Status MUST be `To Do` or `In Progress` (not `Draft`, not `Done`).
- At least one acceptance criterion MUST exist.
- Reject the "stale-Done" shape (status=In Progress with all ACs already checked).

**Inputs**

```ts
interface ValidateTaskOptions {
  taskId: string;
  workDir: string;
}
```

**Outputs**

```ts
interface ValidateResult {
  ok: boolean;
  reason?: string;
  task?: TaskSpec;
}
```

**Side effects**: read-only `node:fs` access to the task file. No git/network.

**When it runs**: Step 1 of every pipeline invocation. Composite gates abort
the run with `outcome: 'aborted'` when `ok` is false. The CLI subcommand also
seeds Steps 2/3/4/5/7 — they re-run validation internally so they can be
called individually.

## Step 2 — compute branch name (`computeBranchName`)

**Module**: `steps/02-compute-branch.ts` · **CLI**: `compute-branch <task-id>`

**Contract**: read `branching.pattern` from `.ai-sdlc/pipeline-backlog.yaml`
(default: `ai-sdlc/{issueIdLower}-{slug}`) and substitute `{issueIdLower}` +
`{slug}` to produce the final branch name. The slug is a kebab-cased prefix of
the task title capped at 50 chars. The worktree path is
`<workDir>/.worktrees/<issueIdLower>`.

**Inputs**

```ts
interface ComputeBranchOptions {
  taskId: string;
  task: TaskSpec;
  workDir: string;
  defaultPattern?: string;
}
```

**Outputs**

```ts
interface ComputeBranchResult {
  branch: string;
  worktreePath: string;
  slug: string;
  taskIdLower: string;
}
```

**Side effects**: read-only `node:fs` access to `.ai-sdlc/pipeline-backlog.yaml`.
No git/network.

**When it runs**: between Steps 1 and 3 to plan the worktree layout. Pure +
deterministic given the task title and the project's branching pattern config.

## Step 3 — setup worktree (`setupWorktree`)

**Module**: `steps/03-setup-worktree.ts` · **CLI**: `setup-worktree <task-id>`

**Contract**: fetch latest `origin/main`, create `.worktrees/`, run
`git worktree add <path> -b <branch> origin/main`. Paired with Step 10.5
(AISDLC-102) for defense in depth — both fetch latest main so the developer
runs against current state from the start.

**Inputs**

```ts
interface SetupWorktreeOptions {
  taskId: string;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Skip `git fetch origin main` (offline runs / tests). */
  skipFetch?: boolean;
}
```

**Outputs**

```ts
interface SetupWorktreeResult {
  branch: string;
  worktreePath: string;
  baseSha: string;
}
```

**Side effects**: `git fetch origin main`, `mkdir -p .worktrees`,
`git worktree add ...`. On `git worktree add` failure throws a `StepError`
with the most likely remediation (`/ai-sdlc cleanup <task-id>` first or pick a
different task).

**When it runs**: Step 3 of every pipeline invocation. After this step the
worktree at `<worktreePath>` is on a fresh branch checked out from current
`origin/main`.

## Step 4 — begin task (`beginTask`)

**Module**: `steps/04-flip-status.ts` · **CLI**: `begin-task <task-id>`

**Contract**: flip the task's status frontmatter to `In Progress` (preserving
all other YAML keys via direct line-patching, matching the plugin's `task_edit`
key-preservation contract) and write the per-worktree `.active-task` sentinel
(AISDLC-81). The sentinel lives INSIDE the worktree at
`<worktreePath>/.active-task` so the PreToolUse hook can resolve
`permittedExternalPaths` by walking up from the developer subagent's cwd.

**Inputs**

```ts
interface BeginTaskOptions {
  taskId: string;
  worktreePath: string;
  workDir: string;
  /** Override the status (test-only — defaults to 'In Progress'). */
  status?: string;
}
```

**Outputs**

```ts
interface BeginTaskResult {
  taskId: string;
  worktreePath: string;
  sentinelPath: string;
}
```

**Side effects**: writes the task file (frontmatter patch) and the
`.active-task` sentinel inside the worktree.

**When it runs**: Step 4 of every pipeline invocation. After this step the
PreToolUse hook will recognise the worktree as governed by the task's
`permittedExternalPaths` allowlist. `executePipeline()` wraps Steps 5-13 in a
`try/finally` so Step 13 cleanup ALWAYS runs even on developer failure.

## Step 5 — build developer prompt (`buildDeveloperPrompt`)

**Module**: `steps/05-build-dev-prompt.ts` · **CLI**: `build-dev-prompt <task-id>`

**Contract**: pure function — TaskSpec + branch context → prompt string.
Mirrors the prose template from `execute-orchestrator.md` Step 5 verbatim so
swapping Tier 1 / Tier 2 invocation produces byte-identical prompts.

**Inputs**

```ts
interface BuildDeveloperPromptOptions {
  taskId: string;
  task: TaskSpec;
  branch: string;
  worktreePath: string;
  /** Optional reviewer feedback bundle for iteration N>1 (Step 9). */
  reviewerFeedback?: string;
  /** Iteration number — set to >1 to inject the feedback section (default 1). */
  iteration?: number;
}
```

**Outputs**

```ts
interface DeveloperPromptResult {
  prompt: string;
  /** The TaskSpec that was rendered (echo for caller convenience). */
  task: TaskSpec;
}
```

**Side effects**: none. Pure.

**When it runs**: Step 5 of every pipeline invocation, plus once per iteration
inside Step 9's loop with `iteration > 1` and `reviewerFeedback` set. The LLM
dispatch (Step 5b) is NOT implemented here — that's
`SubagentSpawner.spawn({ type: 'developer', prompt })`, called by
`executePipeline()` (Tier 2) or by the `Agent` tool from the slash command body
(Tier 1).

## Step 6 — parse developer return (`parseDeveloperReturn`)

**Module**: `steps/06-parse-dev-return.ts` · **CLI**: `parse-dev-return --return <json>`

**Contract**: parse the developer subagent's JSON return and apply gates:

- If `commitSha` is null → developer-failed.
- If any of `verifications.{build,test,lint,format}` is `failed` → developer-failed.
- Otherwise validate required keys and shapes, then return `{ ok: true, developer }`.

Accepts either a JSON string or an already-parsed object so the same function
works for Tier 1 (CLI receives `--return <json>`) and Tier 2 (the spawner's
`SubagentResult.parsed`).

**Inputs**

```ts
interface ParseDeveloperReturnOptions {
  developerReturn: string | unknown;
}
```

**Outputs**

```ts
interface ParseDeveloperReturnResult {
  ok: boolean;
  reason?: string;
  developer?: DeveloperReturn;
}

interface DeveloperReturn {
  summary: string;
  filesChanged: string[];
  filesChangedExternal?: Array<{ repo: string; files: string[] }>;
  commitSha: string | null;
  verifications: {
    build: VerificationStatus;
    test: VerificationStatus;
    lint: VerificationStatus;
    format: VerificationStatus;
  };
  acceptanceCriteriaMet: number[];
  notes?: string;
}
```

**Side effects**: none. Pure.

**When it runs**: immediately after Step 5b's developer spawn returns. When
`ok` is false the composite aborts the pipeline with `outcome: 'developer-failed'`
and surfaces the reason in `PipelineResult.notes`.

## Step 7 — build review prompts (`buildReviewPrompts`)

**Module**: `steps/07-build-review-prompts.ts` · **CLI**: `build-review-prompts <task-id>`

**Contract**: capture the PR diff + changed file list, detect whether `codex`
is installed (independence harness — when missing the prompts get a
`harnessNote` so the aggregator can flag "INDEPENDENCE NOT ENFORCED"), and
produce three reviewer-specific prompt strings (one each for code-reviewer,
test-reviewer, security-reviewer).

**Inputs**

```ts
interface BuildReviewPromptsOptions {
  taskId: string;
  task: TaskSpec;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Override the codex-availability detection (test injection). */
  codexAvailable?: boolean;
}
```

**Outputs**

```ts
interface BuildReviewPromptsResult {
  prompts: ReviewPrompt[]; // length 3, ordered code/test/security
  diff: string;
  changedFiles: string[];
  harnessNote: string; // empty when codex available
}
```

**Side effects**: shells out to `git diff origin/main...HEAD` (twice — once for
content, once for `--name-only`) and `which codex`. Reads optional
`.ai-sdlc/review-policy.md` for project-specific reviewer calibration.

**When it runs**: Step 7 of every pipeline invocation, plus once per iteration
inside Step 9's loop. The three LLM dispatches (Step 7b) are NOT implemented
here — `executePipeline()` calls `spawner.spawnParallel(buildResult.prompts.map(p => ({...})))`
to fan them out.

## Step 8 — aggregate verdicts (`aggregateVerdicts`)

**Module**: `steps/08-aggregate-verdicts.ts` · **CLI**: `aggregate-verdicts --verdicts <json>`

**Contract**: pure function — three reviewer verdicts → single gate decision:

- Count findings by severity across all reviewers.
- APPROVED if all reviewers approved AND no critical/major findings.
- CHANGES_REQUESTED otherwise → enters Step 9's iteration loop.
- HARNESS_NOTE (if any) prepended to the aggregated `summary` string.

Also exports `coerceReviewerVerdict` (used by `executePipeline()` to coerce a
`SubagentResult` into a `ReviewerVerdict`) and `formatFeedback` (used by
Step 9 to render blocking findings into the developer's iteration N>1 prompt).

**Inputs**

```ts
interface AggregateVerdictsOptions {
  verdicts: ReviewerVerdict[];
  harnessNote?: string;
}
```

**Outputs**

```ts
interface AggregatedVerdict {
  approved: boolean;
  counts: Record<Severity, number>;
  decision: 'APPROVED' | 'CHANGES_REQUESTED';
  verdicts: ReviewerVerdict[];
  harnessNote: string;
  summary: string;
}
```

**Side effects**: none. Pure + deterministic.

**When it runs**: Step 8 of every pipeline invocation, once per iteration of
Step 9's loop. Drives the loop's `while (currentVerdict.decision === 'CHANGES_REQUESTED')`
condition.

## Step 9 — review iteration loop (`iterateReviewLoop`)

**Module**: `steps/09-iterate.ts` · **CLI**: (Tier 2 composite only — no
standalone subcommand because the loop fans out subagents through the
SubagentSpawner injected into `executePipeline()`)

**Contract**: wrap Steps 5/5b/6/7/7b/8 and loop until reviewers approve OR the
iteration cap is hit. The LLM dispatch (Steps 5b, 7b) goes through the
injected `SubagentSpawner`, which lets Tier 2 swap between
`ShellClaudePSpawner` (subscription), `ClaudeCodeSDKSpawner` (API key), and
`MockSpawner` (tests).

If the cap is hit and there are still critical/major findings, returns with
`needsHumanAttention: true` — Step 10 then skips finalisation and Step 11
opens the PR with the `[needs-human-attention]` flag in the title.

**Inputs**

```ts
interface IterateReviewLoopOptions {
  taskId: string;
  worktreePath: string;
  task: TaskSpec;
  branch: string;
  initialDeveloperReturn: DeveloperReturn;
  initialVerdict: AggregatedVerdict;
  /** Default 2 (initial round + 1 retry). */
  maxIterations?: number;
  spawner?: SubagentSpawner;
  onIteration?: (iteration: number, verdict: AggregatedVerdict) => Promise<void> | void;
}
```

**Outputs**

```ts
interface IterateReviewLoopResult {
  finalDeveloperReturn: DeveloperReturn;
  finalVerdict: AggregatedVerdict;
  iterations: number;
  needsHumanAttention: boolean;
}
```

**Side effects**: each iteration spawns one developer subagent + three reviewer
subagents through the injected spawner. Without a spawner the loop returns
immediately with the initial verdict (Tier 1 prose mode lets the slash command
body drive the next iteration).

**When it runs**: Step 9 of every pipeline invocation. Caller seeds it with
the iteration-1 developer return + iteration-1 aggregated verdict (Steps 5b →
6 → 7b → 8 already ran).

## Step 10 — finalize task (`finalizeTask`)

**Module**: `steps/10-finalize.ts` · **CLI**: `finalize-task <task-id> --developer-return <json> --verdict <json>`

**Contract**: build `acceptanceCriteriaCheck` + `finalSummary`, patch task
frontmatter to `Done`, move file from `backlog/tasks/` → `backlog/completed/`
(matching the plugin's `task_complete` MCP tool semantics), sign attestation
(via `ai-sdlc-plugin/scripts/sign-attestation.mjs` when present), and create
the chore commit. Skipped entirely when the iteration cap was hit
(`needsHumanAttention`) — the human flips Done after they're satisfied via
`/ai-sdlc complete <task-id>` or by hand.

**Inputs**

```ts
interface FinalizeStepOptions {
  taskId: string;
  workDir: string;
  worktreePath: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  verdict: AggregatedVerdict;
  iterations: number;
  runner?: Runner;
  /** Path to sign-attestation.mjs (defaults to detection by env var). */
  signAttestationScript?: string;
  /** Skip chore commit (tests without a real git repo). */
  skipCommit?: boolean;
}
```

**Outputs**

```ts
interface FinalizeTaskResult {
  finalSummary: string;
  acceptanceCriteriaCheck: number[];
  attestationPath: string | null;
  choreCommitSha: string | null;
  /** True when finalisation was skipped due to needs-human-attention. */
  skipped: boolean;
}
```

**Side effects**: writes the task file (frontmatter patch), moves the file
between `backlog/tasks/` and `backlog/completed/`, optionally invokes
`sign-attestation.mjs` (which writes a DSSE envelope under
`.ai-sdlc/attestations/`), and runs `git add` + `git commit -m "chore: ..."`
in the worktree.

**When it runs**: Step 10 of every pipeline invocation, gated on
`verdict.decision === 'APPROVED'` (otherwise short-circuits with `skipped: true`).
Phase 6 (AISDLC-100.6) added a `pipelineVersion` field to the attestation
envelope for forensic correlation; the plumbing lives in `sign-attestation.mjs`,
not in this step.

## Step 11 — push and open PR (`pushAndPr`)

**Module**: `steps/11-push-and-pr.ts` · **CLI**: `push-and-pr <task-id> --developer-return <json> --verdict <json>`

**Contract**: read PR title template from `.ai-sdlc/pipeline-backlog.yaml`
(`pullRequest.titleTemplate`, default `feat: {issueTitle} ({issueId})`),
compose the PR body from developer summary + changed files + code reviewer
summary, then `git push -u origin <branch>` followed by `gh pr create`.

**Hard rules NEVER violated** (RFC §11.5):

- No `git push --force` / `-f`
- No `gh pr merge`
- No `git branch -D` / `-d`
- On non-fast-forward push: abort cleanly with `pushed: false` + reason

**Inputs**

```ts
interface PushAndPrStepOptions {
  taskId: string;
  workDir: string;
  worktreePath: string;
  branch: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  verdict: AggregatedVerdict;
  needsHumanAttention?: boolean;
  runner?: Runner;
}
```

**Outputs**

```ts
interface PushAndPrResult {
  pushed: boolean;
  prUrl: string | null;
  /** When push fails non-fast-forward we abort cleanly with a reason. */
  reason?: string;
}
```

**Side effects**: `git push -u origin <branch>` (no force), `gh pr create`.
Reads `.ai-sdlc/pipeline-backlog.yaml` for the title template.

**When it runs**: Step 11 of every pipeline invocation that reaches Step 10
(approved OR `needsHumanAttention`; the PR is still opened in the latter case
with the `[needs-human-attention]` flag in the title and a header warning in
the body).

## Step 12 — sibling PRs (`siblingPrs`)

**Module**: `steps/12-sibling-prs.ts` · **CLI**: `sibling-prs <task-id> --developer-return <json> --main-pr-url <url>`

**Contract**: for each entry in `developerReturn.filesChangedExternal` (cross-repo
writes the developer made under `permittedExternalPaths`):

1. Verify the path is a git repo.
2. Skip if `git status --porcelain` is empty (nothing to push).
3. Confirm `gh` auth works for the sibling.
4. Create a parallel branch named `ai-sdlc/<task-id-lower>-sibling`.
5. Stage the developer-reported files, commit, push.
6. Open the sibling PR linking back to the main PR URL.

Each sibling is independent — failure of one does NOT roll back the main PR.

**Inputs**

```ts
interface SiblingPrStepOptions {
  taskId: string;
  workDir: string;
  task: TaskSpec;
  developerReturn: DeveloperReturn;
  mainPrUrl: string;
  runner?: Runner;
}
```

**Outputs**

```ts
interface SiblingPrResult {
  prs: Array<{ repo: string; branch: string; prUrl: string | null; reason?: string }>;
}
```

**Side effects**: `git checkout -b`, `git add`, `git commit`, `git push`, and
`gh pr create` IN THE SIBLING REPO (not the main worktree). Reads
`developerReturn.filesChangedExternal` to know which files to stage.

**When it runs**: Step 12 of every pipeline invocation that successfully
opened the main PR in Step 11. Skipped (returns `{ prs: [] }`) when
`developerReturn.filesChangedExternal` is empty.

## Step 13 — cleanup sentinel (`cleanupTask`)

**Module**: `steps/13-cleanup.ts` · **CLI**: `cleanup-task <task-id>`

**Contract**: remove the per-worktree `.active-task` sentinel
(`<worktreePath>/.active-task`). Always runs (success, failure, rollback,
escalation) — closes the implicit `try/finally` started at Step 4.

**Inputs**

```ts
interface CleanupOptions {
  taskId: string;
  worktreePath: string;
}
```

**Outputs**

```ts
interface CleanupResult {
  sentinelRemoved: boolean;
}
```

**Side effects**: `unlink` the sentinel file. Defensive against races — when
removal fails (another cleanup run won), returns
`{ sentinelRemoved: false }` rather than throwing.

**When it runs**: ALWAYS, in `executePipeline()`'s `finally` block. Mandatory
per RFC §3.1 hard rules — leaving `.active-task` in place strands the
PreToolUse hook on the next session and breaks parallel-run isolation.

## See also

- [`pipeline-cli/README.md`](../README.md) — package overview, install
  instructions, Tier 1 + Tier 2 quickstarts.
- [`pipeline-cli/docs/spawner.md`](./spawner.md) — SubagentSpawner selection
  guide, custom spawner howto, Q5 resolution.
- [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md)
  — full design (the canonical reference for the Step 0-13 contract).
- `pipeline-cli/src/types.ts` — every Step result type and option type defined
  in one file.
- `pipeline-cli/src/execute-pipeline.ts` — the Tier 2 composite that orders
  Steps 0-13 and wires Step 13's `try/finally` cleanup.
