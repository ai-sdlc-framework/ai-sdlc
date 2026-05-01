# @ai-sdlc/pipeline-cli

Shared core library for the AI-SDLC pipeline. Implements RFC-0012 Phase 1.

## Status

**Phase 1 of RFC-0012** — extracts Step 0-13 logic from `ai-sdlc-plugin/agents/execute-orchestrator.md` and `orchestrator/src/` into pure step functions exposed three ways:

1. **TypeScript library** — `import { validateTask, executePipeline, ... } from '@ai-sdlc/pipeline-cli'`
2. **CLI subcommands** — `ai-sdlc-pipeline <command>` (yargs-driven)
3. **MCP tools** — Phase 3 (AISDLC-100.3) wraps each step as an MCP tool from the plugin's MCP server

The package is **`private: true`** in Phase 1. Phase 8 (AISDLC-100.8) flips that, adds the `publishConfig` block, and publishes to npm.

## Layout

```
pipeline-cli/
├── package.json
├── README.md                       (this file)
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── ai-sdlc-pipeline.mjs        # shebang wrapper around dist/cli/index.js
├── src/
│   ├── index.ts                    # public barrel
│   ├── types.ts                    # PipelineOptions, StepResult, SubagentSpawner, etc.
│   ├── execute-pipeline.ts         # Tier 2 composite entry point
│   ├── runtime/
│   │   ├── index.ts
│   │   ├── exec.ts                 # Runner abstraction over child_process.execFile
│   │   └── subagent-spawner.ts     # SubagentSpawner interface + MockSpawner
│   ├── steps/
│   │   ├── index.ts
│   │   ├── 00-sweep.ts             # Step 0 — sweep merged worktrees
│   │   ├── 01-validate.ts          # Step 1 — validate backlog task spec
│   │   ├── 02-compute-branch.ts    # Step 2 — branch name + worktree path
│   │   ├── 03-setup-worktree.ts    # Step 3 — git worktree add
│   │   ├── 04-flip-status.ts       # Step 4 — status flip + .active-task sentinel
│   │   ├── 05-build-dev-prompt.ts  # Step 5 — developer prompt template
│   │   ├── 06-parse-dev-return.ts  # Step 6 — parse + gate developer JSON
│   │   ├── 07-build-review-prompts.ts # Step 7 — 3 reviewer prompts
│   │   ├── 08-aggregate-verdicts.ts   # Step 8 — verdict aggregation
│   │   ├── 09-iterate.ts           # Step 9 — review iteration loop
│   │   ├── 10-finalize.ts          # Step 10 — Done + completed/ + attestation + chore commit
│   │   ├── 11-push-and-pr.ts       # Step 11 — push + gh pr create
│   │   ├── 12-sibling-prs.ts       # Step 12 — cross-repo sibling PRs
│   │   └── 13-cleanup.ts           # Step 13 — sentinel cleanup
│   └── cli/
│       └── index.ts                # yargs subcommand router
└── tests/
    ├── helpers/
    │   └── make-task.ts            # backlog task fixture builder
    ├── unit/
    │   └── steps/                  # one test file per step
    └── integration/
        └── pipeline.test.ts        # full Step 0-13 with MockSpawner
```

## CLI quickstart

```bash
# After `pnpm build` in this package:
node ./bin/ai-sdlc-pipeline.mjs --help
node ./bin/ai-sdlc-pipeline.mjs validate-task AISDLC-100.1
node ./bin/ai-sdlc-pipeline.mjs sweep-worktrees
```

Every subcommand emits JSON on stdout. Tier 1 (the slash command body) parses that JSON to drive subsequent steps.

## TypeScript usage

```ts
import {
  executePipeline,
  MockSpawner,
} from '@ai-sdlc/pipeline-cli';

const result = await executePipeline({
  taskId: 'AISDLC-100.1',
  workDir: process.cwd(),
  spawner: new MockSpawner({
    developer: { type: 'developer', output: '...', parsed: {/* DeveloperReturn */}, status: 'success', durationMs: 0 },
    'code-reviewer': { ... },
    'test-reviewer': { ... },
    'security-reviewer': { ... },
  }),
});
console.log(result.outcome);  // 'approved' | 'needs-human-attention' | 'developer-failed' | 'aborted'
```

The production spawners (`ShellClaudePSpawner` for subscription billing, `ClaudeCodeSDKSpawner` for API-key billing) land in **Phase 2 — AISDLC-100.2**.

## SubagentSpawner contract

The pipeline is purely deterministic except for two LLM dispatch points:

- **Step 5b** — spawn the `developer` subagent with the prompt rendered in Step 5
- **Step 7b** — spawn `code-reviewer`, `test-reviewer`, `security-reviewer` in parallel

Both go through the `SubagentSpawner` interface (RFC-0012 §8). That's the only piece of the pipeline that varies between Tier 1 (Agent tool from main session), Tier 2 subscription (`claude -p`), Tier 2 API key (Claude Code SDK), and tests (`MockSpawner`).

```ts
interface SubagentSpawner {
  spawn(opts: SpawnOpts): Promise<SubagentResult>;
  spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]>;
}
```

`MockSpawner` (shipped here for tests) accepts either fixed results per subagent type or a callback per type so iteration N>1 can return different fixtures than iteration 1.

## Step contracts

Every step exports a pure async function. The return shape is documented in `src/types.ts` + the per-step JSDoc. The JSON returned by the CLI subcommands matches the TypeScript return shape exactly.

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

## Hard rules (NEVER violated by any step)

These come from RFC-0012 §3.1 + the AI-SDLC governance hooks:

1. **Never `gh pr merge`.** Step 11 only opens PRs.
2. **Never `git push --force` / `-f`.** Step 11 aborts cleanly on non-fast-forward.
3. **Never delete branches** (no `git branch -D` / `-d`).
4. **Never edit `.ai-sdlc/**` or `.github/workflows/**`.** Pre-tool-use hook blocks anyway.
5. **Never run destructive git ops** (no `reset --hard`, `checkout -- .`, `restore .`).
6. **Step 13 is mandatory** — the sentinel is removed in a `finally` block from `executePipeline`.

## Testing

- **Unit tests** live next to each step in `tests/unit/steps/<step>.test.ts`. Each step has happy-path + error-path coverage.
- **Integration test** in `tests/integration/pipeline.test.ts` runs the full Step 0-13 against `MockSpawner` in a tmp project root.
- **CLI tests** in `tests/unit/cli.test.ts` exercise the yargs router.
- **Coverage gate** is 80% lines/functions, enforced by `vitest.config.ts` and the workspace-level `scripts/check-coverage.sh`.

```bash
pnpm test                  # vitest run
pnpm test:coverage         # with v8 coverage + thresholds
pnpm test:watch            # iteration mode
```

## Future phases

| Phase | Task | What changes |
|---|---|---|
| 2 | AISDLC-100.2 | `ShellClaudePSpawner` (subscription) + `ClaudeCodeSDKSpawner` (API key) |
| 3 | AISDLC-100.3 | Wrap each step function as an MCP tool in `ai-sdlc-plugin/mcp-server/` |
| 4 | AISDLC-100.4 | Refactor `commands/execute.md` to use the CLI; delete `agents/execute-orchestrator.md` |
| 5 | AISDLC-100.5 | Migrate `dogfood/src/watch.ts` to call `executePipeline()` |
| 6 | AISDLC-100.6 | Add `pipelineVersion` to attestation envelope |
| 7 | AISDLC-100.7 | Documentation pass — this file gets the per-step deep-dive |
| 8 | AISDLC-100.8 | Flip `private: false`, add `publishConfig`, ship to npm |

See [`spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md`](../spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md) for the full design.
