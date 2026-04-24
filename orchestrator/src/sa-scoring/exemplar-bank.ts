/**
 * SA Exemplar Bank loader (RFC-0008 §B.6.4, §B.10.2).
 *
 * Loads labeled SA-scoring exemplars from `.ai-sdlc/sa-exemplars.yaml`
 * for Phase 2a shadow-mode precision tracking and Phase 2b progression
 * gating. A Phase-2b-ready bank needs ≥ 5 exemplars including at least
 * one true-positive AND one false-positive per dimension — without
 * precision evidence on both sides, the structural layer can't be
 * trusted to contribute to ranking.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { SaDimension } from '../state/types.js';

// ── Exemplar shapes ─────────────────────────────────────────────────

export type ExemplarType = 'true-positive' | 'false-positive' | 'true-negative' | 'false-negative';

export interface ExemplarIssue {
  title: string;
  body: string;
}

export interface Layer1Expected {
  hardGated?: boolean;
  coreViolationCount?: number;
  evolvingViolationCount?: number;
  scopeGate?: Record<string, unknown>;
  constraintViolations?: Record<string, unknown>;
  antiPatternHits?: Record<string, unknown>;
}

export interface Layer2Expected {
  domainRelevance?: number;
  overallCoverage?: number;
  [key: string]: unknown;
}

export interface Layer3Expected {
  domainIntent?: number;
  principleAlignment?: number;
  reasoning?: string;
  [key: string]: unknown;
}

export interface SaExemplar {
  id: string;
  dimension: SaDimension;
  type: ExemplarType;
  issue: ExemplarIssue;
  layer1Expected?: Layer1Expected;
  layer2Expected?: Layer2Expected;
  layer3Expected?: Layer3Expected;
  verdict: string;
  principle?: string;
  notes?: string;
}

export interface SaExemplarBank {
  sa1: SaExemplar[];
  sa2: SaExemplar[];
}

// ── Loader ──────────────────────────────────────────────────────────

export const EMPTY_BANK: SaExemplarBank = Object.freeze({
  sa1: [],
  sa2: [],
}) as SaExemplarBank;

/**
 * Load and partition exemplars by dimension. Returns an empty bank
 * when the file is missing — Phase 2a can run without any exemplars;
 * `validatePhase2bExemplars` gates progression.
 */
export function loadExemplarBank(filePath: string): SaExemplarBank {
  if (!existsSync(filePath)) return { sa1: [], sa2: [] };

  const raw = readFileSync(filePath, 'utf-8');
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse SA exemplar bank at ${filePath}: ${(err as Error).message}`);
  }

  if (!doc || typeof doc !== 'object' || !('exemplars' in doc)) {
    throw new Error(`SA exemplar bank ${filePath} must contain a top-level "exemplars" array`);
  }
  const list = (doc as { exemplars: unknown }).exemplars;
  if (!Array.isArray(list)) {
    throw new Error(`SA exemplar bank ${filePath}: "exemplars" must be an array`);
  }

  const sa1: SaExemplar[] = [];
  const sa2: SaExemplar[] = [];

  for (const entry of list) {
    const ex = validateExemplar(entry);
    if (ex.dimension === 'SA-1') sa1.push(ex);
    else sa2.push(ex);
  }

  return { sa1, sa2 };
}

function validateExemplar(entry: unknown): SaExemplar {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Exemplar must be an object`);
  }
  const e = entry as Record<string, unknown>;
  const id = requireString(e, 'id');
  const dimension = requireEnum<SaDimension>(e, 'dimension', ['SA-1', 'SA-2']);
  const type = requireEnum<ExemplarType>(e, 'type', [
    'true-positive',
    'false-positive',
    'true-negative',
    'false-negative',
  ]);

  const issueVal = e.issue;
  if (!issueVal || typeof issueVal !== 'object') {
    throw new Error(`Exemplar "${id}" missing required "issue" object`);
  }
  const issueObj = issueVal as Record<string, unknown>;
  const issue: ExemplarIssue = {
    title: requireString(issueObj, 'title'),
    body: requireString(issueObj, 'body'),
  };
  const verdict = requireString(e, 'verdict');

  return {
    id,
    dimension,
    type,
    issue,
    layer1Expected: e.layer1Expected as Layer1Expected | undefined,
    layer2Expected: e.layer2Expected as Layer2Expected | undefined,
    layer3Expected: e.layer3Expected as Layer3Expected | undefined,
    verdict,
    principle: typeof e.principle === 'string' ? e.principle : undefined,
    notes: typeof e.notes === 'string' ? e.notes : undefined,
  };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Field "${key}" must be a non-empty string`);
  }
  return v;
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  options: readonly T[],
): T {
  const v = obj[key];
  if (typeof v !== 'string' || !options.includes(v as T)) {
    throw new Error(`Field "${key}" must be one of: ${options.join(', ')}`);
  }
  return v as T;
}

// ── Phase-2b readiness gate ──────────────────────────────────────────

export interface ExemplarGap {
  dimension: SaDimension | 'overall';
  reason: string;
}

export interface ExemplarReadinessResult {
  ready: boolean;
  gaps: ExemplarGap[];
}

export const MIN_TOTAL_EXEMPLARS = 5;

export function validatePhase2bExemplars(bank: SaExemplarBank): ExemplarReadinessResult {
  const gaps: ExemplarGap[] = [];
  const total = bank.sa1.length + bank.sa2.length;
  if (total < MIN_TOTAL_EXEMPLARS) {
    gaps.push({
      dimension: 'overall',
      reason: `Need ≥${MIN_TOTAL_EXEMPLARS} exemplars total (have ${total})`,
    });
  }

  for (const dimension of ['SA-1', 'SA-2'] as const) {
    const slice = dimension === 'SA-1' ? bank.sa1 : bank.sa2;
    if (slice.length === 0) {
      gaps.push({
        dimension,
        reason: `Need ≥1 exemplar for ${dimension}`,
      });
      continue;
    }
    const hasTP = slice.some((e) => e.type === 'true-positive');
    const hasFP = slice.some((e) => e.type === 'false-positive');
    if (!hasTP) {
      gaps.push({
        dimension,
        reason: `${dimension} needs ≥1 true-positive exemplar`,
      });
    }
    if (!hasFP) {
      gaps.push({
        dimension,
        reason: `${dimension} needs ≥1 false-positive exemplar (regression tracking)`,
      });
    }
  }

  return { ready: gaps.length === 0, gaps };
}

// ── Precision helpers ────────────────────────────────────────────────

export interface LayerPrecision {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
}

export function computeLayerPrecision(exemplars: readonly SaExemplar[]): LayerPrecision {
  const tp = exemplars.filter((e) => e.type === 'true-positive').length;
  const fp = exemplars.filter((e) => e.type === 'false-positive').length;
  const tn = exemplars.filter((e) => e.type === 'true-negative').length;
  const fn = exemplars.filter((e) => e.type === 'false-negative').length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return {
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
  };
}
