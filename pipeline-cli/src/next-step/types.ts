/**
 * Types for the `ai-sdlc-pipeline next-step` state machine (AISDLC-762).
 *
 * The slash command body used to narrate Steps 0-15 as prose that the model
 * executed one shell block at a time (about 160 LLM round-trips per task).
 * `next-step` runs every deterministic step itself and hands the model ONE
 * small JSON instruction, only when an LLM action (an Agent call) is needed.
 *
 * @module next-step/types
 */

import type { Runner } from '../runtime/exec.js';
import type { ResumeReviewDecision } from './resume-decision.js';
import type { WorkflowRunState } from '../workflow/engine.js';
import type {
  AggregatedVerdict,
  DeveloperReturn,
  PipelineLogger,
  ReviewerType,
  ReviewerVerdict,
  TaskSpec,
} from '../types.js';

/** Phase the machine is parked in, waiting for the model to report a result. */
export type NextStepPhase = 'awaiting-developer' | 'awaiting-reviewers' | 'done' | 'aborted';

/** Terminal outcomes (superset of the old return-value `outcome` field). */
export type NextStepOutcome =
  | 'approved'
  | 'needs-human-attention'
  | 'developer-failed'
  | 'developer-json-contract-violated'
  | 'aborted';

/** One reviewer the model is asked to spawn. */
export interface SpawnedReviewer {
  /** Role (`code-reviewer`, `security-reviewer`, ...); the staged model stages for RFC-0052. */
  reviewer: ReviewerType | StagedModelAgent;
  /** Agent to spawn (the codex variant by default for code/test review). */
  agent: string;
  /** Harness label recorded on the transcript leaf. */
  harness: 'claude-code' | 'codex';
  /** Model recorded on the transcript leaf. */
  leafModel: string;
  /** Model to pass to the Agent call (omitted when the route is the default arm). */
  model?: string;
  /** File holding the full reviewer prompt, nonce marker included. */
  promptFile: string;
}

/** The two agents of the staged review that run a model beside the probe executors (RFC-0052). */
export type StagedModelAgent = 'review-planner' | 'review-synthesizer';

/**
 * Where the staged review of one round stands. Each stage is one `spawn-reviewers`
 * instruction with one agent; the standalone security reviewer runs LAST, after the
 * staged leaves are emitted, because it is Write-capable and reads the untrusted diff.
 */
export interface StagedRoundState {
  stage: 'plan' | 'synthesize' | 'security';
  /** The seal the last `cli-staged-review` phase printed. */
  seal: string;
  /** 1 or 2: which planner output is expected. */
  plannerAttempt: 1 | 2;
  plannerPromptFile: string;
  plannerModel: string;
  synthModel: string;
  /** Harness agent id and output file of the planner, kept for its transcript. */
  plannerAgentId?: string;
  plannerOutputFile?: string;
  /** The staged set's single grounded verdict, once finalized. */
  verdict?: ReviewerVerdict;
  /** The standalone security reviewer, spawned last (prompt built before the staged run). */
  security: SpawnedReviewer;
  /**
   * The classifier's normal reviewer set, spawned last beside the staged verdict (DEC-0149:
   * staged leaves are advisory and never satisfy the reviewer-set requirement). Empty or absent
   * means only `security` is spawned.
   */
  beside?: SpawnedReviewer[];
}

/** Everything the review-finalize wrapper needs to bind results to the prompts. */
export interface ReviewRoundState {
  round: number;
  /** Reviewers the model was asked to spawn this round. */
  spawned: SpawnedReviewer[];
  /** Reviewers whose approval was reused (incremental gate `unchanged`). */
  autoApproved: Array<{ agent: string; reviewedSha: string }>;
  headSha: string;
  nonce: string;
  harnessNote: string;
  classifier: { reviewers: string[]; confidence: number; fellOpen: boolean };
  incremental: {
    reason: string;
    skip: boolean;
    deltaOnly: boolean;
    deltaSize: number;
    lastReviewedSha: string | null;
    contentHash: string;
  };
  /** AISDLC-725: the shared round plan (without the delta diff) this round was built from. */
  roundPlan?: Omit<import('../incremental-review/review-rounds.js').ReviewRoundPlan, 'deltaDiff'>;
  /** Set while the staged review (RFC-0052) is driving this round. */
  staged?: StagedRoundState;
}

/** Durable state, JSON on disk between `next-step` invocations. */
export interface NextStepState {
  schemaVersion: 1;
  /** Task id exactly as given (`AISDLC-762`). */
  taskId: string;
  taskIdLower: string;
  sourceKind: 'backlog';
  phase: NextStepPhase;
  workDir: string;
  branch: string;
  worktreePath: string;
  task: TaskSpec;
  /** Status to restore when the developer cannot complete the task. */
  fromStatus: string;
  /** Developer pass counter (1-based, capped by `maxIterations`). */
  iteration: number;
  maxIterations: number;
  /** AISDLC-1086: developer rounds spent fixing a red machine verify run (capped by `maxIterations`). */
  verifyRounds?: number;
  developer: DeveloperReturn | null;
  /** AISDLC-947: the resume review decision, set only when the task resumed. */
  resumeReview?: ResumeReviewDecision;
  /** AISDLC-1053: a `reenter --developer-round` developer round is pending; consumed once it runs. */
  developerRoundPending?: boolean;
  review: ReviewRoundState | null;
  verdict: AggregatedVerdict | null;
  /** Set once the post-rebase re-review has been used, so it never loops. */
  postRebaseReviewed: boolean;
  needsHumanAttention: boolean;
  /** Classifier decision line for the PR body (set by the last review round). */
  classifierLine: string;
  /** Review rounds started so far (names the prompt files; distinct from `iteration`). */
  reviewRound: number;
  /** Count of `next-step` calls so far (orchestration LLM-call budget, AC-2). */
  calls: number;
  /** Rejected-but-fixable reviewer reports so far this round (capped). */
  reportRetries?: number;
  /** The instruction awaiting a result; re-emitted when `next-step` is called without one. */
  pending?: SpawnDeveloperInstruction | SpawnReviewersInstruction | FixReportInstruction;
  /** Final result once `phase` is `done` or `aborted`. */
  result?: DoneInstruction | StopInstruction;
  /** RFC-0056 phase 3: node records of a run driven by the workflow engine; absent for the Machine. */
  workflow?: WorkflowRunState;
}

/** Ask the model to spawn the developer agent. */
export interface SpawnDeveloperInstruction {
  action: 'spawn-developer';
  taskId: string;
  agent: 'developer';
  iteration: number;
  promptFile: string;
  cwd: string;
  model?: string;
  /** Report the agent's final message back with `next-step ... --result -`. */
  reply: string;
}

/** Ask the model to spawn the reviewers in ONE message (parallel Agent calls). */
export interface SpawnReviewersInstruction {
  action: 'spawn-reviewers';
  taskId: string;
  round: number;
  reviewers: Array<{
    agent: string;
    promptFile: string;
    /** Short prompt to pass as the Agent `prompt`; it names `promptFile` for the reviewer to read. */
    bootstrapPrompt: string;
    model?: string;
  }>;
  /** Shape of the result JSON the model must report. */
  replyShape: string;
  reply: string;
}

/**
 * The last reviewer report could not be used (not JSON, or a reviewer's agent id
 * is missing). Nothing irreversible happened: fix the REPORT and send it again.
 * Do not spawn the reviewers again.
 */
export interface FixReportInstruction {
  action: 'fix-report';
  taskId: string;
  round: number;
  reason: string;
  replyShape: string;
  reply: string;
}

/** The run finished (a PR exists, or the task is parked for a human). */
export interface DoneInstruction {
  action: 'done';
  taskId: string;
  branch: string;
  worktreePath: string;
  outcome: 'approved' | 'needs-human-attention';
  prUrl: string | null;
  siblingPrUrls: string[];
  iterations: number;
  developer: DeveloperReturn | null;
  reviews: {
    iterations: number;
    harnessNote: string;
    verdicts: Array<{
      agentId: string;
      harness: string;
      approved: boolean;
      findings: Record<'critical' | 'major' | 'minor' | 'suggestion', number>;
    }>;
  } | null;
  notes?: string;
}

/** The run cannot continue; the model reports `notes` to the operator. */
export interface StopInstruction {
  action: 'stop';
  taskId: string;
  outcome: 'aborted' | 'developer-failed' | 'developer-parked' | 'developer-json-contract-violated';
  reason: string;
  /** Cause code the executor passes to `cli-dispatch complete --cause` so the playbook can pick a step. */
  cause?: string;
  branch?: string;
  worktreePath?: string;
  prUrl: null;
  developer?: DeveloperReturn | null;
  notes?: string;
}

export type Instruction =
  | SpawnDeveloperInstruction
  | SpawnReviewersInstruction
  | FixReportInstruction
  | DoneInstruction
  | StopInstruction;

/** Injection points shared by every module so tests stay hermetic. */
export interface NextStepContext {
  workDir: string;
  runner: Runner;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  now: () => Date;
  logger: PipelineLogger;
  /** Directory holding `cli-*.mjs` and `ai-sdlc-pipeline.mjs`. */
  cliBinDir: string;
  /** Directory holding the plugin-internal scripts (`persist-reviewer-artifacts.sh`, ...). */
  pluginScriptsDir: string;
  /** Directory for prompt / diff / verdict scratch files of this run. */
  filesDir: string;
  /** Path of the state file, echoed in the `reply` command. */
  statePath: string;
  /** Existence probe (injectable). */
  exists: (path: string) => boolean;
}
