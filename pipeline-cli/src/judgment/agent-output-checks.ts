/**
 * Advisory judgments on agent output: `dev.ac-coverage` (after the developer
 * return is parsed) and `review.finding-grounding` (before verdict aggregation).
 *
 * Both are tighten-only and advisory. They annotate and notify; they never change
 * a verdict, a finding, a severity, the reviewer set or the attestation. With the
 * layer disabled (no provider, or the judgment's mode is `off`) nothing runs and
 * nothing is read from disk.
 */

import { isAbsolute, posix } from 'node:path';
import {
  acCoverageJudgment,
  canonicalJson,
  evaluateJudgment,
  extractExcerpt,
  findingGroundingJudgment,
  GROUNDING_FLAGGED,
  judgmentEnforceDowngradeReason,
  providerModelKey,
  resolveJudgmentProvider,
  type JudgmentDefinition,
  type EvaluateJudgmentContext,
  type GroundingItem,
  type JudgmentEvaluationRecord,
  type JudgmentProvider,
} from '@ai-sdlc/reference';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { resolveTargetBranch } from '../steps/02-compute-branch.js';
import type { AcCoverageResult, FindingGroundingAnnotation, ReviewerVerdict } from '../types.js';

/** Wiring Step 6 needs to run `dev.ac-coverage`. */
export interface AcCoverageHook {
  ctx: EvaluateJudgmentContext;
  acceptanceCriteria: string[];
  /** Lazily produces the diff against the merge base; called only when the layer is on. */
  getDiff: () => Promise<string | undefined>;
}

/** Wiring Step 8 needs to run `review.finding-grounding`. */
export interface FindingGroundingHook {
  ctx: EvaluateJudgmentContext;
  /** Worktree checked out at the reviewed commit. */
  worktreePath: string;
  /** Test injection: replaces the git object read of a cited file. */
  readFile?: (file: string) => Promise<FileRead>;
  /** Runner for the git object reads; defaults to the real runner. */
  runner?: Runner;
}

function configuredMode(ctx: EvaluateJudgmentContext, id: string): string {
  return ctx.config.judgments[id]?.mode ?? ctx.config.defaults.mode;
}

/** True when a provider is configured and the judgment is not switched off. */
function layerOn(ctx: EvaluateJudgmentContext, id: string): boolean {
  return !!ctx.config.provider && configuredMode(ctx, id) !== 'off';
}

/** Run `dev.ac-coverage`. Never throws; undefined means nothing to report. */
export async function runAcCoverage(hook: AcCoverageHook): Promise<AcCoverageResult | undefined> {
  try {
    const { ctx } = hook;
    if (!layerOn(ctx, acCoverageJudgment.id) || hook.acceptanceCriteria.length === 0) {
      return undefined;
    }
    const diff = await hook.getDiff();
    if (!diff) return undefined;
    const outcome = await evaluateJudgment(
      acCoverageJudgment,
      { acceptanceCriteria: hook.acceptanceCriteria, diff },
      ctx,
    );
    if (outcome.kind === 'act') return outcome.decision;
    if (outcome.kind === 'escalate' && outcome.partial?.criteria) {
      const criteria = outcome.partial.criteria;
      return { criteria, uncovered: criteria.filter((c) => c.likelyUncovered).length };
    }
    if (outcome.kind === 'abstain' && outcome.reason === 'state-too-large') {
      return { criteria: [], uncovered: 0, abstainReason: 'state-too-large' };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Diff of HEAD against the merge base with the integration branch. */
export async function getMergeBaseDiff(opts: {
  workDir: string;
  worktreePath: string;
  runner?: Runner;
}): Promise<string | undefined> {
  const runner = opts.runner ?? defaultRunner;
  const target = resolveTargetBranch(opts.workDir);
  const res = await runner('git', ['diff', `origin/${target}...HEAD`], {
    cwd: opts.worktreePath,
    allowFailure: true,
  });
  return res.code === 0 ? res.stdout : undefined;
}

/** Largest blob (bytes) that may be excerpted and sent to a provider. */
export const MAX_GROUNDING_FILE_BYTES = 256 * 1024;
/** Most locatable findings considered per grounding run; the rest are logged as skipped. */
export const MAX_GROUNDING_FINDINGS = 50;
/** Most provider requests per grounding run; later batches are logged as skipped. */
export const MAX_GROUNDING_REQUESTS = 5;

/** What reading a cited file at the reviewed commit produced. */
export type FileRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  /** Present but cannot be excerpted: oversized or binary. */
  | { kind: 'unreadable' };

const BLOB_MODES = new Set(['100644', '100755']);

/**
 * Read a cited file from git objects at the reviewed commit (`HEAD` of the
 * worktree). Only regular tracked blobs qualify: untracked and gitignored files,
 * symlinks (mode 120000), gitlinks (160000), directories, absolute paths and
 * paths escaping the repository are all `missing`. Arguments are passed as an
 * argv array; nothing goes through a shell.
 */
export async function readCommittedFile(
  runner: Runner,
  worktreePath: string,
  file: string,
): Promise<FileRead> {
  const missing: FileRead = { kind: 'missing' };
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return missing;
  const cleaned = file.replace(/\\/g, '/');
  if (isAbsolute(cleaned) || posix.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned)) {
    return missing;
  }
  const rel = posix.normalize(cleaned);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || rel.endsWith('/')) return missing;

  const git = (args: string[]) => runner('git', args, { cwd: worktreePath, allowFailure: true });
  const tree = await git(['ls-tree', '-z', 'HEAD', '--', rel]);
  if (tree.code !== 0) return missing;
  const entry = tree.stdout.split('\0')[0] ?? '';
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(entry);
  if (!m || m[2] !== 'blob' || !BLOB_MODES.has(m[1]) || m[4] !== rel) return missing;
  const sha = m[3];

  const size = await git(['cat-file', '-s', sha]);
  if (size.code !== 0) return missing;
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes > MAX_GROUNDING_FILE_BYTES) return { kind: 'unreadable' };

  const blob = await git(['cat-file', 'blob', sha]);
  if (blob.code !== 0) return missing;
  if (blob.stdout.includes('\0') || blob.stdout.length > MAX_GROUNDING_FILE_BYTES) {
    return { kind: 'unreadable' };
  }
  return { kind: 'text', text: blob.stdout.replace(/\r\n?/g, '\n') };
}

function tokenEstimate(value: unknown): number {
  return canonicalJson(value).length / 4;
}

/** Estimated tokens one finding adds to a request (state, questions, wrapper slack). */
export function estimateGroundingItemTokens(item: GroundingItem): number {
  return (
    tokenEstimate(findingGroundingJudgment.buildState({ items: [item] })) +
    tokenEstimate(findingGroundingJudgment.questions({ items: [item] })) +
    16
  );
}

/**
 * Greedy, order-preserving packing of items into as few requests as the state
 * budget allows. An item larger than the budget gets a request of its own (the
 * runtime then abstains `state-too-large` for it).
 */
export function batchGroundingItems(
  items: GroundingItem[],
  budgetTokens: number,
): GroundingItem[][] {
  const batches: GroundingItem[][] = [];
  let current: GroundingItem[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateGroundingItemTokens(item);
    if (current.length > 0 && used + cost > budgetTokens) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function pickProvider(ctx: EvaluateJudgmentContext): JudgmentProvider | undefined {
  try {
    const name = ctx.config.provider;
    if (!name) return undefined;
    return ctx.getProvider
      ? ctx.getProvider(name)
      : resolveJudgmentProvider(name, ctx.config.providerOptions, ctx.config.model);
  } catch {
    return undefined;
  }
}

interface InCodeRecordOpts {
  enforce: boolean;
  configuredMode: string;
  downgradeReason?: string;
  provider?: JudgmentProvider;
  outcome: JudgmentEvaluationRecord['outcome'];
}

/** Log record for work done in code (no provider call): the location check and cap notices. */
async function recordInCode(ctx: EvaluateJudgmentContext, o: InCodeRecordOpts): Promise<void> {
  const now = ctx.now ?? (() => new Date());
  const model = ctx.config.model ?? o.provider?.modelId;
  const rec: JudgmentEvaluationRecord = {
    ts: now().toISOString(),
    judgmentId: findingGroundingJudgment.id,
    version: findingGroundingJudgment.version,
    consumerLabel: ctx.consumerLabel ?? findingGroundingJudgment.id,
    questionSetHash: null,
    stateHash: null,
    provider: o.provider?.name ?? null,
    providerModelKey: o.provider && model ? providerModelKey(o.provider.name, model) : null,
    modelVersion: null,
    mode: o.enforce ? 'enforce' : 'shadow',
    ...(o.configuredMode === 'enforce' && !o.enforce
      ? {
          configuredMode: 'enforce' as const,
          ...(o.downgradeReason ? { downgradeReason: o.downgradeReason } : {}),
        }
      : {}),
    answers: null,
    thresholds: null,
    outcome: o.outcome,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: false,
    costUsd: null,
    cacheHit: false,
    ...(ctx.sourceKind ? { sourceKind: ctx.sourceKind } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  };
  for (const sink of ctx.sinks ?? []) {
    try {
      await sink.record(rec);
    } catch {
      // a sink failure never changes the result
    }
  }
}

/**
 * Run `review.finding-grounding` over every finding that cites a file and line.
 * Runs only when both `agent-output` and `code-diff` egress are allowed. File
 * content comes from git objects at the reviewed commit, never the live working
 * tree. Work is capped (`MAX_GROUNDING_FINDINGS`, `MAX_GROUNDING_REQUESTS`).
 * Never throws; undefined means nothing to report. Findings are never modified.
 */
export async function runFindingGrounding(
  verdicts: ReviewerVerdict[],
  hook: FindingGroundingHook,
): Promise<FindingGroundingAnnotation[] | undefined> {
  try {
    const { ctx } = hook;
    const id = findingGroundingJudgment.id;
    if (!layerOn(ctx, id)) return undefined;
    const allowed = ctx.config.egressAllow;
    if (!allowed.includes('agent-output') || !allowed.includes('code-diff')) return undefined;

    // The in-code check obeys the same enforce-to-shadow gate as the runtime.
    const provider = pickProvider(ctx);
    const configured = configuredMode(ctx, id);
    let downgradeReason: string | undefined;
    if (configured === 'enforce') {
      downgradeReason = provider
        ? judgmentEnforceDowngradeReason(
            findingGroundingJudgment as unknown as JudgmentDefinition<unknown, unknown>,
            ctx.config,
            provider,
          )
        : 'provider-unavailable';
    }
    const enforce = configured === 'enforce' && !downgradeReason;
    const runner = hook.runner ?? defaultRunner;
    const reads = new Map<string, Promise<FileRead>>();
    const read = (file: string): Promise<FileRead> => {
      let r = reads.get(file);
      if (!r) {
        r = hook.readFile
          ? hook.readFile(file)
          : readCommittedFile(runner, hook.worktreePath, file);
        reads.set(file, r);
      }
      return r;
    };

    const located: FindingGroundingAnnotation[] = [];
    const items: GroundingItem[] = [];
    let considered = 0;
    let skippedFindings = 0;
    for (const v of verdicts) {
      const findings = v.findings ?? [];
      for (let findingIndex = 0; findingIndex < findings.length; findingIndex++) {
        const f = findings[findingIndex];
        if (!f.file || typeof f.line !== 'number') continue;
        if (considered >= MAX_GROUNDING_FINDINGS) {
          skippedFindings++;
          continue;
        }
        considered++;
        const base = { agentId: String(v.agentId), findingIndex, file: f.file, line: f.line };
        const got = await read(f.file);
        if (got.kind === 'unreadable') {
          located.push({ ...base, relation: 'cannot-tell' });
          continue;
        }
        const excerpt = got.kind === 'text' ? extractExcerpt(got.text, f.line) : undefined;
        if (!excerpt) {
          located.push({ ...base, relation: 'location-not-found' });
          continue;
        }
        items.push({ id: `finding-${items.length}`, ...base, claim: f.message, ...excerpt });
      }
    }
    if (considered === 0) return undefined;

    const notFound = located.filter((a) => a.relation === 'location-not-found');
    const inCode = {
      enforce,
      configuredMode: configured,
      ...(downgradeReason ? { downgradeReason } : {}),
      ...(provider ? { provider } : {}),
    };
    if (notFound.length > 0) {
      await recordInCode(ctx, {
        ...inCode,
        outcome: enforce
          ? {
              kind: 'escalate',
              to: 'operator',
              reason: `${notFound.length} review finding${notFound.length === 1 ? '' : 's'} cite code that was not found`,
              partial: { annotations: notFound },
            }
          : { kind: 'abstain', reason: 'shadow' },
      });
    }
    if (skippedFindings > 0) {
      await recordInCode(ctx, {
        ...inCode,
        outcome: { kind: 'abstain', reason: 'finding-cap-exceeded' },
      });
    }

    const annotations: FindingGroundingAnnotation[] = enforce ? [...located] : [];
    const budget = provider?.capabilities.maxStateTokens ?? Number.POSITIVE_INFINITY;
    const batches = batchGroundingItems(items, budget);
    if (batches.length > MAX_GROUNDING_REQUESTS) {
      await recordInCode(ctx, {
        ...inCode,
        outcome: { kind: 'abstain', reason: 'request-cap-exceeded' },
      });
    }
    for (const batch of batches.slice(0, MAX_GROUNDING_REQUESTS)) {
      const outcome = await evaluateJudgment(findingGroundingJudgment, { items: batch }, ctx);
      if (outcome.kind === 'act') annotations.push(...outcome.decision.annotations);
      else if (outcome.kind === 'escalate' && outcome.partial?.annotations) {
        annotations.push(...outcome.partial.annotations);
      }
    }
    return annotations.length > 0 ? annotations : undefined;
  } catch {
    return undefined;
  }
}

/** True when an annotation is worth surfacing to the operator. */
export function isFlaggedAnnotation(a: FindingGroundingAnnotation): boolean {
  return GROUNDING_FLAGGED.includes(a.relation);
}

const MAX_CRITERION_CHARS = 120;
const MAX_PATH_CHARS = 200;

/**
 * Reviewer- and issue-supplied text rendered as an inline code span: control
 * characters and backticks removed, so it cannot start a block, open a link, or
 * mention anyone. Criterion text is the task author's own wording and is shown
 * as written (this layer generates no identifiers of its own).
 */
function codeSpan(raw: string, max: number): string {
  const flat = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}...` : flat;
  return cut ? `\`${cut}\`` : '';
}

/** Reviewer ids are rendered as a plain token; anything unusual becomes `reviewer`. */
function reviewerToken(raw: string): string {
  return /^[A-Za-z0-9._-]{1,40}$/.test(raw) ? raw : 'reviewer';
}

/**
 * "Judgment notes (advisory)" PR-body section, or an empty string when there is
 * nothing to report. All interpolated reviewer/issue text is neutralised.
 */
export function composeJudgmentNotes(opts: {
  acCoverage?: AcCoverageResult;
  groundingAnnotations?: FindingGroundingAnnotation[];
  acceptanceCriteria?: string[];
}): string {
  const lines: string[] = [];
  for (const c of opts.acCoverage?.criteria ?? []) {
    if (!c.likelyUncovered) continue;
    const shown = codeSpan(opts.acceptanceCriteria?.[c.index] ?? '', MAX_CRITERION_CHARS);
    lines.push(
      `- Acceptance criterion ${Number(c.index) + 1} may not be covered by the diff` +
        `${shown ? `: ${shown}` : ''} (coverage probability ${Number(c.probability).toFixed(2)})`,
    );
  }
  for (const a of opts.groundingAnnotations ?? []) {
    if (!isFlaggedAnnotation(a)) continue;
    const what =
      a.relation === 'location-not-found'
        ? 'cites a location that was not found'
        : a.relation === 'contradicts'
          ? 'is contradicted by the cited code'
          : 'is unrelated to the cited code';
    const where = codeSpan(`${a.file}:${Number(a.line)}`, MAX_PATH_CHARS) || '`(unknown)`';
    lines.push(`- A ${reviewerToken(String(a.agentId))} finding at ${where} ${what}`);
  }
  if (lines.length === 0) return '';
  return (
    '## Judgment notes (advisory)\n' +
    'Automated checks flagged the items below. They are informational and did not change the review verdict.\n\n' +
    `${lines.join('\n')}\n`
  );
}
