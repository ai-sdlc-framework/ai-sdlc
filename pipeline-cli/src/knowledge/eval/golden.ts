/**
 * Golden set loading and scoring (RFC-0053 OQ-5). The golden set is hand-authored YAML:
 *
 *   questions:
 *     - id: q1
 *       question: how are secrets scanned?
 *       relevant: { entry-a: 2, entry-b: 1 }   # or a list of ids (grade 1)
 *
 * A question whose judged entries no longer exist retires: it is reported and excluded from the
 * score. Entries missing from a partly-live question are dropped from its judgments.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as yaml from '../../util/yaml.js';
import { loadKnowledgeConfig } from '../config.js';
import { readEntries } from '../store.js';
import { ndcgAtK, recallAtK, reciprocalRank, type Judgments } from './metrics.js';

export const GOLDEN_SET_PATH = '.ai-sdlc/context-eval/golden.yaml';
export const K = 5;

export interface EvalQuestion {
  id: string;
  question: string;
  relevant: Map<string, number>;
}

export type Ranker = (text: string) => Promise<string[]>;

export interface QuestionScore {
  id: string;
  recallAt5: number;
  rr: number;
  ndcgAt5: number;
}

export interface EvalReport {
  scored: number;
  retired: string[];
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  perQuestion: QuestionScore[];
}

export function parseGolden(text: string): EvalQuestion[] {
  const doc = yaml.load(text, { schema: yaml.JSON_SCHEMA }) as { questions?: unknown } | null;
  const raw = Array.isArray(doc?.questions) ? (doc.questions as Record<string, unknown>[]) : [];
  const out: EvalQuestion[] = [];
  for (const q of raw) {
    if (typeof q?.id !== 'string' || typeof q.question !== 'string') {
      throw new Error('golden set: every question needs string `id` and `question`');
    }
    const relevant = new Map<string, number>();
    if (Array.isArray(q.relevant)) {
      for (const id of q.relevant) if (typeof id === 'string') relevant.set(id, 1);
    } else if (q.relevant && typeof q.relevant === 'object') {
      for (const [id, g] of Object.entries(q.relevant)) {
        if (typeof g === 'number' && g > 0) relevant.set(id, g);
      }
    }
    if (relevant.size === 0) throw new Error(`golden set: question '${q.id}' has no judgments`);
    out.push({ id: q.id, question: q.question, relevant });
  }
  return out;
}

export function loadGolden(projectRoot: string, file = GOLDEN_SET_PATH): EvalQuestion[] {
  const abs = isAbsolute(file) ? file : join(projectRoot, file);
  return existsSync(abs) ? parseGolden(readFileSync(abs, 'utf-8')) : [];
}

/** Ids of the live (non-superseded) entries in both knowledge roots. */
export function liveEntryIds(projectRoot: string): Set<string> {
  const k = loadKnowledgeConfig(projectRoot);
  const at = (p: string): string => (isAbsolute(p) ? p : join(projectRoot, p));
  return new Set(
    [...readEntries(at(k.trackedRoot)), ...readEntries(at(k.protectedRoot))]
      .filter((e) => !e.superseded)
      .map((e) => e.id),
  );
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function runEval(
  questions: EvalQuestion[],
  live: ReadonlySet<string>,
  rank: Ranker,
): Promise<EvalReport> {
  const retired: string[] = [];
  const perQuestion: QuestionScore[] = [];
  for (const q of questions) {
    const rel: Judgments = new Map([...q.relevant].filter(([id]) => live.has(id)));
    if (rel.size === 0) {
      retired.push(q.id);
      continue;
    }
    const ranked = await rank(q.question);
    perQuestion.push({
      id: q.id,
      recallAt5: recallAtK(ranked, rel, K),
      rr: reciprocalRank(ranked, rel),
      ndcgAt5: ndcgAtK(ranked, rel, K),
    });
  }
  return {
    scored: perQuestion.length,
    retired,
    recallAt5: mean(perQuestion.map((s) => s.recallAt5)),
    mrr: mean(perQuestion.map((s) => s.rr)),
    ndcgAt5: mean(perQuestion.map((s) => s.ndcgAt5)),
    perQuestion,
  };
}
