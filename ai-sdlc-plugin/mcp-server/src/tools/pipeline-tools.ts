/**
 * MCP tool wrappers around the @ai-sdlc/pipeline-cli step functions
 * (RFC-0012 Phase 3 — AISDLC-100.3).
 *
 * Each Step 0-13 function from `@ai-sdlc/pipeline-cli` is exposed here as
 * one MCP tool named `pipeline_step_<N>_<name>`. The slash command body
 * (`ai-sdlc-plugin/commands/execute.md`) can invoke these tools via
 * `mcp__plugin_ai-sdlc_ai-sdlc__pipeline_step_<N>_<name>` instead of
 * shelling out to the `ai-sdlc-pipeline` CLI binary inline.
 *
 * Design notes:
 *  - Each tool's input schema is a zod shape mirroring the step's
 *    `Options` interface from `@ai-sdlc/pipeline-cli`.
 *  - Each tool's output is the structured `Result` type, JSON-serialised
 *    inside an MCP `text` content item (the SDK doesn't have a JSON
 *    content kind — callers `JSON.parse` the text).
 *  - Step 9 (iterate) is the only step that needs a `SubagentSpawner`.
 *    When the caller doesn't pass one (the only realistic case from a
 *    plugin invocation), we resolve `defaultSpawner()` lazily from
 *    `@ai-sdlc/pipeline-cli/runtime`. Tests inject `spawnerFactory` via
 *    `PipelineToolDeps` so they don't shell out to `claude` or hit the
 *    Anthropic API.
 *  - Each step function is invoked through a `stepRunners` map so tests
 *    can substitute mocks without monkey-patching the imported module.
 *
 * @see RFC-0012 §9 (Phase 3 — MCP tool wrappers)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  aggregateVerdicts,
  beginTask,
  buildDeveloperPrompt,
  buildReviewPrompts,
  cleanupTask,
  computeBranchName,
  defaultSpawner,
  finalizeTask,
  iterateReviewLoop,
  parseDeveloperReturn,
  pushAndPr,
  setupWorktree,
  siblingPrs,
  sweepMergedWorktrees,
  validateTask,
  type SubagentSpawner,
} from '@ai-sdlc/pipeline-cli';

// ── Injection points exposed to tests ──────────────────────────────────

/**
 * Per-step function map — each tool resolves its implementation through
 * this object so unit tests can pass a mock without touching the live
 * module bindings.
 */
export interface StepRunners {
  sweepMergedWorktrees: typeof sweepMergedWorktrees;
  validateTask: typeof validateTask;
  computeBranchName: typeof computeBranchName;
  setupWorktree: typeof setupWorktree;
  beginTask: typeof beginTask;
  buildDeveloperPrompt: typeof buildDeveloperPrompt;
  parseDeveloperReturn: typeof parseDeveloperReturn;
  buildReviewPrompts: typeof buildReviewPrompts;
  aggregateVerdicts: typeof aggregateVerdicts;
  iterateReviewLoop: typeof iterateReviewLoop;
  finalizeTask: typeof finalizeTask;
  pushAndPr: typeof pushAndPr;
  siblingPrs: typeof siblingPrs;
  cleanupTask: typeof cleanupTask;
}

/** Default step runner table — bound to the live step functions. */
export const defaultStepRunners: StepRunners = {
  sweepMergedWorktrees,
  validateTask,
  computeBranchName,
  setupWorktree,
  beginTask,
  buildDeveloperPrompt,
  parseDeveloperReturn,
  buildReviewPrompts,
  aggregateVerdicts,
  iterateReviewLoop,
  finalizeTask,
  pushAndPr,
  siblingPrs,
  cleanupTask,
};

/** Spawner-factory signature — Step 9 calls this when no spawner is passed in. */
export type SpawnerFactory = () => Promise<SubagentSpawner>;

export interface PipelineToolDeps {
  /** Step function map. Tests inject mocks; production gets `defaultStepRunners`. */
  stepRunners?: Partial<StepRunners>;
  /**
   * Lazy `SubagentSpawner` factory used by Step 9 when the caller didn't
   * pass `opts.spawner`. Defaults to `@ai-sdlc/pipeline-cli`'s
   * `defaultSpawner()` resolver (RFC-0012 §8.3).
   */
  spawnerFactory?: SpawnerFactory;
}

// ── Reusable zod sub-schemas (kept loose with passthrough) ─────────────
//
// The pipeline-cli types (TaskSpec, DeveloperReturn, AggregatedVerdict, …)
// are wide structured objects. We give zod the minimum required keys so
// MCP clients see a discoverable schema shape, but `passthrough()` keeps
// every other key intact — the step functions consume the same TypeScript
// types so any extra fields just flow through.

const taskSpecSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    acceptanceCriteria: z.array(z.string()),
    acceptanceCriteriaChecked: z.array(z.boolean()),
    permittedExternalPaths: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    description: z.string(),
    rawBody: z.string(),
    filePath: z.string(),
  })
  .passthrough();

const verificationStatusSchema = z.enum(['passed', 'failed', 'skipped']);

const developerReturnSchema = z
  .object({
    summary: z.string(),
    filesChanged: z.array(z.string()),
    filesChangedExternal: z
      .array(z.object({ repo: z.string(), files: z.array(z.string()) }).passthrough())
      .optional(),
    commitSha: z.string().nullable(),
    verifications: z
      .object({
        build: verificationStatusSchema,
        test: verificationStatusSchema,
        lint: verificationStatusSchema,
        format: verificationStatusSchema,
      })
      .passthrough(),
    acceptanceCriteriaMet: z.array(z.number()),
    notes: z.string().optional(),
  })
  .passthrough();

const severitySchema = z.enum(['critical', 'major', 'minor', 'suggestion']);

const reviewerFindingSchema = z
  .object({
    severity: severitySchema,
    file: z.string().optional(),
    line: z.number().optional(),
    message: z.string(),
  })
  .passthrough();

const reviewerVerdictSchema = z
  .object({
    agentId: z.string(),
    harness: z.string(),
    approved: z.boolean(),
    findings: z.array(reviewerFindingSchema),
    summary: z.string().optional(),
  })
  .passthrough();

const aggregatedVerdictSchema = z
  .object({
    approved: z.boolean(),
    counts: z
      .object({
        critical: z.number(),
        major: z.number(),
        minor: z.number(),
        suggestion: z.number(),
      })
      .passthrough(),
    decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
    verdicts: z.array(reviewerVerdictSchema),
    harnessNote: z.string(),
    summary: z.string(),
  })
  .passthrough();

// ── Helpers ────────────────────────────────────────────────────────────

/** Wrap a structured result as an MCP `text` content item containing JSON. */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Wrap a thrown error as an MCP `isError: true` text result. */
function errorResult(step: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `${step} failed: ${message}` }],
    isError: true as const,
  };
}

// ── Public registration ────────────────────────────────────────────────

/**
 * Register all 14 pipeline_step_* MCP tools on the supplied server.
 *
 * @param server  MCP server instance (already constructed by `createPluginMcpServer`).
 * @param deps    Optional injection points used by unit tests.
 */
export function registerPipelineTools(server: McpServer, deps: PipelineToolDeps = {}): void {
  const runners = { ...defaultStepRunners, ...(deps.stepRunners ?? {}) };
  const spawnerFactory = deps.spawnerFactory ?? defaultSpawner;

  // ── Step 0 — Sweep ──────────────────────────────────────────────────
  server.tool(
    'pipeline_step_0_sweep',
    'RFC-0012 Step 0: sweep merged worktrees from <workDir>/.worktrees/. Removes worktrees whose PR has merged.',
    {
      workDir: z.string().describe('Project root containing .worktrees/'),
    },
    async ({ workDir }) => {
      try {
        const result = await runners.sweepMergedWorktrees({ workDir });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_0_sweep', err);
      }
    },
  );

  // ── Step 1 — Validate task ──────────────────────────────────────────
  server.tool(
    'pipeline_step_1_validate',
    'RFC-0012 Step 1: validate the backlog task spec at <workDir>/backlog/tasks/<taskId> -*.md.',
    {
      taskId: z.string().describe('Backlog task ID, e.g. "AISDLC-100.3" (case-insensitive)'),
      workDir: z.string().describe('Project root containing backlog/tasks/'),
    },
    async ({ taskId, workDir }) => {
      try {
        const result = await runners.validateTask({ taskId, workDir });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_1_validate', err);
      }
    },
  );

  // ── Step 2 — Compute branch name ────────────────────────────────────
  server.tool(
    'pipeline_step_2_compute_branch',
    'RFC-0012 Step 2: compute the branch name + worktree path for the task using <workDir>/.ai-sdlc/pipeline-backlog.yaml.',
    {
      taskId: z.string().describe('Backlog task ID'),
      task: taskSpecSchema.describe('Parsed TaskSpec returned by Step 1'),
      workDir: z.string().describe('Project root'),
      defaultPattern: z
        .string()
        .optional()
        .describe('Override the default branch pattern when no pipeline config is present.'),
    },
    async ({ taskId, task, workDir, defaultPattern }) => {
      try {
        const result = await runners.computeBranchName({ taskId, task, workDir, defaultPattern });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_2_compute_branch', err);
      }
    },
  );

  // ── Step 3 — Setup worktree ─────────────────────────────────────────
  server.tool(
    'pipeline_step_3_setup_worktree',
    'RFC-0012 Step 3: create the per-task git worktree from origin/main.',
    {
      taskId: z.string(),
      branch: z.string().describe('Computed by Step 2'),
      worktreePath: z.string().describe('Computed by Step 2'),
      workDir: z.string(),
      skipFetch: z
        .boolean()
        .optional()
        .describe('Skip the `git fetch origin main` step (useful in tests / offline runs).'),
    },
    async ({ taskId, branch, worktreePath, workDir, skipFetch }) => {
      try {
        const result = await runners.setupWorktree({
          taskId,
          branch,
          worktreePath,
          workDir,
          skipFetch,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_3_setup_worktree', err);
      }
    },
  );

  // ── Step 4 — Begin task (flip status + write sentinel) ──────────────
  server.tool(
    'pipeline_step_4_begin_task',
    'RFC-0012 Step 4: flip task status to In Progress in the on-disk task file and write the per-worktree .active-task sentinel (AISDLC-81).',
    {
      taskId: z.string(),
      worktreePath: z.string(),
      workDir: z.string(),
      status: z.string().optional().describe("Override status (defaults to 'In Progress')."),
    },
    async ({ taskId, worktreePath, workDir, status }) => {
      try {
        const result = await runners.beginTask({ taskId, worktreePath, workDir, status });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_4_begin_task', err);
      }
    },
  );

  // ── Step 5 — Build developer prompt ─────────────────────────────────
  server.tool(
    'pipeline_step_5_build_dev_prompt',
    'RFC-0012 Step 5: render the developer subagent prompt from the TaskSpec. Pure function — no side effects.',
    {
      taskId: z.string(),
      task: taskSpecSchema,
      branch: z.string(),
      worktreePath: z.string(),
      reviewerFeedback: z
        .string()
        .optional()
        .describe('Optional reviewer feedback bundle for iteration N>1 (Step 9).'),
      iteration: z
        .number()
        .optional()
        .describe('Iteration number — set to >1 to inject the feedback section (default 1).'),
    },
    async ({ taskId, task, branch, worktreePath, reviewerFeedback, iteration }) => {
      try {
        const result = await runners.buildDeveloperPrompt({
          taskId,
          task,
          branch,
          worktreePath,
          reviewerFeedback,
          iteration,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_5_build_dev_prompt', err);
      }
    },
  );

  // ── Step 6 — Parse developer return ─────────────────────────────────
  server.tool(
    'pipeline_step_6_parse_dev_return',
    'RFC-0012 Step 6: parse + validate the developer subagent JSON return. Applies the developer-failed gate (null commitSha or any verifications.failed).',
    {
      developerReturn: z
        .union([z.string(), z.unknown()])
        .describe(
          "Developer subagent's structured return — either a JSON string OR an already-parsed object.",
        ),
    },
    async ({ developerReturn }) => {
      try {
        const result = await runners.parseDeveloperReturn({ developerReturn });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_6_parse_dev_return', err);
      }
    },
  );

  // ── Step 7 — Build review prompts ───────────────────────────────────
  server.tool(
    'pipeline_step_7_build_review_prompts',
    'RFC-0012 Step 7: capture the PR diff + changed files and render 3 reviewer-specific prompts (code, test, security).',
    {
      taskId: z.string(),
      task: taskSpecSchema,
      branch: z.string(),
      worktreePath: z.string(),
      workDir: z.string(),
      codexAvailable: z
        .boolean()
        .optional()
        .describe('Override the codex-availability detection (test injection).'),
    },
    async ({ taskId, task, branch, worktreePath, workDir, codexAvailable }) => {
      try {
        const result = await runners.buildReviewPrompts({
          taskId,
          task,
          branch,
          worktreePath,
          workDir,
          codexAvailable,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_7_build_review_prompts', err);
      }
    },
  );

  // ── Step 8 — Aggregate verdicts ─────────────────────────────────────
  server.tool(
    'pipeline_step_8_aggregate_verdicts',
    'RFC-0012 Step 8: aggregate the three reviewer verdicts into a single APPROVED / CHANGES_REQUESTED gate decision.',
    {
      verdicts: z.array(reviewerVerdictSchema).describe('Reviewer verdicts to aggregate.'),
      harnessNote: z
        .string()
        .optional()
        .describe('Optional harness independence note (prepended to the aggregated summary).'),
    },
    async ({ verdicts, harnessNote }) => {
      try {
        const result = await runners.aggregateVerdicts({ verdicts, harnessNote });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_8_aggregate_verdicts', err);
      }
    },
  );

  // ── Step 9 — Iterate review loop ────────────────────────────────────
  server.tool(
    'pipeline_step_9_iterate',
    'RFC-0012 Step 9: review-iteration loop. Re-spawns developer + 3 reviewers up to maxIterations on CHANGES_REQUESTED. Resolves the default SubagentSpawner (RFC-0012 §8.3) when none is supplied.',
    {
      taskId: z.string(),
      worktreePath: z.string(),
      task: taskSpecSchema,
      branch: z.string(),
      initialDeveloperReturn: developerReturnSchema,
      initialVerdict: aggregatedVerdictSchema,
      maxIterations: z
        .number()
        .optional()
        .describe(
          'Cap on TOTAL iterations (defaults to 2 = max one retry after CHANGES_REQUESTED).',
        ),
    },
    async ({
      taskId,
      worktreePath,
      task,
      branch,
      initialDeveloperReturn,
      initialVerdict,
      maxIterations,
    }) => {
      try {
        const spawner = await spawnerFactory();
        const result = await runners.iterateReviewLoop({
          taskId,
          worktreePath,
          task,
          branch,
          initialDeveloperReturn,
          initialVerdict,
          maxIterations,
          spawner,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_9_iterate', err);
      }
    },
  );

  // ── Step 10 — Finalize ──────────────────────────────────────────────
  server.tool(
    'pipeline_step_10_finalize',
    'RFC-0012 Step 10: build acceptanceCriteriaCheck + finalSummary, flip task to Done, move tasks/→completed/, sign attestation (if helper available), and create the chore commit.',
    {
      taskId: z.string(),
      workDir: z.string(),
      worktreePath: z.string(),
      task: taskSpecSchema,
      developerReturn: developerReturnSchema,
      verdict: aggregatedVerdictSchema,
      iterations: z.number().describe('Total iterations from Step 9.'),
      signAttestationScript: z
        .string()
        .optional()
        .describe('Path to sign-attestation.mjs (defaults to detection by env var).'),
      skipCommit: z
        .boolean()
        .optional()
        .describe('Skip the chore commit (useful in tests without a real git repo).'),
    },
    async ({
      taskId,
      workDir,
      worktreePath,
      task,
      developerReturn,
      verdict,
      iterations,
      signAttestationScript,
      skipCommit,
    }) => {
      try {
        const result = await runners.finalizeTask({
          taskId,
          workDir,
          worktreePath,
          task,
          developerReturn,
          verdict,
          iterations,
          signAttestationScript,
          skipCommit,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_10_finalize', err);
      }
    },
  );

  // ── Step 11 — Push and PR ───────────────────────────────────────────
  server.tool(
    'pipeline_step_11_push_and_pr',
    'RFC-0012 Step 11: push the worktree branch and open the GitHub PR. NEVER force-pushes.',
    {
      taskId: z.string(),
      workDir: z.string(),
      worktreePath: z.string(),
      branch: z.string(),
      task: taskSpecSchema,
      developerReturn: developerReturnSchema,
      verdict: aggregatedVerdictSchema,
      needsHumanAttention: z
        .boolean()
        .optional()
        .describe('Tag the PR title with [needs-human-attention] when iteration cap was exceeded.'),
    },
    async ({
      taskId,
      workDir,
      worktreePath,
      branch,
      task,
      developerReturn,
      verdict,
      needsHumanAttention,
    }) => {
      try {
        const result = await runners.pushAndPr({
          taskId,
          workDir,
          worktreePath,
          branch,
          task,
          developerReturn,
          verdict,
          needsHumanAttention,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_11_push_and_pr', err);
      }
    },
  );

  // ── Step 12 — Sibling PRs ───────────────────────────────────────────
  server.tool(
    'pipeline_step_12_sibling_prs',
    'RFC-0012 Step 12: open companion PRs in sibling repos for any developer.filesChangedExternal entries.',
    {
      taskId: z.string(),
      workDir: z.string(),
      task: taskSpecSchema,
      developerReturn: developerReturnSchema,
      mainPrUrl: z.string().describe('URL of the main PR opened by Step 11.'),
    },
    async ({ taskId, workDir, task, developerReturn, mainPrUrl }) => {
      try {
        const result = await runners.siblingPrs({
          taskId,
          workDir,
          task,
          developerReturn,
          mainPrUrl,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_12_sibling_prs', err);
      }
    },
  );

  // ── Step 13 — Cleanup ───────────────────────────────────────────────
  server.tool(
    'pipeline_step_13_cleanup',
    'RFC-0012 Step 13: cleanup the per-worktree .active-task sentinel. Always runs (success / failure / rollback).',
    {
      taskId: z.string(),
      worktreePath: z.string(),
    },
    async ({ taskId, worktreePath }) => {
      try {
        const result = await runners.cleanupTask({ taskId, worktreePath });
        return jsonResult(result);
      } catch (err) {
        return errorResult('pipeline_step_13_cleanup', err);
      }
    },
  );
}
