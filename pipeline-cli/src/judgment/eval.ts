/**
 * Evaluation harness for `cli-judgment eval`: collects provider answers over a
 * labelled corpus once, then recomputes outcomes, band shares, act-band precision
 * and the confusion table from the stored answers at any threshold set (so a
 * sweep makes no extra provider calls).
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  evaluateJudgment,
  promotionCorpusBar,
  promotionSatisfies,
  type JudgmentCache,
  type JudgmentDefinition,
  type JudgmentEvaluationRecord,
  type JudgmentOutcome,
  type JudgmentProvider,
  type JudgmentAnswer,
  type JudgmentSink,
  type ResolvedJudgmentConfig,
  type Thresholds,
} from '@ai-sdlc/reference';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDefinition = JudgmentDefinition<any, any>;

export const MAX_CORPUS_BYTES = 20 * 1024 * 1024;
export const MAX_CORPUS_ITEMS = 10_000;
export const MAX_SWEEP_STEPS = 1_000;
export const EVALS_DIR = join('.ai-sdlc', 'judgment-evals');

export class JudgmentCliError extends Error {}

export interface CorpusItem {
  input: unknown;
  label: unknown;
}

/** Parse a corpus JSONL text. Throws JudgmentCliError naming the offending line. */
export function parseCorpus(text: string): CorpusItem[] {
  const items: CorpusItem[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new JudgmentCliError(`corpus line ${i + 1} is not valid JSON`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new JudgmentCliError(`corpus line ${i + 1} must be a JSON object`);
    }
    const obj = raw as Record<string, unknown>;
    if (!Object.hasOwn(obj, 'input') || !Object.hasOwn(obj, 'label')) {
      throw new JudgmentCliError(`corpus line ${i + 1} must have "input" and "label" fields`);
    }
    items.push({ input: obj.input, label: obj.label });
    if (items.length > MAX_CORPUS_ITEMS) {
      throw new JudgmentCliError(`corpus has more than ${MAX_CORPUS_ITEMS} items`);
    }
  }
  return items;
}

/** Read and parse a corpus file with a size cap. */
export function readCorpusFile(path: string): CorpusItem[] {
  let text: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new JudgmentCliError(`corpus '${path}' is not a regular file`);
    if (st.size > MAX_CORPUS_BYTES) {
      throw new JudgmentCliError(`corpus '${path}' is larger than ${MAX_CORPUS_BYTES} bytes`);
    }
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof JudgmentCliError) throw err;
    throw new JudgmentCliError(`cannot read corpus '${path}'`);
  }
  return parseCorpus(text);
}

/** One corpus item with the answers stored from its single provider call (or cache hit). */
export interface CollectedItem extends CorpusItem {
  index: number;
  answers: Record<string, JudgmentAnswer> | null;
  /** Why no answers were obtained (e.g. `egress-not-permitted`, `provider-error`). */
  abstainReason?: string;
  latencyMs: number | null;
  inputTokens: number | null;
  costUsd: number | null;
  cacheHit: boolean;
  called: boolean;
}

export interface CollectContext {
  config: ResolvedJudgmentConfig;
  getProvider: (name: string) => JudgmentProvider | undefined;
  cache?: JudgmentCache;
  sourceKind: string;
  now?: () => Date;
}

/**
 * Force the judgment into shadow mode with the cache on, so the runtime performs
 * its normal checks (egress, availability, size) and returns the raw answers.
 */
export function forcedShadowConfig(
  config: ResolvedJudgmentConfig,
  judgmentId: string,
): ResolvedJudgmentConfig {
  const existing = config.judgments[judgmentId] ?? { thresholds: {}, promotion: {} };
  return {
    ...config,
    defaults: { ...config.defaults, mode: 'shadow', cache: true },
    judgments: { ...config.judgments, [judgmentId]: { ...existing, mode: 'shadow' } },
  };
}

/** Run the judgment once for an input and capture the evaluation record. */
export async function evaluateOnce(
  definition: AnyDefinition,
  input: unknown,
  ctx: CollectContext,
): Promise<JudgmentEvaluationRecord> {
  let captured: JudgmentEvaluationRecord | undefined;
  const sink: JudgmentSink = {
    record(rec) {
      captured = rec;
    },
  };
  await evaluateJudgment(definition, input, {
    config: forcedShadowConfig(ctx.config, definition.id),
    getProvider: ctx.getProvider,
    sourceKind: ctx.sourceKind,
    ...(ctx.cache ? { cache: ctx.cache } : {}),
    sinks: [sink],
    ...(ctx.now ? { now: ctx.now } : {}),
  });
  if (!captured) throw new JudgmentCliError('evaluation produced no record');
  return captured;
}

/** Call the judgment for every corpus item, in order. */
export async function collectAnswers(
  definition: AnyDefinition,
  corpus: CorpusItem[],
  ctx: CollectContext,
): Promise<CollectedItem[]> {
  const out: CollectedItem[] = [];
  for (let i = 0; i < corpus.length; i++) {
    const rec = await evaluateOnce(definition, corpus[i].input, ctx);
    out.push({
      ...corpus[i],
      index: i,
      answers: rec.answers,
      ...(rec.answers === null && rec.outcome.kind === 'abstain'
        ? { abstainReason: rec.outcome.reason }
        : {}),
      latencyMs: rec.latencyMs,
      inputTokens: rec.inputTokens,
      costUsd: rec.costUsd,
      cacheHit: rec.cacheHit,
      called: rec.called,
    });
  }
  return out;
}

export type Band = 'act' | 'escalate' | 'abstain';

/** Recompute an outcome from stored answers; a throwing compose is an abstain. */
export function composeOutcome(
  definition: AnyDefinition,
  answers: Record<string, JudgmentAnswer> | null,
  input: unknown,
  thresholds: Thresholds,
  sourceKind: string,
  fallbackReason = 'provider-error',
): JudgmentOutcome<unknown> {
  if (!answers) return { kind: 'abstain', reason: fallbackReason };
  try {
    return definition.compose(answers, input, thresholds, {
      permissiveAllowed: definition.direction === 'bidirectional' && sourceKind === 'backlog',
      ...(definition.agrees ? { agrees: definition.agrees.bind(definition) } : {}),
      ...(definition.capabilityId ? { capabilityId: definition.capabilityId } : {}),
    });
  } catch {
    return { kind: 'abstain', reason: 'definition-error' };
  }
}

export interface ConfusionTable {
  /** Row keys are `act:<decision>`, `escalate` or `abstain`; column keys are labels. */
  rows: Record<string, Record<string, number>>;
}

export interface EvalStats {
  n: number;
  counts: Record<Band, number>;
  shares: Record<Band, number | null>;
  /** Items in the act band whose decision agrees with the label. */
  actAgreeing: number;
  /** Null when no item landed in the act band. */
  actBandPrecision: number | null;
  /** Null when there are too many distinct decisions or labels to tabulate. */
  confusion: ConfusionTable | null;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

const MAX_CONFUSION_KEYS = 20;
const MAX_KEY_CHARS = 80;

/** Stable display key for a decision or label. */
function enumKey(v: unknown): string {
  const text = typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined');
  return text.length > MAX_KEY_CHARS ? `${text.slice(0, MAX_KEY_CHARS)}...` : text;
}

/** Compute band shares, act-band precision and the confusion table from stored answers. */
export function computeStats(
  definition: AnyDefinition,
  items: CollectedItem[],
  thresholds: Thresholds,
  sourceKind: string,
): EvalStats {
  const counts: Record<Band, number> = { act: 0, escalate: 0, abstain: 0 };
  let actAgreeing = 0;
  const rows: Record<string, Record<string, number>> = {};
  const labelKeys = new Set<string>();
  for (const item of items) {
    const outcome = composeOutcome(
      definition,
      item.answers,
      item.input,
      thresholds,
      sourceKind,
      item.abstainReason,
    );
    counts[outcome.kind] += 1;
    let rowKey: string = outcome.kind;
    if (outcome.kind === 'act') {
      let agrees: boolean;
      try {
        agrees = definition.agrees
          ? definition.agrees(outcome.decision, item.label) === true
          : false;
      } catch {
        agrees = false;
      }
      if (agrees) actAgreeing += 1;
      rowKey = `act:${enumKey(outcome.decision)}`;
    }
    const col = enumKey(item.label);
    labelKeys.add(col);
    rows[rowKey] ??= {};
    rows[rowKey][col] = (rows[rowKey][col] ?? 0) + 1;
  }
  const enumerable =
    Object.keys(rows).length <= MAX_CONFUSION_KEYS && labelKeys.size <= MAX_CONFUSION_KEYS;
  const n = items.length;
  const share = (c: number): number | null => (n === 0 ? null : round4(c / n));
  return {
    n,
    counts,
    shares: {
      act: share(counts.act),
      escalate: share(counts.escalate),
      abstain: share(counts.abstain),
    },
    actAgreeing,
    actBandPrecision: counts.act === 0 ? null : round4(actAgreeing / counts.act),
    confusion: enumerable ? { rows } : null,
  };
}

// --- sweep --------------------------------------------------------------

export interface SweepSpec {
  name: string;
  from: number;
  to: number;
  step: number;
}

const THRESHOLD_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Parse `<name>=<from>:<to>:<step>`; validates finiteness, ordering and size. */
export function parseSweep(text: string): SweepSpec {
  const m = /^([^=]+)=([^:]+):([^:]+):([^:]+)$/.exec(text);
  if (!m) throw new JudgmentCliError(`--sweep must look like <name>=<from>:<to>:<step>`);
  const [, name, f, t, s] = m;
  if (!THRESHOLD_NAME_RE.test(name))
    throw new JudgmentCliError(`--sweep name '${name}' is invalid`);
  const from = Number(f);
  const to = Number(t);
  const step = Number(s);
  if (![from, to, step].every(Number.isFinite)) {
    throw new JudgmentCliError('--sweep from, to and step must be finite numbers');
  }
  if (step <= 0) throw new JudgmentCliError('--sweep step must be greater than 0');
  if (from > to) throw new JudgmentCliError('--sweep from must not exceed to');
  if (Math.floor((to - from) / step + 1e-9) + 1 > MAX_SWEEP_STEPS) {
    throw new JudgmentCliError(`--sweep would produce more than ${MAX_SWEEP_STEPS} steps`);
  }
  return { name, from, to, step };
}

/** Parse repeated `<name>=<value>` threshold overrides. */
export function parseThresholdOverrides(values: string[]): Thresholds {
  const out: Thresholds = {};
  for (const v of values) {
    const m = /^([^=]+)=(.+)$/.exec(v);
    if (!m || !THRESHOLD_NAME_RE.test(m[1])) {
      throw new JudgmentCliError(`--threshold must look like <name>=<number>, got '${v}'`);
    }
    const num = Number(m[2]);
    if (!Number.isFinite(num)) throw new JudgmentCliError(`--threshold '${m[1]}' must be finite`);
    out[m[1]] = num;
  }
  return out;
}

export interface SweepRow {
  value: number;
  thresholds: Thresholds;
  n: number;
  counts: Record<Band, number>;
  shares: Record<Band, number | null>;
  actBandPrecision: number | null;
}

export function runSweep(
  definition: AnyDefinition,
  items: CollectedItem[],
  base: Thresholds,
  spec: SweepSpec,
  sourceKind: string,
): SweepRow[] {
  const steps = Math.floor((spec.to - spec.from) / spec.step + 1e-9) + 1;
  const rows: SweepRow[] = [];
  for (let i = 0; i < steps; i++) {
    const value = Math.round((spec.from + i * spec.step) * 1e10) / 1e10;
    const thresholds = { ...base, [spec.name]: value };
    const s = computeStats(definition, items, thresholds, sourceKind);
    rows.push({
      value,
      thresholds,
      n: s.n,
      counts: s.counts,
      shares: s.shares,
      actBandPrecision: s.actBandPrecision,
    });
  }
  return rows;
}

// --- latency / cost -----------------------------------------------------

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export interface LatencyCost {
  /** Provider calls made (cache hits excluded). */
  calls: number;
  cacheHits: number;
  latencyMs: { p50: number | null; p95: number | null };
  totalInputTokens: number;
  totalCostUsd: number;
}

export function summarizeCost(items: CollectedItem[]): LatencyCost {
  const lat = items
    .filter((i) => i.called && i.latencyMs !== null)
    .map((i) => i.latencyMs as number);
  return {
    calls: items.filter((i) => i.called).length,
    cacheHits: items.filter((i) => i.cacheHit).length,
    latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95) },
    totalInputTokens: items.reduce((s, i) => s + (i.inputTokens ?? 0), 0),
    totalCostUsd: items.reduce((s, i) => s + (i.costUsd ?? 0), 0),
  };
}

// --- promotion ----------------------------------------------------------

export interface PromotionSummary {
  key: string;
  riskClass: AnyDefinition['riskClass'];
  bar: { minN: number; minActBandPrecision: number };
  met: boolean;
  statement: string;
  snippet: string;
}

/** Build the `promotion` config snippet and the met/not-met statement for a report. */
export function buildPromotion(
  definition: AnyDefinition,
  key: string,
  stats: Pick<EvalStats, 'n' | 'actBandPrecision'>,
  evalReportPath: string,
): PromotionSummary {
  const bar = promotionCorpusBar(definition.riskClass);
  const met = promotionSatisfies(definition.riskClass, {
    path: 'corpus',
    n: stats.n,
    ...(stats.actBandPrecision !== null ? { actBandPrecision: stats.actBandPrecision } : {}),
  });
  const pct = Math.round(bar.minActBandPrecision * 100);
  const bits = [
    `n=${stats.n} (needs >= ${bar.minN})`,
    stats.actBandPrecision === null
      ? 'no items in the act band (needs act-band precision >= ' + `${pct}%)`
      : `act-band precision ${stats.actBandPrecision} (needs >= ${bar.minActBandPrecision})`,
  ];
  const tail =
    definition.riskClass === 'relax'
      ? ' The relax bar is corpus-only: the rows must come from the findings ledger and the operator-override path is not allowed.'
      : ' The operator-override path is also allowed, with the evidence recorded in the pull request.';
  const statement = `${met ? 'MET' : 'NOT MET'}: ${definition.riskClass} bar for ${definition.id}: ${bits.join('; ')}.${tail}`;
  const lines = [
    'judgments:',
    `  ${definition.id}:`,
    '    promotion:',
    `      ${key}:`,
    '        path: corpus',
    `        n: ${stats.n}`,
  ];
  if (stats.actBandPrecision !== null) {
    lines.push(`        actBandPrecision: ${stats.actBandPrecision}`);
  }
  lines.push(`        evalReport: ${evalReportPath}`);
  return {
    key,
    riskClass: definition.riskClass,
    bar,
    met,
    statement,
    snippet: lines.join('\n'),
  };
}

// --- report file --------------------------------------------------------

/** Make one path component safe: no separators, no leading dots, no `..`. */
export function sanitizePathComponent(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\./, '_')
    .slice(0, 80);
  return cleaned === '' ? '_' : cleaned;
}

export function reportFileName(parts: {
  id: string;
  provider: string;
  model: string;
  date: string;
}): string {
  return `${[parts.id, parts.provider, parts.model, parts.date].map(sanitizePathComponent).join('-')}.json`;
}

/** Write the report under `<workDir>/.ai-sdlc/judgment-evals/`; returns the relative path. */
export function writeReportFile(workDir: string, fileName: string, report: unknown): string {
  const dir = resolve(workDir, EVALS_DIR);
  const target = resolve(dir, fileName);
  if (dirname(target) !== dir)
    throw new JudgmentCliError('report path escapes the evals directory');
  mkdirSync(dir, { recursive: true });
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new JudgmentCliError('refusing to write the report through a symlink');
    }
  } catch (err) {
    if (err instanceof JudgmentCliError) throw err;
    // not present yet
  }
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return join(EVALS_DIR, fileName);
}
