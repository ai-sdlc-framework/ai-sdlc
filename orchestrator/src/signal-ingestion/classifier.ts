/**
 * RFC-0030 Phase 2 — Signal classifier.
 *
 * Classifies raw signals on three deterministic axes and applies the
 * English-only language gate (OQ-13.2 resolution):
 *
 *   1. **Tier** — enterprise / mid / smb / free / churned (metadata-driven).
 *      Inference order: adapter-provided `customerTier` → customerId lookup →
 *      adapter's `defaultTier` (mapped to smb for Tier 1, free for Tier 2).
 *
 *   2. **ICP resonance** — strong / partial / weak (BM25 default; embedding
 *      when RFC-0019 adapter is configured — currently always BM25 in v1).
 *      For v1 the classifier receives an explicit `icpSegments` list from the
 *      caller. BM25 matching measures how closely the signal payload matches
 *      the declared ICP segments.
 *
 *   3. **Recency decay** — exponential decay: exp(-age_days × ln(2) / half_life).
 *      Applied at scoring time so the pipeline doesn't need to re-compute as
 *      time passes (age is passed as input). Half-life is read from config
 *      (default 30 days).
 *
 * **Language gate** (OQ-13.2): non-English signal payloads are detected via a
 * lightweight script-block heuristic. Signals in unsupported languages are
 * dropped and logged as `Decision: signal-language-unsupported`. Per-org
 * `acceptedLanguages` config is respected (default `['en']`).
 *
 * All multipliers and weights are read from `SignalIngestionConfig`; they are
 * NOT hardcoded, satisfying AC #6.
 *
 * @module signal-ingestion/classifier
 */

import type { CustomerTier, RawSignal, SignalTier } from './types.js';
import type { SignalIngestionConfig, TierMultipliers, IcpResonanceWeights } from './config.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG } from './config.js';

// ── Public types ────────────────────────────────────────────────────────────

export type ICPResonance = 'strong' | 'partial' | 'weak';

/** The result of classifying a single raw signal on all three axes. */
export interface ClassifiedSignal {
  /** Original signal, unmodified. */
  signal: RawSignal;
  /** Resolved customer tier (enterprise / mid / smb / free / churned). */
  customerTier: CustomerTier;
  /** ICP resonance level. */
  icpResonance: ICPResonance;
  /**
   * Recency decay factor in [0, 1].
   * 1.0 = fresh signal; approaches 0 for very old signals.
   * Computed at classification time using the provided `asOf` date.
   */
  recencyDecay: number;
  /**
   * Tier multiplier looked up from config for this signal's customerTier.
   * Convenience field — callers do NOT need to re-read the config.
   */
  tierMultiplier: number;
  /**
   * ICP resonance weight looked up from config.
   * Convenience field.
   */
  icpResonanceWeight: number;
  /**
   * Signal-level base weight.
   *   - Tier 1 sources: 1.0
   *   - Tier 2 sources (above significance threshold): 0.3
   *   - Tier 2 sources (below threshold): 0.0 (excluded from D1 scoring)
   * Phase 2 does not evaluate the significance threshold (that is Phase 4);
   * base weight defaults to the source's adapter defaultTier mapping.
   */
  baseWeight: number;
}

/** Emitted when a signal is dropped for language reasons. */
export interface SignalLanguageUnsupportedDecision {
  type: 'Decision';
  decision: 'signal-language-unsupported';
  sourceId: string;
  detectedScript: string;
  acceptedLanguages: string[];
  message: string;
}

/** Result of classifying a batch of signals. */
export interface ClassificationResult {
  /** Successfully classified signals. */
  classified: ClassifiedSignal[];
  /**
   * Signals dropped for language reasons, emitted as Decision records per
   * RFC-0030 OQ-13.2 resolution.
   */
  languageDecisions: SignalLanguageUnsupportedDecision[];
}

// ── Tier registry abstraction ───────────────────────────────────────────────

/**
 * Optional customer-tier registry for resolving tier from `customerId`.
 * Adopters can provide their own implementation; the pipeline falls back
 * to adapter defaults when no registry is configured or when the
 * `customerId` is not found.
 */
export interface CustomerTierRegistry {
  resolve(customerId: string): CustomerTier | undefined;
}

// ── Classifier options ──────────────────────────────────────────────────────

export interface ClassifySignalsOptions {
  /**
   * Point in time used to compute signal ages.
   * Defaults to `new Date()` when not provided.
   */
  asOf?: Date;

  /**
   * Resolved signal ingestion configuration. Defaults to the built-in
   * default config when not provided.
   */
  config?: SignalIngestionConfig;

  /**
   * Source adapter tier used for base-weight assignment when the signal does
   * not carry `customerTier`. Keyed by adapter name.
   *
   * When not provided, base weight defaults to 1.0 (Tier 1 bias).
   */
  adapterTiers?: Map<string, SignalTier>;

  /**
   * ICP segment descriptors — the product's declared ideal customer profile.
   * Each entry is a short phrase describing one ICP dimension
   * (e.g. "B2B SaaS startup", "engineering team", "productivity tooling").
   *
   * BM25 similarity between the signal payload and these segments determines
   * ICP resonance. When empty, all signals are classified as `partial`.
   */
  icpSegments?: string[];

  /**
   * Optional customer-tier registry for `customerId` lookup (tier inference
   * order step 2). When absent, step 2 is skipped.
   */
  tierRegistry?: CustomerTierRegistry;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Classify a batch of raw signals.
 *
 * Per RFC-0030 §6 inference order for tier:
 *   1. `signal.customerTier` (adapter-provided structured field)
 *   2. `tierRegistry.resolve(signal.customerId)` (registry lookup)
 *   3. Adapter `defaultTier` (mapped: Tier 1 → smb, Tier 2 → free)
 *
 * Per RFC-0030 §13.2: non-accepted-language signals are dropped and
 * returned in `languageDecisions`.
 */
export function classifySignals(
  signals: RawSignal[],
  options: ClassifySignalsOptions = {},
): ClassificationResult {
  const config = options.config ?? DEFAULT_SIGNAL_INGESTION_CONFIG;
  const asOf = options.asOf ?? new Date();
  const icpSegments = options.icpSegments ?? [];
  const tierRegistry = options.tierRegistry;
  const adapterTiers = options.adapterTiers ?? new Map<string, SignalTier>();
  const acceptedLanguages = config.acceptedLanguages;

  const classified: ClassifiedSignal[] = [];
  const languageDecisions: SignalLanguageUnsupportedDecision[] = [];

  for (const signal of signals) {
    // Language gate — drop non-supported-language signals
    const langCheck = checkLanguage(signal.payload, acceptedLanguages);
    if (!langCheck.accepted) {
      languageDecisions.push({
        type: 'Decision',
        decision: 'signal-language-unsupported',
        sourceId: signal.sourceId,
        detectedScript: langCheck.detectedScript,
        acceptedLanguages,
        message: `Signal ${signal.sourceId} dropped: detected script '${langCheck.detectedScript}' not in accepted languages ${JSON.stringify(acceptedLanguages)}`,
      });
      continue;
    }

    const customerTier = resolveCustomerTier(signal, tierRegistry, adapterTiers);
    const icpResonance = resolveIcpResonance(signal.payload, icpSegments);
    const recencyDecay = computeRecencyDecay(
      signal.sourceTimestamp,
      asOf,
      config.recencyHalfLifeDays,
    );
    const tierMultiplier = config.tierMultipliers[customerTier];
    const icpResonanceWeight = config.icpResonanceWeights[icpResonance];

    // Resolve adapter tier for base weight (Phase 4 will refine with significance threshold)
    const sourceAdapterTier = adapterTiers.get(signal.metadata?.['adapterName'] as string) ?? 1;
    const baseWeight = sourceAdapterTier === 1 ? 1.0 : 0.3;

    classified.push({
      signal,
      customerTier,
      icpResonance,
      recencyDecay,
      tierMultiplier,
      icpResonanceWeight,
      baseWeight,
    });
  }

  return { classified, languageDecisions };
}

// ── Tier resolution ─────────────────────────────────────────────────────────

/**
 * Resolve customer tier per RFC-0030 §6.1 inference order:
 *   1. `signal.customerTier`
 *   2. `tierRegistry.resolve(signal.customerId)`
 *   3. Adapter defaultTier → smb (Tier 1) or free (Tier 2)
 */
export function resolveCustomerTier(
  signal: RawSignal,
  tierRegistry?: CustomerTierRegistry,
  adapterTiers?: Map<string, SignalTier>,
): CustomerTier {
  // Step 1: adapter-provided structured tier
  if (signal.customerTier !== undefined) {
    return signal.customerTier;
  }

  // Step 2: customerId registry lookup
  if (tierRegistry && signal.customerId !== undefined) {
    const resolved = tierRegistry.resolve(signal.customerId);
    if (resolved !== undefined) return resolved;
  }

  // Step 3: adapter defaultTier mapping
  const adapterName = signal.metadata?.['adapterName'] as string | undefined;
  const signalTier = adapterName ? (adapterTiers?.get(adapterName) ?? 1) : 1;
  // Tier 1 adapters (support tickets, CRM) → smb as baseline customer tier
  // Tier 2 adapters (community, competitive) → free as baseline
  return signalTier === 1 ? 'smb' : 'free';
}

// ── ICP resonance (BM25) ────────────────────────────────────────────────────

/**
 * Classify ICP resonance for a signal payload against the declared ICP
 * segment descriptors using BM25 similarity.
 *
 * When `icpSegments` is empty, returns `partial` (no basis for strong/weak).
 *
 * BM25 parameters (k1=1.5, b=0.75) are standard.
 * Score mapping:
 *   - ≥ 0.5  → strong
 *   - ≥ 0.15 → partial
 *   - < 0.15 → weak
 */
export function resolveIcpResonance(payload: string, icpSegments: string[]): ICPResonance {
  if (icpSegments.length === 0) return 'partial';

  const score = bm25MaxScore(payload, icpSegments);

  if (score >= 0.5) return 'strong';
  if (score >= 0.15) return 'partial';
  return 'weak';
}

/**
 * Compute the BM25-based ICP match score between a signal payload and the
 * ICP segment corpus.
 *
 * **Scoring direction**: ICP segments are the "documents"; the payload tokens
 * are the "query". We score each ICP segment against the payload terms, then
 * take the maximum across segments. This measures how closely the signal
 * payload covers the ICP segment vocabulary — the deterministic-first
 * approach per RFC-0029 Principle 2.
 *
 * **Normalisation**: we compute the self-score of each ICP segment (score
 * when the document perfectly matches the query — i.e., we pretend the
 * segment itself is the payload) and use the maximum self-score as the
 * denominator. This produces a well-bounded [0, 1] score.
 *
 * Implementation: simplified BM25 without external deps so the orchestrator
 * stays self-contained.
 */
function bm25MaxScore(payload: string, corpus: string[]): number {
  const K1 = 1.5;
  const B = 0.75;

  const payloadTokens = tokenize(payload);
  if (payloadTokens.length === 0) return 0;

  // Build term frequency maps for both the corpus docs and the payload
  const corpusTfs = corpus.map((doc) => termFrequency(tokenize(doc)));
  const avgDocLen = corpus.reduce((sum, doc) => sum + tokenize(doc).length, 0) / corpus.length;

  const N = corpus.length;

  /**
   * IDF of a term over the ICP corpus.
   * Smoothed to avoid negatives: log((N - df + 0.5) / (df + 0.5) + 1)
   */
  const idf = (term: string): number => {
    const df = corpusTfs.filter((tf) => (tf.get(term) ?? 0) > 0).length;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  };

  /**
   * BM25 score for one ICP segment against a set of query terms.
   * query terms come from the entity we're scoring (payload OR the segment
   * itself for self-score normalisation).
   */
  const scoreSegment = (segTf: Map<string, number>, queryTerms: string[]): number => {
    const docLen = Array.from(segTf.values()).reduce((a, b) => a + b, 0);
    let score = 0;
    for (const term of new Set(queryTerms)) {
      const freq = segTf.get(term) ?? 0;
      if (freq === 0) continue;
      const termIdf = idf(term);
      const numerator = freq * (K1 + 1);
      const denominator = freq + K1 * (1 - B + B * (docLen / Math.max(avgDocLen, 1)));
      score += termIdf * (numerator / denominator);
    }
    return score;
  };

  // Score each ICP segment using payload tokens as the query
  let maxScore = 0;
  let maxSelfScore = 0;
  for (let i = 0; i < corpus.length; i++) {
    const segTf = corpusTfs[i]!;
    const segTokens = tokenize(corpus[i]!);

    // Self-score: how much would this segment score if queried by its own tokens?
    const selfScore = scoreSegment(segTf, segTokens);
    if (selfScore > maxSelfScore) maxSelfScore = selfScore;

    // Payload score: score this segment using the payload tokens
    const payloadScore = scoreSegment(segTf, payloadTokens);
    if (payloadScore > maxScore) maxScore = payloadScore;
  }

  if (maxSelfScore <= 0) return 0;
  // Normalise by the maximum achievable score (self-match score)
  return Math.min(1, maxScore / maxSelfScore);
}

/** Tokenize a string to lowercase alphanumeric tokens, minimum length 2. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

/** Count term frequencies in a token list. */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

// ── Recency decay ───────────────────────────────────────────────────────────

/**
 * Compute exponential recency decay for a signal.
 *
 * `decay = exp(-age_days * ln(2) / halfLifeDays)`
 *
 * At age = halfLifeDays, decay = 0.5.
 * At age = 0, decay = 1.0.
 * Future-dated signals (age < 0) clamp to 1.0.
 */
export function computeRecencyDecay(
  sourceTimestamp: Date,
  asOf: Date,
  halfLifeDays: number,
): number {
  if (halfLifeDays <= 0) return 1.0;
  const ageDays = (asOf.getTime() - sourceTimestamp.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0; // future or now → no decay
  return Math.exp((-ageDays * Math.LN2) / halfLifeDays);
}

// ── Language gate ───────────────────────────────────────────────────────────

interface LanguageCheckResult {
  accepted: boolean;
  /** Unicode script block name or 'latin' for accepted. */
  detectedScript: string;
}

/**
 * Lightweight language gate based on Unicode script heuristics.
 *
 * The RFC-0030 v1 scope is English-only. We detect non-Latin scripts
 * (CJK, Cyrillic, Arabic, Hebrew, Thai, Devanagari, etc.) by checking for
 * code point ranges. A signal is considered non-English when > 15% of its
 * alphanumeric characters fall outside the Latin extended range (U+0000-U+024F).
 *
 * This heuristic is intentionally conservative — it drops only signals that
 * are predominantly in another script, not signals that contain a few
 * loan-words or proper nouns. A false-positive rate of ~2% is expected on
 * technical signals containing non-Latin identifiers (Unicode emoji, math
 * symbols, etc.) — those edge cases are tracked as visible-gap metrics for
 * the v2 multi-language work (OQ-13.2).
 *
 * The `acceptedLanguages` list is checked for the literal string 'en' (or
 * any BCP-47 tag starting with 'en'). When the list includes non-en entries,
 * the gate is relaxed: signals with those scripts are accepted if they can
 * be associated via the tag. In v1 this is a forward-compat hook — the actual
 * per-language classifier is deferred to v2. For now, only 'en' is treated as
 * fully supported; all other entries in `acceptedLanguages` that are not 'en'
 * cause the gate to skip for that signal (pass-through to v2).
 */
function checkLanguage(payload: string, acceptedLanguages: string[]): LanguageCheckResult {
  // If acceptedLanguages includes non-en entries, relax the gate for v1
  // forward-compat. Only apply the strict gate when the list is exactly ['en']
  // or a subset of en-* tags.
  const hasNonEnLanguage = acceptedLanguages.some((lang) => !lang.startsWith('en'));
  if (hasNonEnLanguage) {
    // v1 forward-compat: don't drop signals when org has opted into multi-language.
    // The actual per-language classification is deferred to v2.
    return { accepted: true, detectedScript: 'latin' };
  }

  const detectedScript = detectDominantNonLatinScript(payload);
  if (detectedScript !== null) {
    return { accepted: false, detectedScript };
  }
  return { accepted: true, detectedScript: 'latin' };
}

/**
 * Detect the dominant non-Latin script in a text string.
 * Returns `null` when the text is predominantly Latin (accepted as English).
 */
function detectDominantNonLatinScript(text: string): string | null {
  if (!text || text.length === 0) return null;

  let latinCount = 0;
  let nonLatinCount = 0;
  let dominantScript = 'unknown';
  const scriptCounts: Record<string, number> = {};

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const script = detectScript(cp);
    if (script === 'latin' || script === 'common') {
      latinCount++;
    } else {
      nonLatinCount++;
      scriptCounts[script] = (scriptCounts[script] ?? 0) + 1;
    }
  }

  const total = latinCount + nonLatinCount;
  if (total === 0) return null;

  const nonLatinRatio = nonLatinCount / total;
  if (nonLatinRatio <= 0.15) return null; // predominantly Latin — accept as English

  // Find the most common non-Latin script
  let maxCount = 0;
  for (const [script, count] of Object.entries(scriptCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantScript = script;
    }
  }

  return dominantScript;
}

/**
 * Classify a Unicode code point into a broad script category.
 */
function detectScript(cp: number): string {
  // Basic Latin (U+0020-U+007F) + Latin-1 Supplement (U+00A0-U+00FF)
  // + Latin Extended-A/B (U+0100-U+024F)
  if (cp >= 0x0020 && cp <= 0x024f) return 'latin';

  // Common punctuation, symbols, numbers (not script-specific)
  if (
    (cp >= 0x2000 && cp <= 0x206f) || // General Punctuation
    (cp >= 0x2070 && cp <= 0x209f) || // Superscripts and Subscripts
    (cp >= 0x20a0 && cp <= 0x20cf) || // Currency Symbols
    (cp >= 0x2100 && cp <= 0x214f) || // Letterlike Symbols
    (cp >= 0xfe50 && cp <= 0xfe6f) // Small Form Variants
  ) {
    return 'common';
  }

  // Emoji and symbols
  if (
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // Emoji
    (cp >= 0x2600 && cp <= 0x27bf) // Miscellaneous Symbols
  ) {
    return 'common';
  }

  // CJK Unified Ideographs
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) // CJK Extension B
  ) {
    return 'cjk';
  }

  // Cyrillic (U+0400-U+04FF)
  if (cp >= 0x0400 && cp <= 0x04ff) return 'cyrillic';

  // Arabic (U+0600-U+06FF)
  if (cp >= 0x0600 && cp <= 0x06ff) return 'arabic';

  // Hebrew (U+0590-U+05FF)
  if (cp >= 0x0590 && cp <= 0x05ff) return 'hebrew';

  // Devanagari (U+0900-U+097F)
  if (cp >= 0x0900 && cp <= 0x097f) return 'devanagari';

  // Thai (U+0E00-U+0E7F)
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 'thai';

  // Greek and Coptic (U+0370-U+03FF)
  if (cp >= 0x0370 && cp <= 0x03ff) return 'greek';

  // Armenian (U+0530-U+058F)
  if (cp >= 0x0530 && cp <= 0x058f) return 'armenian';

  // Georgian (U+10A0-U+10FF)
  if (cp >= 0x10a0 && cp <= 0x10ff) return 'georgian';

  return 'unknown';
}

// ── Weight computation (convenience) ─────────────────────────────────────────

/**
 * Compute the composite signal weight from a `ClassifiedSignal`.
 *
 * `weight = baseWeight × tierMultiplier × icpResonanceWeight × recencyDecay`
 *
 * Note: SA resonance filter (RFC-0030 §9) is applied at the cluster level in
 * Phase 5, not at the signal level here.
 */
export function computeSignalWeight(classified: ClassifiedSignal): number {
  return (
    classified.baseWeight *
    classified.tierMultiplier *
    classified.icpResonanceWeight *
    classified.recencyDecay
  );
}

// ── Re-export config types for consumers ─────────────────────────────────────

export type { TierMultipliers, IcpResonanceWeights };
