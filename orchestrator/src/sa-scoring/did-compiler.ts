/**
 * DID compilation pipeline (RFC-0008 Addendum B §B.3.3).
 *
 * Consumes a `DesignIntentDocument` and produces six deterministic
 * artifacts consumed by the three-layer SA scorer:
 *
 *   1. scopeLists          — flattened in/out scope synonyms
 *   2. constraintRules     — detection patterns per soul constraint
 *   3. antiPatternLists    — product + per-principle + voice + visual
 *   4. measurableSignals   — principle signals + visual constraints
 *   5. bm25Corpus          — SA-1 corpus (mission + experientialTargets,
 *                            core fields weighted 2×, evolving 1×)
 *   6. principleCorpora    — one SA-2 corpus per designPrinciple
 *
 * The output is stable given identical input (canonical JSON + sha256
 * hash) so `did_compiled_artifacts.source_hash` can be used to detect
 * DID changes cheaply.
 */

import { createHash } from 'node:crypto';
import type {
  AntiPattern,
  Constraint,
  DesignIntentDocument,
  DesignPrinciple,
  IdentityClass,
  MeasurableOperator,
  ScopeTerm,
  VisualConstraint,
} from '@ai-sdlc/reference';

// ── Compiled shapes (in-memory) ─────────────────────────────────────

export interface CompiledScopeEntry {
  label: string;
  synonyms: string[];
  identityClass: IdentityClass;
}

export interface CompiledScopeLists {
  inScope: CompiledScopeEntry[];
  outOfScope: CompiledScopeEntry[];
}

export interface CompiledConstraintRule {
  id: string;
  concept: string;
  relationship: Constraint['relationship'];
  detectionPatterns: string[];
  identityClass: IdentityClass;
}

export interface CompiledAntiPattern {
  id: string;
  label: string;
  detectionPatterns: string[];
  identityClass: IdentityClass;
}

export interface CompiledAntiPatternLists {
  product: CompiledAntiPattern[];
  /** Keyed by `designPrinciple.id`. */
  perPrinciple: Record<string, CompiledAntiPattern[]>;
  voice: CompiledAntiPattern[];
  visual: CompiledAntiPattern[];
}

export interface CompiledMeasurableSignal {
  id: string;
  metric: string;
  threshold: number;
  operator: MeasurableOperator;
  scope?: string;
  /** Present when derived from a specific principle's signals list. */
  sourcePrinciple?: string;
  /** Present when derived from a visual constraint rule. */
  sourceVisual?: string;
  identityClass: IdentityClass;
}

export interface Bm25Document {
  id: string;
  tokens: string[];
  /** 2 when derived from `identityClass: 'core'`, else 1. */
  weight: number;
}

export interface Bm25Corpus {
  documents: Bm25Document[];
}

export type PrincipleCorpora = Record<string, Bm25Corpus>;

export interface CompiledDid {
  didName: string;
  namespace?: string;
  sourceHash: string;
  scopeLists: CompiledScopeLists;
  constraintRules: CompiledConstraintRule[];
  antiPatternLists: CompiledAntiPatternLists;
  measurableSignals: CompiledMeasurableSignal[];
  bm25Corpus: Bm25Corpus;
  principleCorpora: PrincipleCorpora;
}

// ── Tokenization ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'with',
  'from',
  'that',
  'this',
  'will',
  'have',
  'has',
  'been',
  'were',
  'your',
  'our',
  'their',
  'they',
  'must',
  'may',
  'not',
  'into',
  'onto',
  'than',
  'but',
  'any',
  'all',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// ── Canonical JSON + hash ────────────────────────────────────────────

/**
 * Stable JSON: keys sorted alphabetically at every depth. Matches the
 * Python json.dumps(sort_keys=True) output so cross-language consumers
 * agree on the source hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function hashDidSpec(did: DesignIntentDocument): string {
  return createHash('sha256').update(canonicalJson(did.spec)).digest('hex');
}

// ── Helpers ──────────────────────────────────────────────────────────

function ic(input: { identityClass?: IdentityClass } | undefined): IdentityClass {
  return input?.identityClass ?? 'evolving';
}

function compileScopeEntry(term: ScopeTerm): CompiledScopeEntry {
  return {
    label: term.label,
    synonyms: term.synonyms ? Array.from(new Set(term.synonyms)) : [],
    identityClass: ic(term),
  };
}

function compileConstraint(c: Constraint): CompiledConstraintRule {
  return {
    id: c.id,
    concept: c.concept,
    relationship: c.relationship,
    detectionPatterns: [...c.detectionPatterns],
    identityClass: ic(c),
  };
}

function compileAntiPattern(a: AntiPattern): CompiledAntiPattern {
  return {
    id: a.id,
    label: a.label,
    detectionPatterns: [...a.detectionPatterns],
    identityClass: ic(a),
  };
}

function buildBm25Document(
  id: string,
  text: string,
  identityClass: IdentityClass,
): Bm25Document | undefined {
  const tokens = tokenize(text);
  if (tokens.length === 0) return undefined;
  return { id, tokens, weight: identityClass === 'core' ? 2 : 1 };
}

// ── Compilation entry point ──────────────────────────────────────────

export function compileDid(did: DesignIntentDocument): CompiledDid {
  const spec = did.spec;

  // 1. Scope lists
  const scopeLists: CompiledScopeLists = {
    inScope: (spec.soulPurpose.scopeBoundaries?.inScope ?? []).map(compileScopeEntry),
    outOfScope: (spec.soulPurpose.scopeBoundaries?.outOfScope ?? []).map(compileScopeEntry),
  };

  // 2. Constraint rules
  const constraintRules: CompiledConstraintRule[] = (spec.soulPurpose.constraints ?? []).map(
    compileConstraint,
  );

  // 3. Anti-pattern lists
  const productAntiPatterns: CompiledAntiPattern[] = (spec.soulPurpose.antiPatterns ?? []).map(
    compileAntiPattern,
  );
  const perPrinciple: Record<string, CompiledAntiPattern[]> = {};
  for (const p of spec.soulPurpose.designPrinciples) {
    perPrinciple[p.id] = (p.antiPatterns ?? []).map(compileAntiPattern);
  }
  const voiceAntiPatterns = (spec.brandIdentity?.voiceAntiPatterns ?? []).map(compileAntiPattern);
  const visualAntiPatterns = (spec.brandIdentity?.visualIdentity?.visualAntiPatterns ?? []).map(
    compileAntiPattern,
  );

  const antiPatternLists: CompiledAntiPatternLists = {
    product: productAntiPatterns,
    perPrinciple,
    voice: voiceAntiPatterns,
    visual: visualAntiPatterns,
  };

  // 4. Measurable signals (principle + visual)
  const measurableSignals: CompiledMeasurableSignal[] = [];
  for (const principle of spec.soulPurpose.designPrinciples) {
    for (const sig of principle.measurableSignals ?? []) {
      measurableSignals.push({
        id: sig.id,
        metric: sig.metric,
        threshold: sig.threshold,
        operator: sig.operator,
        scope: sig.scope,
        sourcePrinciple: principle.id,
        identityClass: sig.identityClass ?? principle.identityClass ?? 'evolving',
      });
    }
  }
  for (const vc of spec.brandIdentity?.visualIdentity?.visualConstraints ?? []) {
    measurableSignals.push(compileVisualConstraintSignal(vc));
  }

  // 5. SA-1 BM25 corpus (mission + experientialTargets)
  const bm25Docs: Bm25Document[] = [];
  const missionDoc = buildBm25Document(
    'mission',
    spec.soulPurpose.mission.value,
    ic(spec.soulPurpose.mission),
  );
  if (missionDoc) bm25Docs.push(missionDoc);
  for (const [name, target] of Object.entries(spec.experientialTargets ?? {})) {
    if (!target) continue;
    const doc = buildBm25Document(
      `experientialTargets.${name}`,
      JSON.stringify(target),
      ic(target),
    );
    if (doc) bm25Docs.push(doc);
  }

  const bm25Corpus: Bm25Corpus = { documents: bm25Docs };

  // 6. SA-2 principle corpora
  const principleCorpora: PrincipleCorpora = {};
  for (const principle of spec.soulPurpose.designPrinciples) {
    principleCorpora[principle.id] = buildPrincipleCorpus(principle);
  }

  return {
    didName: did.metadata.name,
    namespace: did.metadata.namespace,
    sourceHash: hashDidSpec(did),
    scopeLists,
    constraintRules,
    antiPatternLists,
    measurableSignals,
    bm25Corpus,
    principleCorpora,
  };
}

function compileVisualConstraintSignal(vc: VisualConstraint): CompiledMeasurableSignal {
  return {
    id: vc.id,
    metric: vc.rule.metric,
    threshold: vc.rule.threshold,
    operator: vc.rule.operator,
    sourceVisual: vc.id,
    identityClass: ic(vc),
  };
}

function buildPrincipleCorpus(principle: DesignPrinciple): Bm25Corpus {
  const pic = principle.identityClass ?? 'evolving';
  const docs: Bm25Document[] = [];
  const nameDoc = buildBm25Document(`${principle.id}.name`, principle.name, pic);
  if (nameDoc) docs.push(nameDoc);
  const descDoc = buildBm25Document(`${principle.id}.description`, principle.description, pic);
  if (descDoc) docs.push(descDoc);
  for (const sig of principle.measurableSignals ?? []) {
    const doc = buildBm25Document(
      `${principle.id}.signal.${sig.id}`,
      `${sig.metric} ${sig.operator} ${sig.threshold}`,
      sig.identityClass ?? pic,
    );
    if (doc) docs.push(doc);
  }
  for (const ap of principle.antiPatterns ?? []) {
    const doc = buildBm25Document(
      `${principle.id}.antipattern.${ap.id}`,
      `${ap.label} ${ap.detectionPatterns.join(' ')}`,
      ap.identityClass ?? pic,
    );
    if (doc) docs.push(doc);
  }
  return { documents: docs };
}

// ── Phase-2b readiness validation ────────────────────────────────────

export interface ReadinessResult {
  ready: boolean;
  gaps: string[];
}

/**
 * Enforce the §B.10.2 minimums a DID must meet before Phase-2b scoring
 * is safe to enable. Returns a list of gaps; empty ⇒ ready.
 */
export function validatePhase2bReadiness(compiled: CompiledDid): ReadinessResult {
  const gaps: string[] = [];

  // ≥ 2 constraints with ≥ 3 detection patterns
  const qualifyingConstraints = compiled.constraintRules.filter(
    (c) => c.detectionPatterns.length >= 3,
  );
  if (qualifyingConstraints.length < 2) {
    gaps.push(
      `Need ≥2 constraints with ≥3 detection patterns each (got ${qualifyingConstraints.length})`,
    );
  }

  // ≥ 3 outOfScope entries with ≥ 2 synonyms
  const outOfScopeOk = compiled.scopeLists.outOfScope.filter((s) => s.synonyms.length >= 2);
  if (outOfScopeOk.length < 3) {
    gaps.push(`Need ≥3 outOfScope entries with ≥2 synonyms each (got ${outOfScopeOk.length})`);
  }

  // ≥ 3 product-level antiPatterns with ≥ 3 patterns
  const productAntiOk = compiled.antiPatternLists.product.filter(
    (a) => a.detectionPatterns.length >= 3,
  );
  if (productAntiOk.length < 3) {
    gaps.push(
      `Need ≥3 product-level antiPatterns with ≥3 detection patterns each (got ${productAntiOk.length})`,
    );
  }

  // ≥ 1 principle with ≥ 2 antiPatterns having ≥ 2 patterns each
  const principlesWithAnti = Object.entries(compiled.antiPatternLists.perPrinciple).filter(
    ([, list]) => list.filter((a) => a.detectionPatterns.length >= 2).length >= 2,
  );
  if (principlesWithAnti.length < 1) {
    gaps.push('Need ≥1 designPrinciple with ≥2 antiPatterns (each with ≥2 detection patterns)');
  }

  // ≥ 2 voice antiPatterns with ≥ 2 patterns
  const voiceOk = compiled.antiPatternLists.voice.filter((a) => a.detectionPatterns.length >= 2);
  if (voiceOk.length < 2) {
    gaps.push(`Need ≥2 voice antiPatterns with ≥2 detection patterns each (got ${voiceOk.length})`);
  }

  // ≥ 2 visual antiPatterns with ≥ 2 patterns
  const visualOk = compiled.antiPatternLists.visual.filter((a) => a.detectionPatterns.length >= 2);
  if (visualOk.length < 2) {
    gaps.push(
      `Need ≥2 visual antiPatterns with ≥2 detection patterns each (got ${visualOk.length})`,
    );
  }

  return { ready: gaps.length === 0, gaps };
}

// ── State-store serialization helpers ────────────────────────────────

export function serializeForStore(compiled: CompiledDid): {
  didName: string;
  namespace?: string;
  sourceHash: string;
  scopeListsJson: string;
  constraintRulesJson: string;
  antiPatternListsJson: string;
  measurableSignalsJson: string;
  bm25CorpusBlob: Buffer;
  principleCorporaBlob: Buffer;
} {
  return {
    didName: compiled.didName,
    namespace: compiled.namespace,
    sourceHash: compiled.sourceHash,
    scopeListsJson: canonicalJson(compiled.scopeLists),
    constraintRulesJson: canonicalJson(compiled.constraintRules),
    antiPatternListsJson: canonicalJson(compiled.antiPatternLists),
    measurableSignalsJson: canonicalJson(compiled.measurableSignals),
    bm25CorpusBlob: Buffer.from(canonicalJson(compiled.bm25Corpus), 'utf-8'),
    principleCorporaBlob: Buffer.from(canonicalJson(compiled.principleCorpora), 'utf-8'),
  };
}

export function deserializeFromStore(record: {
  didName: string;
  namespace?: string;
  sourceHash: string;
  scopeListsJson?: string;
  constraintRulesJson?: string;
  antiPatternListsJson?: string;
  measurableSignalsJson?: string;
  bm25CorpusBlob?: Buffer;
  principleCorporaBlob?: Buffer;
}): CompiledDid {
  const parse = <T>(json: string | undefined, fallback: T): T =>
    json ? (JSON.parse(json) as T) : fallback;
  const parseBuffer = <T>(buf: Buffer | undefined, fallback: T): T =>
    buf ? (JSON.parse(buf.toString('utf-8')) as T) : fallback;

  return {
    didName: record.didName,
    namespace: record.namespace,
    sourceHash: record.sourceHash,
    scopeLists: parse(record.scopeListsJson, { inScope: [], outOfScope: [] } as CompiledScopeLists),
    constraintRules: parse(record.constraintRulesJson, [] as CompiledConstraintRule[]),
    antiPatternLists: parse(record.antiPatternListsJson, {
      product: [],
      perPrinciple: {},
      voice: [],
      visual: [],
    } as CompiledAntiPatternLists),
    measurableSignals: parse(record.measurableSignalsJson, [] as CompiledMeasurableSignal[]),
    bm25Corpus: parseBuffer(record.bm25CorpusBlob, { documents: [] } as Bm25Corpus),
    principleCorpora: parseBuffer(record.principleCorporaBlob, {} as PrincipleCorpora),
  };
}
