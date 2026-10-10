/**
 * The staged review pipeline, as five phases the coordinator drives in order:
 *
 *   1. {@link prepareStagedReview}   risk map, baseline, fallback plan, planner prompt
 *   2. {@link planStagedReview}      validate the planner's plan (one retry, then fallback)
 *   3. {@link executeStagedReview}   run the probes, collect evidence and probe transcripts
 *   4. {@link buildSynthesizerPrompt} via {@link synthesizerPromptForRun}
 *   5. {@link finalizeStagedReview}  validate and ground the verdict, write the leaf manifest
 *
 * The planner and synthesizer are model calls the coordinator makes between phases
 * (agents `review-planner` and `review-synthesizer`, on the models their routing cells
 * resolve to). Every phase reads what it needs from the run directory the phase before it
 * wrote (see `run-store.ts`), so nothing is carried in memory.
 *
 * FAIL CLOSED. The staged review runs only when every input is one it can review: trusted
 * `backlog` work, a readable diff, a risk map that validates, and a baseline plan whose
 * every probe passes the same safety checks a model-written plan gets. If any of that
 * fails, {@link prepareStagedReview} returns `ok: false` with the rejections, records them
 * in the dispatch record, and the existing reviewer set handles the change. A synthesizer
 * verdict that does not validate does the same in {@link finalizeStagedReview}. The staged
 * review never runs a degraded plan and never approves on a verdict it could not read.
 *
 * @module review-staged/pipeline
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '@ai-sdlc/reference';
import { now } from '../clock.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { buildRiskMap, type BuildRiskMapOpts } from '../review-risk-map/build.js';
import type { ReviewRiskMap } from '../review-risk-map/types.js';
import { buildBaselineProbes, BaselineInputError } from '../review-plan/baseline.js';
import {
  loadStagedReviewConfig,
  toPlanLimits,
  type LoadStagedConfigOpts,
  type StagedReviewConfig,
} from '../review-plan/config.js';
import { buildFallbackPlanFor } from '../review-plan/fallback.js';
import {
  executePlan,
  type EvidenceBundle,
  type ExecutorHooks,
  type ExecutorLimits,
  type ProbeSpawner,
  type ProbeTranscript,
} from '../review-plan/executor.js';
import type {
  Baseline,
  PlanLimits,
  Rejection,
  ReviewPlan,
  TaskInput,
} from '../review-plan/types.js';
import { validatePlan } from '../review-plan/validate.js';
import { groundFindings, uncoveredHunkIds } from '../review-synth/ground.js';
import { buildPlannerPrompt, buildSynthesizerPrompt } from '../review-synth/prompts.js';
import type { StagedVerdict } from '../review-synth/types.js';
import { validateStagedVerdict } from '../review-synth/verdict.js';
import { assertSeal, computeSeal } from './seal.js';
import { isHighRisk } from '../review-plan/baseline.js';
import { StagedProbeSpawner } from './probe-spawner.js';
import {
  RUN_FILES,
  clearRun,
  readRunJson,
  stagedRunDir,
  updateDispatchRecord,
  writeRunJson,
  writeRunText,
  type ProbeCounts,
} from './run-store.js';
import { buildLeafManifest, executeTranscriptFiles, type ExecuteLeafSource } from './leaves.js';
import { toReviewerVerdict } from './verdict.js';
import type { EvaluateJudgmentContext } from '@ai-sdlc/reference';
import type { StructuralProvider } from '../review-risk-map/structural.js';
import type { RiskMapVerifications } from '../review-risk-map/types.js';

/** Source kinds the staged review may run for. Everything else uses the existing set. */
const TRUSTED_SOURCE_KINDS: readonly string[] = ['backlog'];

/** Cap on text from a thrown error that goes into a record. */
const MAX_DETAIL = 300;

function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text).replace(/\s+/g, ' ').slice(0, MAX_DETAIL);
}

// ── Task input persisted at prepare time ─────────────────────────────────

interface StoredTask {
  taskId: string;
  sourceKind: string;
  worktreePath: string;
  baseRef: string;
  headSha: string;
  mergeBase: string;
  acceptanceCriteria: string[];
  references: string[];
}

// ── 1. prepare ───────────────────────────────────────────────────────────

export interface PrepareStagedReviewOpts {
  taskId: string;
  /** The task's worktree: the repository root the review reads. */
  worktreePath: string;
  sourceKind: string;
  artifactsDir: string;
  acceptanceCriteria: readonly string[];
  /** The task's declared references, for the out-of-scope search probe. */
  references: readonly string[];
  /** Ref the diff is taken against and the config is read from. Default `origin/main`. */
  baseRef?: string;
  /** The unified diff. Read from git when omitted. */
  diff?: string;
  judgment?: EvaluateJudgmentContext;
  structural?: StructuralProvider;
  verifications?: RiskMapVerifications;
  /** Test injection for the base-ref config reader. */
  readBaseConfig?: LoadStagedConfigOpts['readBaseConfig'];
  runner?: Runner;
  now?: () => Date;
}

export type PrepareStagedReviewResult =
  | {
      ok: true;
      runDir: string;
      plannerPromptPath: string;
      baselineVersion: string;
      baselineProbes: number;
      /** Carry this into `plan`; it binds the control files written by prepare. */
      seal: string;
    }
  | {
      ok: false;
      runDir: string;
      reason: string;
      rejections: Rejection[];
      /** The set that handles the change instead. */
      fallbackSet: 'three';
    };

async function git(runner: Runner, cwd: string, args: string[]): Promise<string | undefined> {
  const r = await runner('git', args, { cwd, allowFailure: true, timeout: 60_000 });
  return r.code === 0 ? r.stdout : undefined;
}

export async function prepareStagedReview(
  opts: PrepareStagedReviewOpts,
): Promise<PrepareStagedReviewResult> {
  const runner = opts.runner ?? defaultRunner;
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  const base = { taskId: opts.taskId, sourceKind: opts.sourceKind };
  // A new review starts from nothing: files from an earlier run must not feed this one.
  await clearRun(runDir);

  const fallback = async (
    reason: string,
    rejections: Rejection[],
  ): Promise<PrepareStagedReviewResult> => {
    await updateDispatchRecord(
      runDir,
      base,
      { status: 'fallback', fallbackSet: 'three', reason, rejections },
      opts.now,
    );
    return { ok: false, runDir, reason, rejections, fallbackSet: 'three' };
  };
  const unreviewable = (detail: string): Rejection[] => [
    {
      reason: 'unreviewable-input',
      detail: `the change cannot be reviewed by the staged set; use the existing reviewer set (${detail})`,
    },
  ];

  if (!TRUSTED_SOURCE_KINDS.includes(opts.sourceKind)) {
    return fallback('untrusted-source', unreviewable(`sourceKind ${opts.sourceKind}`));
  }

  const baseRef = opts.baseRef ?? 'origin/main';
  let diff = opts.diff;
  if (diff === undefined) {
    diff = await git(runner, opts.worktreePath, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      `${baseRef}...HEAD`,
    ]);
  }
  if (diff === undefined || diff.trim() === '') {
    return fallback('diff-unavailable', unreviewable('the diff could not be read or is empty'));
  }
  const headSha = (await git(runner, opts.worktreePath, ['rev-parse', 'HEAD']))?.trim() ?? '';
  const mergeBase =
    (await git(runner, opts.worktreePath, ['merge-base', baseRef, 'HEAD']))?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(headSha) || !/^[0-9a-f]{40,64}$/.test(mergeBase)) {
    return fallback(
      'revisions-unresolved',
      unreviewable('HEAD or the merge-base is not resolvable'),
    );
  }

  const config: StagedReviewConfig = loadStagedReviewConfig({
    workDir: opts.worktreePath,
    baseRef,
    ...(opts.readBaseConfig ? { readBaseConfig: opts.readBaseConfig } : {}),
  });
  const task: TaskInput = { references: [...opts.references] };

  let riskMap: ReviewRiskMap;
  try {
    const riskOpts: BuildRiskMapOpts = {
      acceptanceCriteria: opts.acceptanceCriteria,
      artifactsDir: opts.artifactsDir,
      runId: opts.taskId,
      sourceKind: opts.sourceKind,
      taskId: opts.taskId,
      flagThreshold: config.riskThreshold,
      ...(opts.judgment ? { judgment: opts.judgment } : {}),
      ...(opts.structural ? { structural: opts.structural } : {}),
      ...(opts.verifications ? { verifications: opts.verifications } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    };
    riskMap = (await buildRiskMap(diff, riskOpts)).map;
  } catch (err) {
    return fallback('risk-map-failed', unreviewable(detailOf(err)));
  }

  const limits = toPlanLimits(config, opts.worktreePath, mergeBase);
  const baselineOpts = {
    riskThreshold: config.riskThreshold,
    commandAllowlist: config.commandAllowlist,
  };
  // The fallback plan is the baseline plus a read per uncovered hunk, with every probe held to
  // the safety checks a model-written plan gets. If it cannot be built, no plan can be, and the
  // staged review must not run.
  const fb = buildFallbackPlanFor(riskMap, task, baselineOpts, limits);
  if (!fb.ok) {
    return fallback('no-safe-plan', fb.rejections);
  }
  let baseline: Baseline;
  try {
    baseline = buildBaselineProbes(riskMap, task, baselineOpts);
  } catch (err) {
    if (!(err instanceof BaselineInputError)) throw err;
    return fallback('no-safe-plan', unreviewable(detailOf(err)));
  }

  const planner = buildPlannerPrompt({
    riskMap,
    diff,
    acceptanceCriteria: opts.acceptanceCriteria,
    baseline,
    limits: { maxProbes: config.maxProbes, riskThreshold: config.riskThreshold },
  });

  const stored: StoredTask = {
    taskId: opts.taskId,
    sourceKind: opts.sourceKind,
    worktreePath: opts.worktreePath,
    baseRef,
    headSha,
    mergeBase,
    acceptanceCriteria: [...opts.acceptanceCriteria],
    references: [...opts.references],
  };
  await writeRunJson(runDir, RUN_FILES.task, stored);
  await writeRunJson(runDir, RUN_FILES.config, config);
  await writeRunJson(runDir, RUN_FILES.riskMap, riskMap);
  await writeRunJson(runDir, RUN_FILES.baseline, baseline);
  await writeRunJson(runDir, RUN_FILES.fallbackPlan, fb.plan);
  await writeRunJson(runDir, RUN_FILES.plannerTruncation, planner.truncation);
  const plannerPromptPath = await writeRunText(runDir, RUN_FILES.plannerPrompt, planner.prompt);
  await updateDispatchRecord(
    runDir,
    base,
    { status: 'prepared', rejections: [], reason: undefined, fallbackSet: undefined },
    opts.now,
  );
  return {
    ok: true,
    runDir,
    plannerPromptPath,
    baselineVersion: baseline.version,
    baselineProbes: baseline.probes.length,
    seal: await computeSeal(runDir, 'prepare'),
  };
}

/**
 * Record that the staged review cannot run for a reason found before `prepare` could
 * (the task file was unreadable, say), so the dispatch record still says why the existing
 * set handled the change.
 */
export async function recordStagedFallback(opts: {
  taskId: string;
  sourceKind: string;
  artifactsDir: string;
  reason: string;
  detail: string;
  now?: () => Date;
}): Promise<Extract<PrepareStagedReviewResult, { ok: false }>> {
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  await clearRun(runDir);
  const rejections: Rejection[] = [
    {
      reason: 'unreviewable-input',
      detail: `the change cannot be reviewed by the staged set; use the existing reviewer set (${opts.detail})`,
    },
  ];
  await updateDispatchRecord(
    runDir,
    { taskId: opts.taskId, sourceKind: opts.sourceKind },
    { status: 'fallback', fallbackSet: 'three', reason: opts.reason, rejections },
    opts.now,
  );
  return { ok: false, runDir, reason: opts.reason, rejections, fallbackSet: 'three' };
}

// ── 2. plan ──────────────────────────────────────────────────────────────

export interface PlanStagedReviewOpts {
  taskId: string;
  artifactsDir: string;
  /** The planner's final message. Absent or unparseable counts as a rejected attempt. */
  plannerOutput: string | undefined;
  /** 1 for the first output, 2 for the re-request. A rejected second attempt uses the fallback. */
  attempt: 1 | 2;
  /** The seal `prepare` printed. */
  seal: string | undefined;
  now?: () => Date;
}

export type PlanStagedReviewResult =
  | {
      status: 'planned';
      source: 'planner' | 'fallback';
      probes: number;
      rejections: Rejection[];
      /** Carry this into `execute`. */
      seal: string;
    }
  | { status: 'retry'; rejections: Rejection[]; retryNote: string };

/** Pull the JSON object out of a model's final message, tolerating a code fence. */
export function extractJsonObject(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first < 0 || last <= first) return undefined;
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
}

function retryNoteFor(rejections: readonly Rejection[]): string {
  const lines = rejections
    .slice(0, 20)
    .map((r) => `- ${r.reason}${r.probeId ? ` (${r.probeId})` : ''}: ${redactSecrets(r.detail)}`);
  return [
    'Your plan was rejected for these reasons. Return a corrected plan as the same single JSON',
    'object. Do not remove or alter a baseline probe, and cover every high-risk hunk.',
    ...lines,
  ].join('\n');
}

export async function planStagedReview(
  opts: PlanStagedReviewOpts,
): Promise<PlanStagedReviewResult> {
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  await assertSeal(runDir, 'prepare', opts.seal);
  const task = await readRunJson<StoredTask>(runDir, RUN_FILES.task);
  const base = { taskId: task.taskId, sourceKind: task.sourceKind };
  const riskMap = await readRunJson<ReviewRiskMap>(runDir, RUN_FILES.riskMap);
  const baseline = await readRunJson<Baseline>(runDir, RUN_FILES.baseline);
  const config = await readRunJson<StagedReviewConfig>(runDir, RUN_FILES.config);
  const limits: PlanLimits = toPlanLimits(config, task.worktreePath, task.mergeBase);

  const candidate = extractJsonObject(opts.plannerOutput);
  let rejections: Rejection[];
  if (candidate === undefined) {
    rejections = [{ reason: 'schema-invalid', detail: 'the planner output was not a JSON object' }];
  } else {
    const checked = validatePlan(candidate, baseline, riskMap, limits);
    if (checked.valid) {
      const plan = candidate as ReviewPlan;
      await writeRunJson(runDir, RUN_FILES.plan, plan);
      await updateDispatchRecord(
        runDir,
        base,
        {
          status: 'planned',
          planSource: 'planner',
          plannerAttempts: opts.attempt,
          planRejections: [],
        },
        opts.now,
      );
      return {
        status: 'planned',
        source: 'planner',
        probes: plan.probes.length,
        rejections: [],
        seal: await computeSeal(runDir, 'plan'),
      };
    }
    rejections = checked.rejections;
  }

  if (opts.attempt === 1) {
    await updateDispatchRecord(
      runDir,
      base,
      { plannerAttempts: 1, planRejections: rejections },
      opts.now,
    );
    return { status: 'retry', rejections, retryNote: retryNoteFor(rejections) };
  }

  // Rejected twice: the plan is the code-built fallback, never a partially accepted one.
  const fallbackPlan = await readRunJson<ReviewPlan>(runDir, RUN_FILES.fallbackPlan);
  await writeRunJson(runDir, RUN_FILES.plan, fallbackPlan);
  await updateDispatchRecord(
    runDir,
    base,
    { status: 'planned', planSource: 'fallback', plannerAttempts: 2, planRejections: rejections },
    opts.now,
  );
  return {
    status: 'planned',
    source: 'fallback',
    probes: fallbackPlan.probes.length,
    rejections,
    seal: await computeSeal(runDir, 'plan'),
  };
}

// ── 3. execute ───────────────────────────────────────────────────────────

export interface ExecuteStagedReviewOpts {
  taskId: string;
  artifactsDir: string;
  /** The seal `plan` printed. */
  seal: string | undefined;
  /** The model from the `review-executor` routing cell. Executor default when omitted. */
  executorModel?: string;
  /** Production adapters by default. */
  spawner?: ProbeSpawner;
  /** Whether the Codex harness may run eligible probes. Default: a Codex bridge is configured. */
  codexAvailable?: boolean;
  hooks?: ExecutorHooks;
  limits?: Partial<ExecutorLimits>;
  now?: () => Date;
}

export interface ExecuteStagedReviewResult {
  evidencePath: string;
  probes: ProbeCounts;
  /** Probe transcripts that were written, one per probe that ran a model. */
  transcripts: number;
  /** Carry this into `synth-prompt` and `finalize`. */
  seal: string;
}

export function countProbes(bundle: EvidenceBundle): ProbeCounts {
  const counts: ProbeCounts = {
    total: bundle.entries.length,
    ok: 0,
    failed: 0,
    refused: 0,
    skipped: 0,
  };
  for (const e of bundle.entries) counts[e.status] += 1;
  return counts;
}

/** The transcript of one probe, in the JSONL event shape the other reviewer transcripts use. */
function transcriptJsonl(t: ProbeTranscript, at: string): string {
  const lines = [
    {
      role: 'user',
      content: t.prompt,
      timestamp: at,
      event: 'prompt-received',
      probeId: t.probeId,
      probeType: t.probeType,
    },
    {
      role: 'assistant',
      content: t.output,
      timestamp: at,
      event: 'probe-answered',
      probeId: t.probeId,
      status: t.status,
      harness: t.harness,
      model: t.model,
      agent: t.agent,
      latencyMs: t.latencyMs,
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export async function executeStagedReview(
  opts: ExecuteStagedReviewOpts,
): Promise<ExecuteStagedReviewResult> {
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  await assertSeal(runDir, 'plan', opts.seal);
  const task = await readRunJson<StoredTask>(runDir, RUN_FILES.task);
  const base = { taskId: task.taskId, sourceKind: task.sourceKind };
  const plan = await readRunJson<ReviewPlan>(runDir, RUN_FILES.plan);
  const config = await readRunJson<StagedReviewConfig>(runDir, RUN_FILES.config);

  const spawner = opts.spawner ?? new StagedProbeSpawner();
  const codexAvailable =
    opts.codexAvailable ?? (spawner instanceof StagedProbeSpawner && spawner.codexConfigured);
  const trusted = TRUSTED_SOURCE_KINDS.includes(task.sourceKind);

  const limits: ExecutorLimits = {
    repoRoot: task.worktreePath,
    commandAllowlist: config.commandAllowlist,
    mergeBase: task.mergeBase,
    totalBytes: config.evidenceBudgetBytes,
    ...(opts.executorModel ? { model: opts.executorModel } : {}),
    // Run probes execute the repository's own scripts as the operator, so they run only for
    // trusted work. Everything else is refused by the executor.
    runTrusted: trusted,
    codex: { available: codexAvailable, trusted },
    ...opts.limits,
  };

  const written: ExecuteLeafSource[] = [];
  const stamp = (opts.now ?? now)().toISOString();
  const files = executeTranscriptFiles(task.worktreePath, task.taskId);
  await mkdir(files.transcriptDir, { recursive: true });
  await mkdir(files.verdictDir, { recursive: true });

  const hooks: ExecutorHooks = {
    ...opts.hooks,
    captureTranscript: async (t) => {
      const paths = files.forProbe(t.probeId);
      await writeFile(paths.transcriptPath, transcriptJsonl(t, stamp), 'utf8');
      // An execute leaf carries no verdict. The stub keeps the file `emit-leaf` reads in a
      // known shape; the leaf is written with zero findings and `verdictApproved: false`
      // whatever it says.
      await writeFile(
        paths.verdictPath,
        JSON.stringify({
          approved: false,
          findings: [],
          summary: `execute stage evidence for probe ${t.probeId}`,
        }),
        'utf8',
      );
      written.push({
        probeId: t.probeId,
        transcriptPath: paths.transcriptPath,
        verdictPath: paths.verdictPath,
        harness: t.harness,
        model: t.model,
      });
      await opts.hooks?.captureTranscript?.(t);
    },
  };

  const bundle = await executePlan(plan, spawner, limits, hooks);
  const evidencePath = await writeRunJson(runDir, RUN_FILES.evidence, bundle);
  written.sort((a, b) => (a.probeId < b.probeId ? -1 : 1));
  await writeRunJson(runDir, RUN_FILES.executeLeaves, written);
  const probes = countProbes(bundle);
  await updateDispatchRecord(runDir, base, { status: 'executed', probes }, opts.now);
  return {
    evidencePath,
    probes,
    transcripts: written.length,
    seal: await computeSeal(runDir, 'execute'),
  };
}

// ── 4. synthesizer prompt ────────────────────────────────────────────────

export async function synthesizerPromptForRun(opts: {
  taskId: string;
  artifactsDir: string;
  /** The seal `execute` printed. */
  seal: string | undefined;
}): Promise<{ promptPath: string }> {
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  await assertSeal(runDir, 'execute', opts.seal);
  const task = await readRunJson<StoredTask>(runDir, RUN_FILES.task);
  const riskMap = await readRunJson<ReviewRiskMap>(runDir, RUN_FILES.riskMap);
  const plan = await readRunJson<ReviewPlan>(runDir, RUN_FILES.plan);
  const evidence = await readRunJson<EvidenceBundle>(runDir, RUN_FILES.evidence);
  const result = buildSynthesizerPrompt({
    riskMap,
    plan,
    evidence,
    acceptanceCriteria: task.acceptanceCriteria,
  });
  await writeRunJson(runDir, RUN_FILES.synthesizerTruncation, result.truncation);
  return { promptPath: await writeRunText(runDir, RUN_FILES.synthesizerPrompt, result.prompt) };
}

// ── 5. finalize ──────────────────────────────────────────────────────────

export interface FinalizeStagedReviewOpts {
  taskId: string;
  artifactsDir: string;
  /** The seal `execute` printed. */
  seal: string | undefined;
  /** The synthesizer's final message. */
  synthesizerOutput: string | undefined;
  /** Models the planner and synthesizer ran on, recorded on their leaves. */
  plannerModel?: string;
  synthesizerModel?: string;
  now?: () => Date;
}

export type FinalizeStagedReviewResult =
  | {
      ok: true;
      verdict: StagedVerdict;
      /** The verdict in the shape Step 8 aggregates. */
      reviewerVerdict: ReturnType<typeof toReviewerVerdict>;
      verdictPath: string;
      leavesPath: string;
      uncoveredHunks: string[];
      dropped: number;
    }
  | { ok: false; reason: string; rejections: Rejection[]; fallbackSet: 'three' };

export async function finalizeStagedReview(
  opts: FinalizeStagedReviewOpts,
): Promise<FinalizeStagedReviewResult> {
  const runDir = stagedRunDir(opts.artifactsDir, opts.taskId);
  await assertSeal(runDir, 'execute', opts.seal);
  const task = await readRunJson<StoredTask>(runDir, RUN_FILES.task);
  const base = { taskId: task.taskId, sourceKind: task.sourceKind };
  const riskMap = await readRunJson<ReviewRiskMap>(runDir, RUN_FILES.riskMap);
  const plan = await readRunJson<ReviewPlan>(runDir, RUN_FILES.plan);
  const evidence = await readRunJson<EvidenceBundle>(runDir, RUN_FILES.evidence);
  const config = await readRunJson<StagedReviewConfig>(runDir, RUN_FILES.config);

  const parsed = extractJsonObject(opts.synthesizerOutput);
  const shape = validateStagedVerdict(parsed);
  if (!shape.valid) {
    const rejections: Rejection[] = [
      {
        reason: 'schema-invalid',
        detail: `the synthesizer verdict is not valid: ${shape.errors.slice(0, 5).join('; ')}`,
      },
      {
        reason: 'unreviewable-input',
        detail: 'the staged review produced no verdict; use the existing reviewer set',
      },
    ];
    await updateDispatchRecord(
      runDir,
      base,
      { status: 'fallback', fallbackSet: 'three', reason: 'invalid-verdict', rejections },
      opts.now,
    );
    return { ok: false, reason: 'invalid-verdict', rejections, fallbackSet: 'three' };
  }

  // Fail closed: a verdict that rests on no evidence, or that leaves a high-risk hunk with
  // no probe evidence, is not a review of this change. The existing set handles it.
  const probeCounts = countProbes(evidence);
  const uncoveredAll = uncoveredHunkIds(
    riskMap.hunks.map((h) => h.id),
    plan.probes,
    evidence,
  );
  const uncoveredHigh = riskMap.hunks
    .filter((h) => uncoveredAll.includes(h.id) && isHighRisk(h, config.riskThreshold))
    .map((h) => h.id);
  if (probeCounts.ok === 0 || uncoveredHigh.length > 0) {
    const detail =
      probeCounts.ok === 0
        ? 'no probe returned evidence, so the verdict rests on nothing'
        : `high-risk hunk(s) have no probe evidence: ${uncoveredHigh.slice(0, 10).join(', ')}`;
    const rejections: Rejection[] = [
      { reason: 'unreviewable-input', detail: `${detail}; use the existing reviewer set` },
    ];
    await updateDispatchRecord(
      runDir,
      base,
      {
        status: 'fallback',
        fallbackSet: 'three',
        reason: 'insufficient-evidence',
        rejections,
        probes: probeCounts,
        uncoveredHunks: uncoveredAll,
      },
      opts.now,
    );
    return { ok: false, reason: 'insufficient-evidence', rejections, fallbackSet: 'three' };
  }

  const grounded = groundFindings(parsed as StagedVerdict, evidence);
  const kept = grounded.verdict;
  const blocking = kept.findings.some((f) => f.severity === 'critical' || f.severity === 'major');
  // Tighten only: a screen that did not come back clean marks the verdict, and a verdict
  // that still holds a blocking finding after grounding is not approved.
  const verdict: StagedVerdict = {
    ...kept,
    approved: kept.approved && !blocking,
    promptInjectionDetected:
      kept.promptInjectionDetected || riskMap.injectionScreen.status === 'suspicious',
  };
  const uncovered = uncoveredAll;
  const reviewerVerdict = toReviewerVerdict(verdict, uncovered);

  const verdictPath = await writeRunJson(runDir, RUN_FILES.verdict, verdict);
  await writeRunJson(runDir, RUN_FILES.reviewerVerdict, reviewerVerdict);
  const executeLeaves = await readRunJson<ExecuteLeafSource[]>(runDir, RUN_FILES.executeLeaves);
  const manifest = buildLeafManifest({
    worktreePath: task.worktreePath,
    taskId: task.taskId,
    executeLeaves,
    ...(opts.plannerModel ? { plannerModel: opts.plannerModel } : {}),
    ...(opts.synthesizerModel ? { synthesizerModel: opts.synthesizerModel } : {}),
  });
  // `emit-leaf` reads the verdict the leaf carries from this file, so it holds the grounded
  // verdict (what Step 8 aggregates), not the synthesizer's raw output.
  await mkdir(join(task.worktreePath, '.ai-sdlc', 'verdicts'), { recursive: true });
  await writeFile(
    manifest.synthesizeVerdictPath,
    JSON.stringify({
      approved: verdict.approved,
      findings: verdict.findings,
      summary: verdict.summary,
    }),
    'utf8',
  );
  const leavesPath = await writeRunJson(runDir, RUN_FILES.leaves, manifest.leaves);
  await updateDispatchRecord(
    runDir,
    base,
    {
      status: 'finalized',
      droppedFindings: grounded.dropped.length,
      uncoveredHunks: uncovered,
    },
    opts.now,
  );
  return {
    ok: true,
    verdict,
    reviewerVerdict,
    verdictPath,
    leavesPath,
    uncoveredHunks: uncovered,
    dropped: grounded.dropped.length,
  };
}
