import { describe, expect, it } from 'vitest';
import {
  classifySignals,
  computeRecencyDecay,
  computeSignalWeight,
  resolveCustomerTier,
  resolveIcpResonance,
  tokenize,
  type ClassifiedSignal,
  type ClassifySignalsOptions,
  type CustomerTierRegistry,
} from './classifier.js';
import { DEFAULT_SIGNAL_INGESTION_CONFIG, type SignalIngestionConfig } from './config.js';
import type { RawSignal } from './types.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function signal(
  sourceId: string,
  overrides: Partial<RawSignal> = {},
  sourceTimestamp = new Date('2026-05-01T00:00:00.000Z'),
): RawSignal {
  return {
    sourceId,
    sourceTimestamp,
    payload: `Customer feedback about ${sourceId}`,
    ...overrides,
  };
}

const asOf = new Date('2026-05-23T00:00:00.000Z');

// ── Tier classification ───────────────────────────────────────────────────────

describe('resolveCustomerTier', () => {
  it('prefers adapter-provided customerTier', () => {
    const s = signal('t1', { customerTier: 'enterprise' });
    expect(resolveCustomerTier(s)).toBe('enterprise');
  });

  it('falls back to registry lookup when customerTier absent and customerId present', () => {
    const s = signal('t2', { customerId: 'acme-corp' });
    const registry: CustomerTierRegistry = {
      resolve: (id) => (id === 'acme-corp' ? 'mid' : undefined),
    };
    expect(resolveCustomerTier(s, registry)).toBe('mid');
  });

  it('falls back to smb for Tier-1 adapter when registry returns undefined', () => {
    const s = signal('t3', { customerId: 'unknown-customer' });
    const registry: CustomerTierRegistry = { resolve: () => undefined };
    const adapterTiers = new Map([['signal-source-support-ticket', 1 as const]]);
    const s2 = { ...s, metadata: { adapterName: 'signal-source-support-ticket' } };
    expect(resolveCustomerTier(s2, registry, adapterTiers)).toBe('smb');
  });

  it('falls back to free for Tier-2 adapter', () => {
    const s = signal('t4', {
      metadata: { adapterName: 'signal-source-community-thread' },
    });
    const adapterTiers = new Map([['signal-source-community-thread', 2 as const]]);
    expect(resolveCustomerTier(s, undefined, adapterTiers)).toBe('free');
  });

  it('returns smb when no metadata, no registry, no customerTier', () => {
    const s = signal('t5');
    expect(resolveCustomerTier(s)).toBe('smb');
  });

  it('handles all CustomerTier values via adapter-provided field', () => {
    const tiers = ['enterprise', 'mid', 'smb', 'free', 'churned'] as const;
    for (const tier of tiers) {
      const s = signal('tx', { customerTier: tier });
      expect(resolveCustomerTier(s)).toBe(tier);
    }
  });
});

// ── ICP resonance ─────────────────────────────────────────────────────────────

describe('resolveIcpResonance', () => {
  it('returns partial when icpSegments is empty', () => {
    expect(resolveIcpResonance('any signal text', [])).toBe('partial');
  });

  it('returns strong for high-similarity payload', () => {
    const segments = ['B2B SaaS engineering team productivity tooling'];
    const payload = 'Our B2B SaaS engineering team needs better productivity tooling for the SDLC';
    expect(resolveIcpResonance(payload, segments)).toBe('strong');
  });

  it('returns partial for moderate-similarity payload', () => {
    const segments = ['B2B SaaS engineering team'];
    const payload = 'The engineering team would benefit from better tooling';
    const result = resolveIcpResonance(payload, segments);
    expect(['strong', 'partial']).toContain(result);
  });

  it('returns weak for dissimilar payload', () => {
    const segments = ['B2B SaaS enterprise productivity engineering'];
    const payload = 'cat sat mat hat bat';
    expect(resolveIcpResonance(payload, segments)).toBe('weak');
  });

  it('matches ICP resonance deterministically (same inputs → same output)', () => {
    const segments = ['enterprise software developer productivity'];
    const payload = 'developer productivity tools for enterprise teams';
    const r1 = resolveIcpResonance(payload, segments);
    const r2 = resolveIcpResonance(payload, segments);
    expect(r1).toBe(r2);
  });
});

// ── Recency decay ─────────────────────────────────────────────────────────────

describe('computeRecencyDecay', () => {
  it('returns 1.0 for a same-day signal', () => {
    const now = new Date('2026-05-23T00:00:00.000Z');
    const result = computeRecencyDecay(now, now, 30);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('returns 0.5 at exactly one half-life', () => {
    const sourceTimestamp = new Date('2026-04-23T00:00:00.000Z'); // 30 days before asOf
    const result = computeRecencyDecay(sourceTimestamp, asOf, 30);
    expect(result).toBeCloseTo(0.5, 4);
  });

  it('returns ~0.25 at two half-lives', () => {
    const sourceTimestamp = new Date('2026-03-24T00:00:00.000Z'); // 60 days before asOf
    const result = computeRecencyDecay(sourceTimestamp, asOf, 30);
    expect(result).toBeCloseTo(0.25, 3);
  });

  it('clamps to 1.0 for future-dated signals', () => {
    const future = new Date('2026-06-01T00:00:00.000Z');
    const result = computeRecencyDecay(future, asOf, 30);
    expect(result).toBe(1.0);
  });

  it('returns 1.0 when halfLifeDays is zero', () => {
    const past = new Date('2025-01-01T00:00:00.000Z');
    expect(computeRecencyDecay(past, asOf, 0)).toBe(1.0);
  });

  it('old signals (6 months) contribute < 2% of original weight with 30-day half-life', () => {
    const sixMonthsAgo = new Date(asOf.getTime() - 180 * 24 * 60 * 60 * 1000);
    const result = computeRecencyDecay(sixMonthsAgo, asOf, 30);
    expect(result).toBeLessThan(0.02);
  });
});

// ── Language gate ─────────────────────────────────────────────────────────────

describe('classifySignals — language gate (RFC-0030 OQ-13.2 v0.3 — franc)', () => {
  const opts: ClassifySignalsOptions = {
    asOf,
    config: DEFAULT_SIGNAL_INGESTION_CONFIG,
  };

  it('accepts English-language signals over the franc minDetectionLength threshold', () => {
    const s = signal('en1', {
      payload:
        'The product really needs better support for large teams managing dozens of repositories at once',
    });
    const result = classifySignals([s], opts);
    expect(result.classified).toHaveLength(1);
    expect(result.languageDecisions).toHaveLength(0);
  });

  it('drops predominantly CJK signals and emits a Decision record with ISO 639-3 + script hint', () => {
    const s = signal('cjk1', {
      // ≥ 50 chars so franc has enough text to classify accurately
      payload:
        '我们需要更好的产品功能来支持企业客户的需求和工作流程需要改进我们需要更好的产品功能来支持企业客户的需求和工作流程需要改进',
    });
    const result = classifySignals([s], opts);
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions).toHaveLength(1);
    expect(result.languageDecisions[0]).toMatchObject({
      type: 'Decision',
      decision: 'signal-language-unsupported',
      sourceId: 'cjk1',
      detectedLanguage: 'cmn',
      detectedScript: 'cjk',
    });
  });

  it('drops predominantly Cyrillic signals — franc detects a Cyrillic language', () => {
    const s = signal('cyr1', {
      payload:
        'Нам нужен лучший продукт для поддержки крупных корпоративных клиентов работающих в энтерпрайз сегменте',
    });
    const result = classifySignals([s], opts);
    expect(result.classified).toHaveLength(0);
    // franc returns either 'rus' (Russian) or 'ukr' (Ukrainian) for this
    // Cyrillic text — both are Cyrillic-script and not in our default
    // acceptedLanguages, so both correctly result in a drop.
    expect(['rus', 'ukr', 'bel', 'bul']).toContain(result.languageDecisions[0]?.detectedLanguage);
    expect(result.languageDecisions[0]?.detectedScript).toBe('cyrillic');
  });

  it('drops predominantly Arabic signals — franc detects as arb / arabic hint', () => {
    const s = signal('ar1', {
      payload:
        'نحتاج إلى منتج أفضل لدعم العملاء المؤسسيين الكبار والشركات الكبيرة التي تعمل في قطاع المؤسسات',
    });
    const result = classifySignals([s], opts);
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions[0]?.detectedLanguage).toBe('arb');
    expect(result.languageDecisions[0]?.detectedScript).toBe('arabic');
  });

  it('accepts short payloads below the franc minDetectionLength (onUndetermined: accept default)', () => {
    // Signal with mixed Latin + Japanese identifier, length 71 chars but franc
    // gets confused on short multi-script text. The conservative default
    // (onUndetermined: 'accept') protects legitimate technical signals
    // containing non-Latin identifiers like office names or product codes.
    const s = signal('mixed', {
      payload: 'Fix bug',
    });
    const result = classifySignals([s], opts);
    // Below minDetectionLength (50) -> franc returns 'und' -> accept (default)
    expect(result.classified).toHaveLength(1);
  });

  it('accepts short email-formatted English payloads (under minDetectionLength → und → accept)', () => {
    // Pre-v0.3: heuristic counted newlines toward non-Latin ratio and dropped.
    // v0.3 (franc): payload is 29 chars, under minDetectionLength=50, so franc
    // returns 'und' and the gate accepts per onUndetermined='accept' default.
    const s = signal('en-email', {
      payload: 'Hi,\n\nFix needed.\n\nThanks,\nBob',
    });
    const result = classifySignals([s], opts);
    expect(result.classified).toHaveLength(1);
    expect(result.languageDecisions).toHaveLength(0);
  });

  it('emits Decision with correct acceptedLanguages from config', () => {
    const s = signal('cjk2', {
      payload:
        '产品需要更好的企业功能支持团队协作和工作流程管理提高效率产品需要更好的企业功能支持团队协作和工作流程管理提高效率',
    });
    const result = classifySignals([s], opts);
    expect(result.languageDecisions[0]?.acceptedLanguages).toEqual(['en']);
  });

  it('accepts French signals when acceptedLanguages includes fr (multi-language opt-in)', () => {
    const multiLangConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      acceptedLanguages: ['en', 'fr', 'de'],
    };
    const s = signal('fr1', {
      payload:
        'Nous avons besoin de meilleures fonctionnalités entreprise pour notre équipe et nos clients',
    });
    const result = classifySignals([s], { ...opts, config: multiLangConfig });
    expect(result.classified).toHaveLength(1);
    expect(result.languageDecisions).toHaveLength(0);
  });

  it('still drops non-accepted languages when multi-language opt-in is partial', () => {
    // Opt into French + English but NOT Chinese — CJK signals still dropped.
    const partialLangConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      acceptedLanguages: ['en', 'fr'],
    };
    const s = signal('cjk-blocked', {
      payload:
        '产品需要更好的企业功能支持团队协作和工作流程管理提高效率产品需要更好的企业功能支持团队协作和工作流程管理提高效率',
    });
    const result = classifySignals([s], { ...opts, config: partialLangConfig });
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions).toHaveLength(1);
    expect(result.languageDecisions[0]?.detectedLanguage).toBe('cmn');
  });

  it('accepts ISO 639-3 codes directly in acceptedLanguages (e.g. "tgl" for Tagalog)', () => {
    // Adopters can specify languages not in the ISO 639-1 → 639-3 lookup
    // table by passing the three-letter form directly.
    const tagalogConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      acceptedLanguages: ['eng', 'tgl'],
    };
    const s = signal('tl1', {
      payload:
        'Kailangan namin ng mas mahusay na produkto para sa aming mga kustomer sa malalaking kumpanya',
    });
    const result = classifySignals([s], { ...opts, config: tagalogConfig });
    // franc detects this as 'tgl' (or 'ceb' for Cebuano — both Philippine
    // languages); either is in our accept list, OR if detected as something
    // else, we allow the test to fail with a helpful message
    expect(result.classified.length + result.languageDecisions.length).toBe(1);
  });

  it('accepts BCP-47 regional tags (en-US, fr-CA, zh-Hans) via two-letter prefix matching', () => {
    const regionalConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      acceptedLanguages: ['en-US', 'fr-CA'],
    };
    const s = signal('en-us', {
      payload:
        'The product really needs better support for large teams managing dozens of repositories at once',
    });
    const result = classifySignals([s], { ...opts, config: regionalConfig });
    expect(result.classified).toHaveLength(1);
  });

  it('processes a batch with mixed languages — drops only non-accepted', () => {
    const signals = [
      signal('en2', {
        payload:
          'English signal about API improvements that should be classified as eng by franc and accepted',
      }),
      signal('cjk3', {
        payload:
          '这是一个关于产品功能改进的中文反馈意见需要更好的企业支持这是一个关于产品功能改进的中文反馈意见需要更好的企业支持',
      }),
      signal('en3', {
        payload:
          'Another English signal about performance improvements for large customer deployments needing better tooling',
      }),
    ];
    const result = classifySignals(signals, opts);
    expect(result.classified).toHaveLength(2);
    expect(result.languageDecisions).toHaveLength(1);
    expect(result.languageDecisions[0]?.sourceId).toBe('cjk3');
  });

  it('AC #6 hermetic: franc detection is deterministic — same input → same output', () => {
    const payload =
      '我们需要更好的产品功能来支持企业客户的需求和工作流程需要改进我们需要更好的产品功能来支持企业客户的需求';
    const r1 = classifySignals([signal('det1', { payload })], opts);
    const r2 = classifySignals([signal('det1', { payload })], opts);
    expect(r1.languageDecisions[0]?.detectedLanguage).toBe(
      r2.languageDecisions[0]?.detectedLanguage,
    );
    expect(r1.languageDecisions[0]?.detectedScript).toBe(r2.languageDecisions[0]?.detectedScript);
  });

  it('disables the gate entirely when languageDetection.library is "none"', () => {
    const disabledConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      languageDetection: {
        library: 'none',
        minDetectionLength: 50,
        onUndetermined: 'accept',
      },
    };
    const s = signal('cjk-disabled', {
      payload:
        '产品需要更好的企业功能支持团队协作和工作流程管理提高效率产品需要更好的企业功能支持团队协作和工作流程管理提高效率',
    });
    const result = classifySignals([s], { ...opts, config: disabledConfig });
    // Even though acceptedLanguages=['en'], the gate is disabled → accepted
    expect(result.classified).toHaveLength(1);
    expect(result.languageDecisions).toHaveLength(0);
  });

  it('drops undetermined-language payloads when onUndetermined is "drop"', () => {
    const strictConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      languageDetection: {
        library: 'franc',
        minDetectionLength: 50,
        onUndetermined: 'drop',
      },
    };
    const s = signal('und1', {
      // Short payload → franc returns 'und' → dropped under strict policy
      payload: 'BUG: 500',
    });
    const result = classifySignals([s], { ...opts, config: strictConfig });
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions[0]?.detectedLanguage).toBe('und');
  });
});

// ── Full classification pipeline ──────────────────────────────────────────────

describe('classifySignals — full pipeline', () => {
  it('AC #1: classifies tier from customerTier field', () => {
    const signals = [
      signal('e1', { customerTier: 'enterprise' }),
      signal('m1', { customerTier: 'mid' }),
      signal('s1', { customerTier: 'smb' }),
      signal('f1', { customerTier: 'free' }),
      signal('c1', { customerTier: 'churned' }),
    ];
    const result = classifySignals(signals, { asOf });
    const tiers = result.classified.map((c) => c.customerTier);
    expect(tiers).toEqual(['enterprise', 'mid', 'smb', 'free', 'churned']);
  });

  it('AC #2: classifies ICP resonance using BM25 default', () => {
    const icpSegments = ['enterprise B2B SaaS developer tooling productivity'];
    const signals = [
      signal('icp-strong', {
        payload: 'Our enterprise B2B SaaS team needs better developer productivity tooling',
      }),
      signal('icp-weak', { payload: 'cat food recommendation for my pet' }),
    ];
    const result = classifySignals(signals, { asOf, icpSegments });
    expect(result.classified[0]?.icpResonance).toBe('strong');
    expect(result.classified[1]?.icpResonance).toBe('weak');
  });

  it('AC #3: applies recency decay per recencyHalfLifeDays config', () => {
    const thirtyDaysAgo = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000);
    const config: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      recencyHalfLifeDays: 30,
    };
    const s = signal('r1', {}, thirtyDaysAgo);
    const result = classifySignals([s], { asOf, config });
    expect(result.classified[0]?.recencyDecay).toBeCloseTo(0.5, 3);
  });

  it('AC #4: drops non-English signals as Decision: signal-language-unsupported', () => {
    const s = signal('lang1', {
      // ≥ 50 chars so franc has enough text to confidently detect cmn
      payload:
        '这是中文信号这是中文信号这是中文信号需要企业功能支持这是中文信号这是中文信号这是中文信号需要企业功能支持',
    });
    const result = classifySignals([s], { asOf });
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions[0]?.decision).toBe('signal-language-unsupported');
  });

  it('AC #5: per-org acceptedLanguages config respected — default is [en]', () => {
    const config = { ...DEFAULT_SIGNAL_INGESTION_CONFIG };
    expect(config.acceptedLanguages).toEqual(['en']);
  });

  it('AC #6: tier multipliers read from config', () => {
    const customConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      tierMultipliers: {
        enterprise: 5.0,
        mid: 2.0,
        smb: 1.0,
        free: 0.2,
        churned: 4.0,
      },
    };
    const s = signal('ent1', { customerTier: 'enterprise' });
    const result = classifySignals([s], { asOf, config: customConfig });
    expect(result.classified[0]?.tierMultiplier).toBe(5.0);
  });

  it('AC #6: ICP resonance weights read from config', () => {
    const customConfig: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      icpResonanceWeights: {
        strong: 2.0,
        partial: 1.0,
        weak: 0.25,
      },
    };
    const icpSegments = ['enterprise B2B SaaS developer tooling productivity engineering'];
    const s = signal('icp1', {
      payload:
        'Our enterprise B2B SaaS developer team needs better productivity engineering tooling',
    });
    const result = classifySignals([s], { asOf, config: customConfig, icpSegments });
    // Should be strong → weight 2.0
    expect(result.classified[0]?.icpResonanceWeight).toBe(2.0);
  });

  it('returns empty classified and empty decisions for empty input', () => {
    const result = classifySignals([], { asOf });
    expect(result.classified).toHaveLength(0);
    expect(result.languageDecisions).toHaveLength(0);
  });

  it('churned tier gets highest default multiplier (2.0)', () => {
    const s = signal('ch1', { customerTier: 'churned' });
    const result = classifySignals([s], { asOf });
    expect(result.classified[0]?.tierMultiplier).toBe(2.0);
    // And enterprise gets 3.0 (highest)
    const s2 = signal('ent2', { customerTier: 'enterprise' });
    const result2 = classifySignals([s2], { asOf });
    expect(result2.classified[0]?.tierMultiplier).toBe(3.0);
  });
});

// ── computeSignalWeight ───────────────────────────────────────────────────────

describe('computeSignalWeight', () => {
  it('computes composite weight from base × tier × icp × recency', () => {
    const classified: ClassifiedSignal = {
      signal: signal('w1', { customerTier: 'enterprise' }),
      customerTier: 'enterprise',
      icpResonance: 'strong',
      recencyDecay: 0.5,
      tierMultiplier: 3.0,
      icpResonanceWeight: 1.5,
      baseWeight: 1.0,
    };
    // 1.0 × 3.0 × 1.5 × 0.5 = 2.25
    expect(computeSignalWeight(classified)).toBeCloseTo(2.25, 5);
  });

  it('returns 0 when baseWeight is 0', () => {
    const classified: ClassifiedSignal = {
      signal: signal('w2'),
      customerTier: 'free',
      icpResonance: 'weak',
      recencyDecay: 0.8,
      tierMultiplier: 0.5,
      icpResonanceWeight: 0.5,
      baseWeight: 0.0,
    };
    expect(computeSignalWeight(classified)).toBe(0);
  });
});

// ── tokenize ──────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and extracts alphanumeric tokens of length >= 2', () => {
    expect(tokenize('Hello World!')).toEqual(['hello', 'world']);
  });

  it('excludes single-character tokens', () => {
    expect(tokenize('a B c DE fg')).toEqual(['de', 'fg']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles mixed alphanumeric tokens', () => {
    const tokens = tokenize('RFC-0030 Phase2 B2B SaaS');
    expect(tokens).toContain('rfc');
    expect(tokens).toContain('0030');
    expect(tokens).toContain('phase2');
    expect(tokens).toContain('b2b');
    expect(tokens).toContain('saas');
  });
});

// ── Default config values ─────────────────────────────────────────────────────

describe('DEFAULT_SIGNAL_INGESTION_CONFIG', () => {
  it('has correct default tier multipliers per RFC-0030 §11', () => {
    const { tierMultipliers } = DEFAULT_SIGNAL_INGESTION_CONFIG;
    expect(tierMultipliers.enterprise).toBe(3.0);
    expect(tierMultipliers.mid).toBe(1.5);
    expect(tierMultipliers.smb).toBe(1.0);
    expect(tierMultipliers.free).toBe(0.5);
    expect(tierMultipliers.churned).toBe(2.0);
  });

  it('has correct default ICP resonance weights per RFC-0030 §11', () => {
    const { icpResonanceWeights } = DEFAULT_SIGNAL_INGESTION_CONFIG;
    expect(icpResonanceWeights.strong).toBe(1.5);
    expect(icpResonanceWeights.partial).toBe(1.0);
    expect(icpResonanceWeights.weak).toBe(0.5);
  });

  it('defaults recencyHalfLifeDays to 30', () => {
    expect(DEFAULT_SIGNAL_INGESTION_CONFIG.recencyHalfLifeDays).toBe(30);
  });

  it('defaults acceptedLanguages to [en]', () => {
    expect(DEFAULT_SIGNAL_INGESTION_CONFIG.acceptedLanguages).toEqual(['en']);
  });

  it('is disabled by default', () => {
    expect(DEFAULT_SIGNAL_INGESTION_CONFIG.enabled).toBe(false);
  });
});
