/**
 * Layer 2 — Structural BM25 scorer (RFC-0008 Addendum B §B.5).
 *
 *   computeDomainRelevance(issueText, bm25Corpus)   → SA-1 [0, 1]
 *   computePrincipleCoverage(issueText, principleCorpora) → SA-2 vector
 *
 * Uses a minimal in-process BM25 implementation — no external index
 * library needed. The corpus is tokenized at compile time
 * (`did-compiler.ts`), so scoring is O(|query| × |corpus|) per call.
 *
 * Determinism: pure functions, no randomness, arithmetic-only. Same
 * inputs → bit-exact outputs.
 */

import type { Bm25Corpus, Bm25Document, PrincipleCorpora } from './did-compiler.js';
import { tokenize } from './did-compiler.js';

// ── BM25 hyper-parameters ────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;
/** Used to squash raw BM25 score into [0, 1). */
const NORMALIZE_ALPHA = 5.0;
const CONTRIBUTING_TERMS_LIMIT = 10;

// ── Internal index ───────────────────────────────────────────────────

interface Bm25Index {
  /** The weighted-document list — each carries its own TF map + length. */
  docs: Array<{
    id: string;
    weight: number;
    length: number;
    termFreq: Map<string, number>;
  }>;
  /** Number of documents that contain each term (for IDF). */
  docFreq: Map<string, number>;
  /** Average document length (weighted). */
  avgDocLength: number;
}

function buildIndex(corpus: Bm25Corpus): Bm25Index {
  const docs: Bm25Index['docs'] = corpus.documents.map((doc) => {
    const termFreq = new Map<string, number>();
    for (const tok of doc.tokens) termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
    return {
      id: doc.id,
      weight: doc.weight,
      length: doc.tokens.length * doc.weight,
      termFreq,
    };
  });

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const totalLength = docs.reduce((sum, d) => sum + d.length, 0);
  const avgDocLength = docs.length === 0 ? 0 : totalLength / docs.length;

  return { docs, docFreq, avgDocLength };
}

function idf(term: string, index: Bm25Index): number {
  const n = index.docFreq.get(term) ?? 0;
  const N = index.docs.length;
  // Smoothed BM25 IDF (non-negative even for common terms)
  return Math.log((N - n + 0.5) / (n + 0.5) + 1);
}

function scoreDoc(
  queryTokens: readonly string[],
  doc: Bm25Index['docs'][number],
  index: Bm25Index,
): { score: number; termContributions: Map<string, number> } {
  let score = 0;
  const contributions = new Map<string, number>();
  const lengthNorm = index.avgDocLength === 0 ? 1 : 1 - B + B * (doc.length / index.avgDocLength);
  for (const term of queryTokens) {
    const rawTf = doc.termFreq.get(term);
    if (!rawTf) continue;
    const tf = rawTf * doc.weight;
    const termIdf = idf(term, index);
    const contribution = (termIdf * (tf * (K1 + 1))) / (tf + K1 * lengthNorm);
    score += contribution;
    contributions.set(term, (contributions.get(term) ?? 0) + contribution);
  }
  return { score, termContributions: contributions };
}

function normalizeScore(rawScore: number): number {
  if (rawScore <= 0) return 0;
  // Monotonic squash into [0, 1) — `tanh(score / α)` is smooth and
  // deterministic. Tune α to taste (higher = slower saturation).
  return Math.tanh(rawScore / NORMALIZE_ALPHA);
}

function topTerms(contributions: Map<string, number>, limit: number): ContributingTerm[] {
  return Array.from(contributions.entries())
    .map(([term, score]) => ({ term, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break alphabetically for determinism.
      return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
    })
    .slice(0, limit);
}

// ── Public output shapes ─────────────────────────────────────────────

export interface ContributingTerm {
  term: string;
  score: number;
}

export interface DomainRelevanceResult {
  /** Normalized relevance in [0, 1]. */
  score: number;
  /** Raw BM25 sum before normalization (for debugging / calibration). */
  rawScore: number;
  /** Top contributing terms, sorted by contribution score. */
  contributingTerms: ContributingTerm[];
  /** Number of query tokens after stopword stripping. */
  queryLength: number;
}

export interface PrincipleCoverageEntry {
  principleId: string;
  coverage: number;
  identityClass: 'core' | 'evolving';
  contributingTerms: ContributingTerm[];
}

export interface PrincipleCoverageVector {
  principles: PrincipleCoverageEntry[];
  /** Weighted mean — core principles count twice, evolving once. */
  overallCoverage: number;
}

// ── Public API ───────────────────────────────────────────────────────

export function computeDomainRelevance(
  issueText: string,
  corpus: Bm25Corpus,
): DomainRelevanceResult {
  const queryTokens = tokenize(issueText);
  if (queryTokens.length === 0 || corpus.documents.length === 0) {
    return {
      score: 0,
      rawScore: 0,
      contributingTerms: [],
      queryLength: queryTokens.length,
    };
  }

  const index = buildIndex(corpus);
  const aggregateContributions = new Map<string, number>();
  let totalScore = 0;
  let maxDocScore = 0;

  for (const doc of index.docs) {
    const { score, termContributions } = scoreDoc(queryTokens, doc, index);
    totalScore += score;
    if (score > maxDocScore) maxDocScore = score;
    for (const [term, v] of termContributions) {
      aggregateContributions.set(term, (aggregateContributions.get(term) ?? 0) + v);
    }
  }

  // For domainRelevance, use the MAX doc score (the best-matching doc).
  // This avoids diluting a tight match in the mission doc by a long
  // irrelevant experientialTargets doc.
  const rawScore = maxDocScore;
  void totalScore;

  return {
    score: normalizeScore(rawScore),
    rawScore,
    contributingTerms: topTerms(aggregateContributions, CONTRIBUTING_TERMS_LIMIT),
    queryLength: queryTokens.length,
  };
}

export function computePrincipleCoverage(
  issueText: string,
  principleCorpora: PrincipleCorpora,
): PrincipleCoverageVector {
  const entries: PrincipleCoverageEntry[] = [];
  for (const principleId of Object.keys(principleCorpora).sort()) {
    const corpus = principleCorpora[principleId];
    const relevance = computeDomainRelevance(issueText, corpus);
    const firstDoc: Bm25Document | undefined = corpus.documents[0];
    const identityClass: 'core' | 'evolving' =
      firstDoc && firstDoc.weight === 2 ? 'core' : 'evolving';
    entries.push({
      principleId,
      coverage: relevance.score,
      identityClass,
      contributingTerms: relevance.contributingTerms,
    });
  }

  // Weighted mean: core = 2, evolving = 1.
  const weighted = entries.reduce(
    (acc, e) => {
      const w = e.identityClass === 'core' ? 2 : 1;
      acc.sum += e.coverage * w;
      acc.weight += w;
      return acc;
    },
    { sum: 0, weight: 0 },
  );
  const overallCoverage = weighted.weight === 0 ? 0 : weighted.sum / weighted.weight;

  return { principles: entries, overallCoverage };
}

// ── Exported internals for testing ───────────────────────────────────

export const __internals = {
  buildIndex,
  idf,
  scoreDoc,
  normalizeScore,
  topTerms,
};
