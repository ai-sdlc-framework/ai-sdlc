/**
 * Validate a model-authored review plan against the code-defined baseline.
 *
 * The plan is untrusted. Every rejection carries a reason; the plan is never
 * partially accepted.
 *
 * @module review-plan/validate
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { validateReviewPlan } from '@ai-sdlc/reference';
import { isHighRisk } from './baseline.js';
import { isSafeCommandString } from './config.js';
import type {
  Baseline,
  PlanLimits,
  Probe,
  Rejection,
  RiskMapInput,
  ValidatePlanResult,
} from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Absolute ceilings that bound fan-out even for the mandatory baseline. */
export const ABSOLUTE_MAX_PROBES = 500;
export const ABSOLUTE_MAX_TARGET_BYTES = 1_000_000;

export function targetBytes(target: unknown): number {
  return Buffer.byteLength(canonical(target), 'utf8');
}

/**
 * Lexical path check. The plan is never interpolated into a shell, so this
 * rejects only what is dangerous or ambiguous: NUL and control characters,
 * backslashes, absolute and drive-letter paths, a leading `-` or `~`, glob
 * wildcards `*` and `?`, empty, `.` or `..` segments, and any `.git` segment
 * (case-insensitive; `.github` and `foo.gitignore` are fine). Names such as
 * `app/[id]/page.tsx` and `routes/$route.tsx` are legitimate.
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 300) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\*?]/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('-') || p.startsWith('~') || /^\s|\s$/.test(p))
    return false;
  if (/^[A-Za-z]:/.test(p) || isAbsolute(p)) return false;
  return p
    .split('/')
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

/**
 * True when `p` (already lexically safe) resolves outside the repository, or
 * when that cannot be determined. Checks the deepest EXISTING ancestor, so a
 * symlinked parent with a missing leaf is still caught, and a dangling symlink
 * fails closed.
 */
export function escapesRoot(repoRoot: string, p: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return true;
  }
  let cur = resolve(realRoot, p);
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(cur);
      break;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return true;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
  let real: string;
  try {
    real = realpathSync(cur);
  } catch {
    return true;
  }
  const rel = relative(realRoot, resolve(real, ...rest));
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

/** Path, line-range and run-target problems for one probe. Shared with the fallback builder. */
export function probeSafetyProblems(
  p: Probe,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): Rejection[] {
  const out: Rejection[] = [];
  const add = (reason: Rejection['reason'], detail: string): void => {
    out.push({ reason, detail, probeId: p.id });
  };
  if (p.type === 'run') {
    const cmd = p.target.command;
    if (
      typeof cmd !== 'string' ||
      !isSafeCommandString(cmd) ||
      !limits.commandAllowlist.includes(cmd)
    )
      add('run-target-not-allowed', `run probe ${p.id} names a non-allowlisted command`);
    const tests = new Set(riskMap.changedTestFiles);
    for (const f of p.target.files ?? [])
      if (!tests.has(f.path))
        add(
          'run-files-not-changed-tests',
          `run probe ${p.id} names a file that is not a changed test`,
        );
  }
  // Queries are passed to executors after `--`; a leading '-' would read as an option.
  if (typeof p.target.query === 'string' && p.target.query.startsWith('-'))
    add('unsafe-query', `probe ${p.id} query starts with '-'`);
  for (const f of p.target.files ?? []) {
    if (!isSafeRelativePath(f.path)) add('unsafe-path', `probe ${p.id} has an unsafe path`);
    else if (escapesRoot(limits.repoRoot, f.path))
      add('unsafe-path', `probe ${p.id} path resolves outside the repository`);
    if (f.startLine !== undefined && f.endLine !== undefined && f.endLine < f.startLine)
      add('unsafe-path', `probe ${p.id} has an inverted line range`);
  }
  return out;
}

function runKey(p: Probe): string {
  const files = (p.target.files ?? []).map((f) => canonical(f)).sort();
  return `${p.target.command ?? ''}\n${files.join('|')}`;
}

export function validatePlan(
  plan: unknown,
  baseline: Baseline,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): ValidatePlanResult {
  // An oversize baseline is reported first and explicitly, before any plan check.
  const baselineBytes = baseline.probes.reduce((n, p) => n + targetBytes(p.target), 0);
  const baselineOver =
    baseline.probes.length > ABSOLUTE_MAX_PROBES || baselineBytes > ABSOLUTE_MAX_TARGET_BYTES;
  const overRejection: Rejection[] = baselineOver
    ? [
        {
          reason: 'baseline-over-ceiling',
          detail: 'the baseline alone exceeds the absolute probe or size ceiling',
        },
      ]
    : [];
  const schema = validateReviewPlan<{
    baselineVersion: string;
    probes: Probe[];
  }>(plan);
  if (!schema.valid || !schema.data) {
    const detail = (schema.errors ?? [])
      .slice(0, 5)
      .map((e) => `${e.path || '/'} ${e.message}`)
      .join('; ');
    return {
      valid: false,
      rejections: [
        ...overRejection,
        { reason: 'schema-invalid', detail: detail || 'schema validation failed' },
      ],
    };
  }
  const { probes, baselineVersion } = schema.data;
  const rejections: Rejection[] = [...overRejection];
  const reject = (reason: Rejection['reason'], detail: string, probeId?: string): void => {
    rejections.push({ reason, detail, ...(probeId ? { probeId } : {}) });
  };

  if (baselineVersion !== baseline.version) {
    reject(
      'baseline-version-mismatch',
      `plan baseline ${baselineVersion} differs from ${baseline.version}`,
    );
  }

  // Duplicate ids.
  const byId = new Map<string, Probe>();
  for (const p of probes) {
    if (byId.has(p.id))
      reject('duplicate-probe-id', `probe id ${p.id} appears more than once`, p.id);
    else byId.set(p.id, p);
  }

  // Baseline presence and integrity (any field).
  const baselineById = new Map(baseline.probes.map((p) => [p.id, p]));
  for (const b of baseline.probes) {
    const found = byId.get(b.id);
    if (!found) reject('missing-baseline-probe', `baseline probe ${b.id} is missing`, b.id);
    else if (canonical(found) !== canonical(b))
      reject('modified-baseline-probe', `baseline probe ${b.id} was modified`, b.id);
  }
  for (const p of probes) {
    if (p.baseline === true && !baselineById.has(p.id))
      reject(
        'unknown-baseline-probe',
        `probe ${p.id} claims baseline but is not in the checklist`,
        p.id,
      );
  }

  // Hunk references.
  const hunkIds = new Set(riskMap.hunks.map((h) => h.id));
  for (const p of probes) {
    for (const c of p.covers)
      if (!hunkIds.has(c)) reject('unknown-hunk', `probe ${p.id} covers unknown hunk ${c}`, p.id);
  }

  // Limits. The baseline is mandatory and exempt from the plan limits, but it is
  // bounded by absolute ceilings, and a baseline over a ceiling is reported
  // explicitly. maxProbes and maxTargetBytes measure only what the plan adds.
  const added = probes.filter((p) => !baselineById.has(p.id));
  if (added.length > limits.maxProbes)
    reject(
      'probe-limit-exceeded',
      `${added.length} added probes exceeds the limit of ${limits.maxProbes}`,
    );
  if (probes.length > ABSOLUTE_MAX_PROBES)
    reject('probe-limit-exceeded', `${probes.length} probes exceeds the absolute ceiling`);
  const addedBytes = added.reduce((n, p) => n + targetBytes(p.target), 0);
  const totalBytes = addedBytes + baselineBytes;
  if (addedBytes > limits.maxTargetBytes)
    reject(
      'target-size-exceeded',
      `added targets total ${addedBytes} bytes, over ${limits.maxTargetBytes}`,
    );
  if (totalBytes > ABSOLUTE_MAX_TARGET_BYTES)
    reject('target-size-exceeded', 'targets exceed the absolute size ceiling');

  // An added run probe may not repeat another run probe's command and file set.
  const seenRuns = new Set(baseline.probes.filter((b) => b.type === 'run').map((b) => runKey(b)));
  for (const p of added) {
    if (p.type !== 'run') continue;
    const key = runKey(p);
    if (seenRuns.has(key))
      reject('duplicate-run-probe', `run probe ${p.id} repeats another run probe`, p.id);
    seenRuns.add(key);
  }

  // Run targets and file paths.
  for (const p of probes) rejections.push(...probeSafetyProblems(p, riskMap, limits));

  // Coverage: a high-risk hunk must be covered by a probe that is not an altered
  // or removed baseline probe. Probes that failed the baseline check do not count.
  const trusted = probes.filter((p) => {
    const b = baselineById.get(p.id);
    return b ? canonical(p) === canonical(b) : p.baseline !== true;
  });
  const covered = new Set(trusted.flatMap((p) => p.covers));
  for (const h of riskMap.hunks) {
    if (isHighRisk(h, limits.riskThreshold) && !covered.has(h.id))
      reject('uncovered-high-risk-hunk', `high-risk hunk ${h.id} has no probe`);
  }

  return rejections.length === 0 ? { valid: true } : { valid: false, rejections };
}
