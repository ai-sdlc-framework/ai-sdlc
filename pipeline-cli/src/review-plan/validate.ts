/**
 * Validate a model-authored review plan against the code-defined baseline.
 *
 * The plan is untrusted. Every rejection carries a reason; the plan is never
 * partially accepted.
 *
 * @module review-plan/validate
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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

/** Lexical path check: relative, no traversal, no separators tricks. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 300) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\:~*?[\]{}<>|;&$`"'!#%^]/.test(p)) return false;
  if (p.startsWith('/') || p.startsWith('-') || /^\s|\s$/.test(p)) return false;
  if (isAbsolute(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function escapesRoot(repoRoot: string, p: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return true;
  }
  const full = resolve(realRoot, p);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    // Not on disk (for example a deleted file): lexical containment already holds.
    return false;
  }
  const rel = relative(realRoot, real);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

export function validatePlan(
  plan: unknown,
  baseline: Baseline,
  riskMap: RiskMapInput,
  limits: PlanLimits,
): ValidatePlanResult {
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
      rejections: [{ reason: 'schema-invalid', detail: detail || 'schema validation failed' }],
    };
  }
  const { probes, baselineVersion } = schema.data;
  const rejections: Rejection[] = [];
  const reject = (reason: Rejection['reason'], detail: string, probeId?: string): void => {
    rejections.push({ reason, detail, ...(probeId ? { probeId } : {}) });
  };

  if (baselineVersion !== baseline.version) {
    reject(
      'baseline-version-mismatch',
      `plan baseline ${baselineVersion} differs from ${baseline.version}`,
    );
  }

  if (probes.length > limits.maxProbes) {
    reject(
      'probe-limit-exceeded',
      `${probes.length} probes exceeds the limit of ${limits.maxProbes}`,
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

  // Target size.
  const total = probes.reduce((n, p) => n + canonical(p.target).length, 0);
  if (total > limits.maxTargetBytes) {
    reject(
      'target-size-exceeded',
      `targets total ${total} exceeds the limit of ${limits.maxTargetBytes}`,
    );
  }

  // Run targets and file paths.
  for (const p of probes) {
    if (p.type === 'run') {
      const cmd = p.target.command;
      if (
        typeof cmd !== 'string' ||
        !isSafeCommandString(cmd) ||
        !limits.commandAllowlist.includes(cmd)
      )
        reject('run-target-not-allowed', `run probe ${p.id} names a non-allowlisted command`, p.id);
    }
    for (const f of p.target.files ?? []) {
      if (!isSafeRelativePath(f.path)) {
        reject('unsafe-path', `probe ${p.id} has an unsafe path`, p.id);
      } else if (limits.repoRoot && escapesRoot(limits.repoRoot, f.path)) {
        reject('unsafe-path', `probe ${p.id} path resolves outside the repository`, p.id);
      }
      if (f.startLine !== undefined && f.endLine !== undefined && f.endLine < f.startLine)
        reject('unsafe-path', `probe ${p.id} has an inverted line range`, p.id);
    }
  }

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
