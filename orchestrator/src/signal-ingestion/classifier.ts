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
 * **Language gate** (OQ-13.2 v0.3 re-walkthrough): non-accepted-language signal
 * payloads are detected via the `franc` library (deterministic; <10ms per
 * signal; JS-native; MIT-licensed; 95%+ accuracy on text >50 chars; returns
 * ISO 639-3 codes). Signals in unsupported languages are dropped and logged as
 * `Decision: signal-language-unsupported`. Per-org `acceptedLanguages` config
 * is respected (default `['en']`); multi-language opt-in (e.g. `['en', 'fr',
 * 'es']`) accepts those languages knowingly — adopters take on documented BM25
 * quality degradation (~15-30% precision drop without per-language stopwords)
 * in exchange for non-English signal coverage.
 *
 * All multipliers and weights are read from `SignalIngestionConfig`; they are
 * NOT hardcoded, satisfying AC #6.
 *
 * @module signal-ingestion/classifier
 */

import { franc, francAll } from 'franc';
import type { CustomerTier, RawSignal, SignalTier } from './types.js';
import type {
  LanguageDetectionConfig,
  SignalIngestionConfig,
  TierMultipliers,
  IcpResonanceWeights,
} from './config.js';
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
   *   - Tier 2 sources: 0.3 in Phase 2 (significance-threshold evaluation
   *     is Phase 4's job; Phase 4 will downgrade to 0.0 for Tier 2 sources
   *     below threshold, excluding them from D1 scoring).
   * Phase 4/5 consumers MUST NOT rely on `baseWeight === 0` to detect
   * exclusions until Phase 4 ships — Phase 2 never emits 0.0.
   */
  baseWeight: number;
}

/** Emitted when a signal is dropped for language reasons (RFC-0030 OQ-13.2 v0.3). */
export interface SignalLanguageUnsupportedDecision {
  type: 'Decision';
  decision: 'signal-language-unsupported';
  sourceId: string;
  /**
   * Detected language as ISO 639-3 three-letter code (e.g. `'cmn'`, `'fra'`,
   * `'spa'`, `'eng'`). `'und'` when text was too short or no script matched.
   * For backwards compatibility with v0.2 dashboards reading `detectedScript`,
   * a coarse script family hint (`'cjk'`, `'cyrillic'`, `'arabic'`, `'latin'`)
   * may still be derivable from the language code via the franc data tables.
   */
  detectedLanguage: string;
  /**
   * @deprecated since v0.3 — use `detectedLanguage`. Retained for one release
   * window so downstream consumers (TUI, runbook examples) can migrate.
   * Populated with a coarse script-family hint derived from `detectedLanguage`
   * (`'cjk'`, `'cyrillic'`, `'arabic'`, `'hebrew'`, `'devanagari'`, `'thai'`,
   * `'greek'`, `'armenian'`, `'georgian'`, `'latin'`, or `'unknown'`).
   */
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
  const languageDetection = config.languageDetection;

  const classified: ClassifiedSignal[] = [];
  const languageDecisions: SignalLanguageUnsupportedDecision[] = [];

  for (const signal of signals) {
    // Language gate — drop non-accepted-language signals
    const langCheck = checkLanguage(signal.payload, acceptedLanguages, languageDetection);
    if (!langCheck.accepted) {
      languageDecisions.push({
        type: 'Decision',
        decision: 'signal-language-unsupported',
        sourceId: signal.sourceId,
        detectedLanguage: langCheck.detectedLanguage,
        detectedScript: langCheck.detectedScript,
        acceptedLanguages,
        message: `Signal ${signal.sourceId} dropped: detected language '${langCheck.detectedLanguage}' (script '${langCheck.detectedScript}') not in accepted languages ${JSON.stringify(acceptedLanguages)}`,
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
  /** ISO 639-3 code from `franc` (e.g. `'eng'`, `'cmn'`, `'fra'`, `'und'`). */
  detectedLanguage: string;
  /** Coarse script-family hint for backwards compat with v0.2 dashboards. */
  detectedScript: string;
}

/**
 * Language gate using the `franc` trigram-based detector (RFC-0030 OQ-13.2
 * v0.3 re-walkthrough resolution).
 *
 * `franc` returns ISO 639-3 three-letter codes (`'eng'`, `'cmn'`, `'fra'`,
 * `'spa'`, etc.) or `'und'` for undetermined text (too short / no script
 * match). It is deterministic, MIT-licensed, JS-native (no model download),
 * runs in <10ms per signal, and is 95%+ accurate on text >50 characters.
 *
 * Behaviour:
 *  - The language-tag matcher accepts BCP-47 / ISO 639-1 / ISO 639-3 forms in
 *    `acceptedLanguages` (e.g. `'en'`, `'eng'`, `'en-US'` all match English).
 *  - Empty payloads return `accepted: true` (nothing to gate on; downstream
 *    classifier handles empty-payload signals).
 *  - When `franc` returns `'und'` (text too short, no script matched, or
 *    `library: 'none'`), behaviour is controlled by
 *    `languageDetection.onUndetermined` — `'accept'` (default) is conservative
 *    because the dominant short-payload case is legitimate (e.g. "Crash on
 *    save", "BUG: 500"); `'drop'` is strict.
 *  - When `library: 'none'`, the gate is disabled entirely — all signals
 *    accepted regardless of `acceptedLanguages`. Useful for testing or for
 *    adopters that pre-filter signals upstream.
 *  - **Fuzzy acceptance via francAll top-N**: short technical English (under
 *    ~50 chars; e.g. "auth login failure when SAML callback returns no nonce")
 *    can misdetect as Nordic / Latin-script neighbours (nno, nld, dan) due to
 *    uncommon trigrams. To avoid false-drops on legitimate English, we accept
 *    when ANY accepted language appears in the top-N candidates with a relative
 *    score ≥ `TOP_N_ACCEPT_THRESHOLD` of the top hit. This is the standard
 *    franc-misclassification workaround documented in
 *    https://github.com/wooorm/franc#data
 */
function checkLanguage(
  payload: string,
  acceptedLanguages: string[],
  languageDetection: LanguageDetectionConfig,
): LanguageCheckResult {
  // Empty payload — nothing to gate on.
  if (!payload || payload.length === 0) {
    return { accepted: true, detectedLanguage: 'und', detectedScript: 'unknown' };
  }

  // `library: 'none'` disables the gate entirely.
  if (languageDetection.library === 'none') {
    return { accepted: true, detectedLanguage: 'und', detectedScript: 'unknown' };
  }

  // Top language for reporting purposes (Decision payload + script hint).
  const detectedLanguage = franc(payload, { minLength: languageDetection.minDetectionLength });
  const detectedScript = scriptHintFor(detectedLanguage);

  // 'und' — text too short OR no script matched — handle per config policy.
  if (detectedLanguage === 'und') {
    if (languageDetection.onUndetermined === 'accept') {
      return { accepted: true, detectedLanguage, detectedScript };
    }
    return { accepted: false, detectedLanguage, detectedScript };
  }

  // Top-of-list match — fast path.
  if (languageMatchesAccepted(detectedLanguage, acceptedLanguages)) {
    return { accepted: true, detectedLanguage, detectedScript };
  }

  // Fuzzy acceptance via script-prefiltered candidate list. `francAll` only
  // returns languages whose SCRIPT matches the input — Chinese text returns
  // only CJK languages; Cyrillic text returns only Cyrillic languages. So if
  // any accepted language appears at all in the candidate list (above a low
  // relative-score floor), the input shares a script family with an accepted
  // language — which is the load-bearing signal we care about. Short technical
  // English may misclassify the TOP slot as nno/dan/nld, but `eng` will still
  // appear in the list with a high relative score because the script
  // (Latin-script) matches. Genuinely-foreign signals (Chinese, Arabic, Hindi)
  // exclude `eng` from the list entirely via the script prefilter.
  const allCandidates = francAll(payload, {
    minLength: languageDetection.minDetectionLength,
  });
  for (const [lang, score] of allCandidates) {
    if (score < FUZZY_ACCEPT_SCORE_FLOOR) break;
    if (languageMatchesAccepted(lang, acceptedLanguages)) {
      return { accepted: true, detectedLanguage: lang, detectedScript: scriptHintFor(lang) };
    }
  }

  return { accepted: false, detectedLanguage, detectedScript };
}

/**
 * Minimum relative score (normalised against the top hit's 1.0) for a
 * candidate to be considered for fuzzy acceptance. 0.80 is permissive enough
 * to catch English misclassified as Nordic in short technical bug reports
 * (typical eng-score for sub-60-char English is 0.85-0.98) while still
 * excluding genuinely-distant guesses (franc rarely puts distant-script
 * languages above 0.5 because the script prefilter already excludes them).
 *
 * The load-bearing protection against false-accepts of foreign-script text is
 * franc's built-in SCRIPT PREFILTER: Chinese text returns only CJK
 * candidates, Arabic text returns only Arabic candidates, etc. The fuzzy
 * threshold here only matters for Latin-script close-runners-up.
 */
const FUZZY_ACCEPT_SCORE_FLOOR = 0.8;

/**
 * Check whether a franc-detected ISO 639-3 code matches any of the
 * adopter-configured accepted-language tags.
 *
 * Accepts the common forms in `acceptedLanguages`:
 *  - ISO 639-3 three-letter codes: `'eng'`, `'fra'`, `'spa'`, `'cmn'`, …
 *  - ISO 639-1 two-letter codes: `'en'`, `'fr'`, `'es'`, `'zh'`, …
 *  - BCP-47 regional tags: `'en-US'`, `'fr-CA'`, `'zh-Hans'`, … (prefix matched
 *    against the two-letter base code)
 *
 * The two-letter ↔ three-letter mapping covers the most common languages
 * adopters opt into; uncommon languages can be specified directly in their
 * ISO 639-3 form to bypass the mapping.
 */
function languageMatchesAccepted(detectedIso6393: string, acceptedLanguages: string[]): boolean {
  for (const raw of acceptedLanguages) {
    const tag = raw.toLowerCase();
    // Exact ISO 639-3 match (e.g. 'eng' === 'eng').
    if (tag === detectedIso6393) return true;
    // Two-letter ISO 639-1 (or BCP-47 prefix) match via the mapping table.
    const base = tag.split('-')[0]!; // 'en' from 'en-US', 'en' from 'en'
    const mapped = ISO_639_1_TO_639_3[base];
    if (mapped && mapped === detectedIso6393) return true;
  }
  return false;
}

/**
 * Two-letter ISO 639-1 → three-letter ISO 639-3 mapping for the most common
 * languages adopters opt into. Not exhaustive — uncommon languages should be
 * configured directly in their ISO 639-3 form (e.g. `'tgl'` for Tagalog).
 *
 * Source: ISO 639 standard cross-reference. The list intentionally includes
 * the languages most likely to appear in multi-language customer-support
 * pipelines (top ~30 languages by speaker count plus EU + East-Asian
 * majors).
 */
const ISO_639_1_TO_639_3: Record<string, string> = {
  en: 'eng',
  fr: 'fra',
  es: 'spa',
  de: 'deu',
  it: 'ita',
  pt: 'por',
  nl: 'nld',
  ru: 'rus',
  pl: 'pol',
  uk: 'ukr',
  cs: 'ces',
  sk: 'slk',
  hu: 'hun',
  ro: 'ron',
  bg: 'bul',
  el: 'ell',
  tr: 'tur',
  sv: 'swe',
  no: 'nob',
  da: 'dan',
  fi: 'fin',
  is: 'isl',
  ga: 'gle',
  zh: 'cmn',
  ja: 'jpn',
  ko: 'kor',
  vi: 'vie',
  th: 'tha',
  id: 'ind',
  ms: 'zlm',
  tl: 'tgl',
  hi: 'hin',
  bn: 'ben',
  ta: 'tam',
  te: 'tel',
  ur: 'urd',
  fa: 'pes',
  ar: 'arb',
  he: 'heb',
  sw: 'swh',
  am: 'amh',
};

/**
 * Coarse script-family hint for a franc-detected ISO 639-3 code. Returned in
 * `SignalLanguageUnsupportedDecision.detectedScript` for backwards compat with
 * v0.2 dashboards that key on script family rather than language.
 *
 * This is a small lookup table — only covers the languages we expect to
 * surface in customer-signal pipelines. Unknown codes get `'unknown'`.
 */
function scriptHintFor(iso6393: string): string {
  if (iso6393 === 'und') return 'unknown';
  if (CJK_LANGUAGES.has(iso6393)) return 'cjk';
  if (CYRILLIC_LANGUAGES.has(iso6393)) return 'cyrillic';
  if (ARABIC_LANGUAGES.has(iso6393)) return 'arabic';
  if (iso6393 === 'heb' || iso6393 === 'ydd') return 'hebrew';
  if (DEVANAGARI_LANGUAGES.has(iso6393)) return 'devanagari';
  if (iso6393 === 'tha') return 'thai';
  if (iso6393 === 'ell') return 'greek';
  if (iso6393 === 'hye') return 'armenian';
  if (iso6393 === 'kat') return 'georgian';
  // Default: assume Latin-script for everything else (most languages franc
  // detects in our coverage are Latin-script — fr/es/de/pt/it/nl/etc.).
  return 'latin';
}

const CJK_LANGUAGES = new Set(['cmn', 'jpn', 'kor', 'yue', 'wuu', 'nan', 'hak']);
const CYRILLIC_LANGUAGES = new Set([
  'rus',
  'ukr',
  'bel',
  'bul',
  'mkd',
  'srp',
  'tat',
  'kaz',
  'kir',
  'tgk',
  'mon',
  'khk',
]);
const ARABIC_LANGUAGES = new Set(['arb', 'pes', 'urd', 'pbu', 'prs', 'ckb', 'uig']);
const DEVANAGARI_LANGUAGES = new Set([
  'hin',
  'mar',
  'nep',
  'npi',
  'mai',
  'bho',
  'awa',
  'mag',
  'san',
]);

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
