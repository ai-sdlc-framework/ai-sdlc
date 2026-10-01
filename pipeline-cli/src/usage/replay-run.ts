/**
 * Reviewer replay runner and scoring (RFC-0050 B4).
 *
 * For each corpus item the runner checks the reviewed commit out into a
 * temporary worktree, builds the same review prompt the pipeline builds, runs
 * the reviewer through an injected spawner with the candidate model, and
 * records block or approve. Nothing is written to the reviews ledger, the
 * transcript leaves, a verdict file or an attestation; the only writes are the
 * usage ledger (task id `replay`) and the results file the caller saves.
 *
 * Results hold counts and ids only: no prompt, response, diff or finding text.
 *
 * @module usage/replay-run
 */

import { recordModelCall, type ModelCallTokens, type UsageStoreOptions } from '@ai-sdlc/reference';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { buildReviewPrompts } from '../steps/07-build-review-prompts.js';
import { findTaskFile, parseTaskFile } from '../steps/01-validate.js';
import type { ReviewerType, SubagentResult, SubagentSpawner, TaskSpec } from '../types.js';
import {
  type CorpusItem,
  type ReplayLabel,
  type ReplayRole,
  REPLAY_ROLES,
} from './replay-corpus.js';
import { commitExists, isCommitId, withTempWorktree, type Git } from './replay-git.js';
import { unitsForTokens, type UnitWeights } from './units.js';

/** Task id every replay call is attributed to, so it never lands on a real task. */
export const REPLAY_TASK_ID = 'replay';

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

export function isValidModel(v: unknown): v is string {
  return typeof v === 'string' && MODEL_PATTERN.test(v);
}

export function isValidRole(v: unknown): v is ReplayRole {
  return (REPLAY_ROLES as readonly unknown[]).includes(v);
}

export function reviewerTypeFor(role: ReplayRole): ReviewerType {
  return `${role}-reviewer` as ReviewerType;
}

export type StopReason = 'completed' | 'max-items' | 'max-units' | 'interrupted';
export type ReplayOutcome = 'block' | 'approve' | 'error';

export interface ItemResult {
  taskId: string;
  commitSha: string;
  label: ReplayLabel;
  /** Outcome per model id. */
  outcomes: Record<string, ReplayOutcome>;
}

export interface ModelScore {
  model: string;
  role: ReplayRole;
  reviews: number;
  errors: number;
  knownDefect: { items: number; blocked: number };
  clean: { items: number; blocked: number };
  /** Share of known-defect items blocked; null with no known-defect item. */
  recall: number | null;
  /** Share of clean items blocked; null with no clean item. */
  falseBlockRate: number | null;
  unitsTotal: number;
  meanUnitsPerReview: number | null;
  /** Reviews whose spawner result carried no token counts. */
  usageMissing: number;
}

export interface ReplayResults {
  schemaVersion: 'v1';
  runId: string;
  generatedAt: string;
  role: ReplayRole;
  candidate: string;
  reference?: string;
  stoppedBy: StopReason;
  limits: { maxItems: number; maxUnits: number };
  itemsReplayed: number;
  skippedUnreachable: number;
  scores: ModelScore[];
  items: ItemResult[];
}

export interface SpawnerFactory {
  (opts: { model: string; type: ReviewerType }): SubagentSpawner;
}

export interface RunReplayInput {
  items: readonly CorpusItem[];
  role: ReplayRole;
  candidate: string;
  reference?: string;
  maxItems: number;
  maxUnits: number;
  repoRoot: string;
  repoName: string;
  git: Git;
  createSpawner: SpawnerFactory;
  weights: UnitWeights;
  usage: UsageStoreOptions;
  now: () => Date;
  runId: string;
  tmpRoot?: string;
  runner?: Runner;
  /** Aborted by a signal handler; the run stops before the next item. */
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

/** Alternate labels so a truncated run still sees both kinds of item. */
export function interleaveByLabel(items: readonly CorpusItem[]): CorpusItem[] {
  const defects = items.filter((i) => i.label === 'known-defect');
  const clean = items.filter((i) => i.label === 'clean');
  const out: CorpusItem[] = [];
  for (let i = 0; i < Math.max(defects.length, clean.length); i++) {
    if (defects[i]) out.push(defects[i] as CorpusItem);
    if (clean[i]) out.push(clean[i] as CorpusItem);
  }
  return out;
}

interface Verdict {
  outcome: ReplayOutcome;
}

/** Block when not approved or any critical or major finding; error when no verdict. */
export function verdictOf(result: SubagentResult): Verdict {
  if (result.status !== 'success') return { outcome: 'error' };
  const p = result.parsed as
    | { approved?: unknown; findings?: Array<{ severity?: unknown }> }
    | undefined;
  if (!p || typeof p !== 'object' || typeof p.approved !== 'boolean') return { outcome: 'error' };
  const findings = Array.isArray(p.findings) ? p.findings : [];
  const severe = findings.some((f) => {
    const s = typeof f?.severity === 'string' ? f.severity.toLowerCase() : '';
    return s === 'critical' || s === 'major';
  });
  return { outcome: p.approved && !severe ? 'approve' : 'block' };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Token counts from the CLI's JSON envelope, or undefined when it reports none. */
export function tokensFromOutput(output: string): ModelCallTokens | undefined {
  let env: unknown;
  try {
    env = JSON.parse(output);
  } catch {
    return undefined;
  }
  const usage = (env as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const creation = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const w5 = count(creation.ephemeral_5m_input_tokens);
  const w1 = count(creation.ephemeral_1h_input_tokens);
  const created = count(usage.cache_creation_input_tokens);
  const split = w5 + w1;
  return {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m: split > 0 ? w5 : created,
    cacheWrite1h: split > 0 ? w1 : 0,
  };
}

/** Score the outcomes of one model over the items it completed. */
export function scoreModel(
  model: string,
  role: ReplayRole,
  items: readonly ItemResult[],
  unitsByReview: readonly number[],
  usageMissing: number,
): ModelScore {
  let defects = 0;
  let defectsBlocked = 0;
  let clean = 0;
  let cleanBlocked = 0;
  let errors = 0;
  for (const it of items) {
    const o = it.outcomes[model];
    if (o === undefined) continue;
    if (o === 'error') {
      errors++;
      continue;
    }
    if (it.label === 'known-defect') {
      defects++;
      if (o === 'block') defectsBlocked++;
    } else {
      clean++;
      if (o === 'block') cleanBlocked++;
    }
  }
  const total = unitsByReview.reduce((a, b) => a + b, 0);
  return {
    model,
    role,
    reviews: defects + clean,
    errors,
    knownDefect: { items: defects, blocked: defectsBlocked },
    clean: { items: clean, blocked: cleanBlocked },
    recall: defects > 0 ? defectsBlocked / defects : null,
    falseBlockRate: clean > 0 ? cleanBlocked / clean : null,
    unitsTotal: total,
    meanUnitsPerReview: unitsByReview.length > 0 ? total / unitsByReview.length : null,
    usageMissing,
  };
}

function loadTask(taskId: string, worktree: string): TaskSpec {
  try {
    const file = findTaskFile(taskId, worktree);
    if (file) return parseTaskFile(file);
  } catch {
    // fall through to the placeholder
  }
  return {
    id: taskId,
    title: taskId,
    status: 'Done',
    acceptanceCriteria: [],
    acceptanceCriteriaChecked: [],
    description: '',
    rawBody: '',
    filePath: '',
  };
}

/** Runner that points the pipeline's `<base>...HEAD` diff at the recorded merge base. */
function pinnedRunner(inner: Runner, mergeBase: string): Runner {
  return (command, args, opts) => {
    if (command === 'git' && args[0] === 'diff') {
      const next = args.map((a) => (a.endsWith('...HEAD') ? `${mergeBase}...HEAD` : a));
      return inner(command, ['-c', 'core.hooksPath=/dev/null', ...next], opts);
    }
    return inner(command, args, opts);
  };
}

export async function runReplay(input: RunReplayInput): Promise<ReplayResults> {
  const models = [input.candidate, ...(input.reference ? [input.reference] : [])];
  const type = reviewerTypeFor(input.role);
  const spawners = new Map(models.map((m) => [m, input.createSpawner({ model: m, type })]));
  const ordered = interleaveByLabel(input.items.filter((i) => i.role === input.role));

  const results: ItemResult[] = [];
  const units = new Map<string, number[]>(models.map((m) => [m, []]));
  const missing = new Map<string, number>(models.map((m) => [m, 0]));
  let unitsUsed = 0;
  let skippedUnreachable = 0;
  let stoppedBy: StopReason = 'completed';

  for (const item of ordered) {
    if (input.signal?.aborted) {
      stoppedBy = 'interrupted';
      break;
    }
    if (results.length >= input.maxItems) {
      stoppedBy = 'max-items';
      break;
    }
    if (unitsUsed >= input.maxUnits) {
      stoppedBy = 'max-units';
      break;
    }
    if (
      !isCommitId(item.commitSha) ||
      !isCommitId(item.mergeBase) ||
      !(await commitExists(input.git, input.repoRoot, item.commitSha))
    ) {
      skippedUnreachable++;
      input.onProgress?.(`skipped ${item.taskId}: commit is no longer reachable`);
      continue;
    }

    const outcomes: Record<string, ReplayOutcome> = {};
    try {
      await withTempWorktree(
        input.git,
        input.repoRoot,
        item.commitSha,
        async (worktree) => {
          const built = await buildReviewPrompts({
            taskId: item.taskId,
            task: loadTask(item.taskId, worktree),
            branch: item.taskId,
            worktreePath: worktree,
            workDir: worktree,
            runner: pinnedRunner(input.runner ?? defaultRunner, item.mergeBase),
            codexAvailable: true,
            reviewers: [type],
          });
          const prompt = built.prompts[0]?.prompt ?? '';
          for (const model of models) {
            let result: SubagentResult;
            try {
              result = await (spawners.get(model) as SubagentSpawner).spawn({
                type,
                prompt,
                cwd: worktree,
                timeout: REVIEW_TIMEOUT_MS,
              });
            } catch {
              outcomes[model] = 'error';
              continue;
            }
            outcomes[model] = verdictOf(result).outcome;
            const tokens = tokensFromOutput(result.output ?? '');
            if (!tokens) {
              missing.set(model, (missing.get(model) ?? 0) + 1);
              continue;
            }
            const u = unitsForTokens(model, tokens, input.weights);
            unitsUsed += u;
            units.get(model)?.push(u);
            recordModelCall(
              {
                ts: input.now().toISOString(),
                provider: 'anthropic',
                model,
                tokens,
                sessionId: `replay-${input.runId}`,
                agentRole: `replay:${type}`,
                scope: 'framework',
                repo: input.repoName,
                taskId: REPLAY_TASK_ID,
              },
              input.usage,
            );
          }
        },
        { tmpRoot: input.tmpRoot },
      );
    } catch {
      for (const m of models) outcomes[m] ??= 'error';
    }
    results.push({
      taskId: item.taskId,
      commitSha: item.commitSha,
      label: item.label,
      outcomes,
    });
    input.onProgress?.(
      `${item.taskId} (${item.label}): ${models.map((m) => `${m}=${outcomes[m]}`).join(' ')}`,
    );
  }

  return {
    schemaVersion: 'v1',
    runId: input.runId,
    generatedAt: input.now().toISOString(),
    role: input.role,
    candidate: input.candidate,
    ...(input.reference ? { reference: input.reference } : {}),
    stoppedBy,
    limits: { maxItems: input.maxItems, maxUnits: input.maxUnits },
    itemsReplayed: results.length,
    skippedUnreachable,
    scores: models.map((m) =>
      scoreModel(m, input.role, results, units.get(m) ?? [], missing.get(m) ?? 0),
    ),
    items: results,
  };
}

function pct(rate: number | null, part: number, whole: number): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(0)}% (${part}/${whole})`;
}

const STOP_TEXT: Record<StopReason, string> = {
  completed: 'Stopped: every corpus item for this role was replayed.',
  'max-items': 'Stopped: reached --max-items.',
  'max-units': 'Stopped: reached --max-units (the run can overshoot by one review).',
  interrupted: 'Stopped: interrupted.',
};

export function renderReplayResults(r: ReplayResults): string {
  const lines = [
    `Reviewer replay: role ${r.role}, ${r.itemsReplayed} item(s) replayed, ` +
      `${r.skippedUnreachable} skipped (commit no longer reachable).`,
    STOP_TEXT[r.stoppedBy],
  ];
  for (const s of r.scores) {
    lines.push(
      `${s.model}: recall ${pct(s.recall, s.knownDefect.blocked, s.knownDefect.items)}, ` +
        `false-block ${pct(s.falseBlockRate, s.clean.blocked, s.clean.items)}, ` +
        `mean units/review ${s.meanUnitsPerReview === null ? '-' : Math.round(s.meanUnitsPerReview).toLocaleString('en-US')} ` +
        `over ${s.reviews} review(s)` +
        (s.errors ? `, ${s.errors} error(s) not scored` : '') +
        (s.usageMissing ? `, ${s.usageMissing} review(s) reported no token counts` : ''),
    );
  }
  return `${lines.join('\n')}\n`;
}
