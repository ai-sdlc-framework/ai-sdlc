/**
 * Ranking gate (RFC-0053 OQ-5): golden recall at 5 must reach `evaluation.goldenRecallAt5` and
 * must not drop more than `evaluation.maxRegressionPoints` against the previous release.
 * Both keys change only through a decision record.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CONTEXT_CONFIG_PATH } from '../config.js';
import * as yaml from '../../util/yaml.js';

export const DEFAULT_GOLDEN_RECALL_AT_5 = 0.8;
export const DEFAULT_MAX_REGRESSION_POINTS = 2;
export const BASELINE_PATH = '.ai-sdlc/context-eval/baseline.json';

export interface EvaluationConfig {
  goldenRecallAt5: number;
  maxRegressionPoints: number;
}

export function loadEvaluationConfig(projectRoot: string): EvaluationConfig {
  const config: EvaluationConfig = {
    goldenRecallAt5: DEFAULT_GOLDEN_RECALL_AT_5,
    maxRegressionPoints: DEFAULT_MAX_REGRESSION_POINTS,
  };
  const file = join(projectRoot, CONTEXT_CONFIG_PATH);
  if (!existsSync(file)) return config;
  const doc = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA });
  const ev = (doc as { evaluation?: Record<string, unknown> } | null)?.evaluation;
  if (!ev || typeof ev !== 'object') return config;
  if (typeof ev.goldenRecallAt5 === 'number') config.goldenRecallAt5 = ev.goldenRecallAt5;
  if (typeof ev.maxRegressionPoints === 'number')
    config.maxRegressionPoints = ev.maxRegressionPoints;
  return config;
}

export interface Baseline {
  release: string;
  recallAt5: number;
}

export function readBaseline(projectRoot: string, file = BASELINE_PATH): Baseline | null {
  const abs = isAbsolute(file) ? file : join(projectRoot, file);
  if (!existsSync(abs)) return null;
  const b = JSON.parse(readFileSync(abs, 'utf-8')) as Partial<Baseline>;
  return typeof b.recallAt5 === 'number'
    ? { release: String(b.release ?? 'unknown'), recallAt5: b.recallAt5 }
    : null;
}

export function writeBaseline(projectRoot: string, b: Baseline, file = BASELINE_PATH): void {
  const abs = isAbsolute(file) ? file : join(projectRoot, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(b, null, 2)}\n`);
}

export interface GateResult {
  ok: boolean;
  failures: string[];
}

const EPS = 1e-9;

export function evaluateGate(
  recallAt5: number,
  config: EvaluationConfig,
  baseline: Baseline | null,
): GateResult {
  const failures: string[] = [];
  if (recallAt5 + EPS < config.goldenRecallAt5) {
    failures.push(`golden recall@5 ${recallAt5.toFixed(3)} is below ${config.goldenRecallAt5}`);
  }
  if (baseline) {
    const dropPoints = (baseline.recallAt5 - recallAt5) * 100;
    if (dropPoints > config.maxRegressionPoints + EPS) {
      failures.push(
        `golden recall@5 dropped ${dropPoints.toFixed(1)} points from ${baseline.release} (${baseline.recallAt5.toFixed(3)}), more than ${config.maxRegressionPoints}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}
