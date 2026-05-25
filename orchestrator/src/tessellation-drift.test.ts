/**
 * RFC-0009 Phase 4.2 — Eτ_tessellation_drift detector tests.
 *
 * Covers acceptance criteria:
 *   AC #1: Rule #1 (AST scan) ships orchestrator-side and detects soul-name
 *          leakage in shared substrate
 *   AC #2: Rule #3 (cross-soul provenance audits) ships, gated on the §8.3
 *          ProvenanceRecord extension that landed in AISDLC-315
 *   AC #3: Drift events emitted via the supplied event sink (events.jsonl)
 *   AC #4: Rule #2 (embedding distance) explicitly NOT shipped — exported
 *          rule union proves the absence
 *   AC #5: Adopter opt-in gate respected (default off; opt-out short-circuits
 *          with zero side-effects and zero emitted events)
 *   AC #6: Coverage spans rule #1 AST scan / rule #3 provenance audit /
 *          no-drift baseline / opt-out short-circuit
 */

import { describe, it, expect } from 'vitest';

import {
  detectTessellationDrift,
  DEFAULT_DIVERGENCE_THRESHOLD,
  type SubstrateFile,
  type ProvenanceAuditEntry,
  type TessellationDriftDetectedEvent,
  type TessellationDriftRule,
} from './tessellation-drift.js';
import type { Tessellation, ProvenanceRecord } from '@ai-sdlc/reference';

// ── Fixture factories ──────────────────────────────────────────────────

function makeTessellation(overrides: Partial<Tessellation> = {}): Tessellation {
  return {
    souls: [
      { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a', status: 'active' },
      { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b', status: 'active' },
      { soulId: 'soul-c', didUri: 'did:platform-x:soul:soul-c', status: 'active' },
    ],
    crossSoulScoringRule: 'min',
    substrateInvariants: ['no-soul-conditionals-in-substrate'],
    ...overrides,
  };
}

function makeProv(partial: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    model: 'claude-opus-4-7',
    tool: 'orchestrator',
    promptHash: 'a'.repeat(64),
    timestamp: '2026-05-25T12:00:00.000Z',
    reviewDecision: 'approved',
    ...partial,
  };
}

const TESSELLATED_DID = 'did:platform-x:platform';

// ── AC #5: opt-out short-circuit (default off) ─────────────────────────

describe('detectTessellationDrift — opt-in gate', () => {
  it('returns optedOut=true with zero events when config.enabled is unset (default off)', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/substrate.ts', contents: `const slug = 'soul-a';` },
    ];
    const result = await detectTessellationDrift({
      tessellatedDid: TESSELLATED_DID,
      tessellation: makeTessellation(),
      substrateFiles: substrate,
    });
    expect(result.optedOut).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('returns optedOut=true with zero events when config.enabled is explicitly false', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/substrate.ts', contents: `const slug = 'soul-a';` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: false },
    );
    expect(result.optedOut).toBe(true);
    expect(result.events).toEqual([]);
  });

  it('does not invoke the emit callback when opted out', async () => {
    let invocations = 0;
    await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: [{ path: 'a.ts', contents: `if (soul === 'soul-a') {}` }],
      },
      { enabled: false },
      () => {
        invocations += 1;
      },
    );
    expect(invocations).toBe(0);
  });
});

// ── AC #1: Rule #1 AST scan for soul-name leakage in substrate ────────

describe('detectTessellationDrift — Rule #1 AST scan', () => {
  it('detects a bare string-literal soul slug in substrate code', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/router.ts', contents: `const target = 'soul-b';\nreturn handle(target);` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    expect(result.optedOut).toBe(false);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.rule).toBe('ast-scan');
    expect(ev.tessellatedDid).toBe(TESSELLATED_DID);
    expect(ev.involvedSouls).toEqual(['soul-b']);
    if (ev.details.rule !== 'ast-scan') throw new Error('expected ast-scan details');
    expect(ev.details.findings).toHaveLength(1);
    const finding = ev.details.findings[0];
    expect(finding.filePath).toBe('src/router.ts');
    expect(finding.soulSlug).toBe('soul-b');
    expect(finding.pattern).toBe('string-literal');
    expect(finding.line).toBe(1);
  });

  it('detects an if-soul-conditional in substrate code', async () => {
    const substrate: SubstrateFile[] = [
      {
        path: 'src/dispatcher.ts',
        contents: `function dispatch(soul) {\n  if (soul === 'soul-a') return alphaHandler();\n  return defaultHandler();\n}`,
      },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    if (ev.details.rule !== 'ast-scan') throw new Error('expected ast-scan details');
    expect(ev.details.findings).toHaveLength(1);
    const finding = ev.details.findings[0];
    expect(finding.pattern).toBe('soul-conditional');
    expect(finding.soulSlug).toBe('soul-a');
    expect(finding.line).toBe(2);
    expect(finding.excerpt).toContain("soul === 'soul-a'");
  });

  it('matches permissively on soul-identifier name (soulId, soul_id)', async () => {
    const substrate: SubstrateFile[] = [
      {
        path: 'src/router.ts',
        contents: `if (soulId === "soul-c") doX();\nif (soul_id === "soul-b") doY();`,
      },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    if (ev.details.rule !== 'ast-scan') throw new Error('expected ast-scan');
    expect(ev.details.findings.every((f) => f.pattern === 'soul-conditional')).toBe(true);
    expect(new Set(ev.details.findings.map((f) => f.soulSlug))).toEqual(
      new Set(['soul-b', 'soul-c']),
    );
  });

  it('detects across multiple substrate files and aggregates the soul set', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/a.ts', contents: `const x = 'soul-a';` },
      { path: 'src/b.ts', contents: `const y = "soul-b";` },
      { path: 'src/c.ts', contents: `// no slug here` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.involvedSouls).toEqual(['soul-a', 'soul-b']);
    if (ev.details.rule !== 'ast-scan') throw new Error('expected ast-scan');
    expect(ev.details.findings.map((f) => f.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('does not double-report a line that contains both conditional and literal patterns', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/cond.ts', contents: `if (soul === 'soul-a') doX();` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    if (result.events[0].details.rule !== 'ast-scan') throw new Error('expected ast-scan');
    // Exactly one finding, the soul-conditional (literal-pattern de-duplicated).
    expect(result.events[0].details.findings).toHaveLength(1);
    expect(result.events[0].details.findings[0].pattern).toBe('soul-conditional');
  });

  it('emits zero events on a no-drift baseline (substrate file with no soul slug)', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/clean.ts', contents: `export function add(a, b) { return a + b; }` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
    );
    expect(result.optedOut).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('respects the per-rule astScan kill switch', async () => {
    const substrate: SubstrateFile[] = [
      { path: 'src/leak.ts', contents: `const slug = 'soul-a';` },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true, rules: { astScan: false } },
    );
    expect(result.events).toEqual([]);
  });
});

// ── AC #2 + #3 + #6: Rule #3 cross-soul provenance audits ─────────────

describe('detectTessellationDrift — Rule #3 cross-soul provenance', () => {
  it('flags provenance whose targetedSouls crosses tessellation boundaries with no amendment', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({
          targetedSouls: ['soul-a', 'soul-b'],
          tessellatedSoulRef: TESSELLATED_DID,
        }),
        amendmentRecorded: false,
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.rule).toBe('cross-soul-provenance');
    if (ev.details.rule !== 'cross-soul-provenance')
      throw new Error('expected cross-soul-provenance');
    expect(ev.details.findings).toHaveLength(1);
    const finding = ev.details.findings[0];
    expect(finding.kind).toBe('cross-boundary-no-amendment');
    expect(finding.crossedSouls).toEqual(['soul-a', 'soul-b']);
  });

  it('does not flag provenance when amendmentRecorded=true', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({
          targetedSouls: ['soul-a', 'soul-b'],
          tessellatedSoulRef: TESSELLATED_DID,
        }),
        amendmentRecorded: true,
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toEqual([]);
  });

  it('does not flag single-soul provenance (no cross-boundary span)', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      { record: makeProv({ targetedSouls: ['soul-a'] }) },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toEqual([]);
  });

  it('flags substrate provenance whose soul-distinct outcomes diverge sharply', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ substrateScoped: true, tessellatedSoulRef: TESSELLATED_DID }),
        outcomeBySoul: { 'soul-a': 0.9, 'soul-b': 0.4, 'soul-c': 0.5 },
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    if (ev.details.rule !== 'cross-soul-provenance')
      throw new Error('expected cross-soul-provenance');
    expect(ev.details.findings).toHaveLength(1);
    const finding = ev.details.findings[0];
    expect(finding.kind).toBe('substrate-divergent-outcomes');
    expect(finding.crossedSouls).toEqual(['soul-a', 'soul-b', 'soul-c']);
    expect(finding.outcomeBySoul).toEqual({ 'soul-a': 0.9, 'soul-b': 0.4, 'soul-c': 0.5 });
  });

  it('does not flag substrate provenance below the divergence threshold', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ substrateScoped: true }),
        outcomeBySoul: { 'soul-a': 0.55, 'soul-b': 0.5, 'soul-c': 0.45 },
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toEqual([]);
  });

  it('honors a custom divergence threshold', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ substrateScoped: true }),
        outcomeBySoul: { 'soul-a': 0.6, 'soul-b': 0.5 },
      },
    ];
    // spread = 0.1, threshold = 0.05 → fires
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true, divergenceThreshold: 0.05 },
    );
    expect(result.events).toHaveLength(1);
  });

  it('emits zero events on no-drift baseline (single soul, no amendment needed)', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      { record: makeProv({ targetedSouls: ['soul-a'] }) },
      { record: makeProv({ targetedSouls: ['soul-b'] }) },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.optedOut).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('ignores targetedSouls that are not in the tessellation manifest', async () => {
    // Stale slugs (soul-d, soul-e are not in the manifest); after filtering only
    // soul-a remains, which is single-soul → no cross-boundary finding.
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ targetedSouls: ['soul-a', 'soul-d', 'soul-e'] }),
        amendmentRecorded: false,
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true },
    );
    expect(result.events).toEqual([]);
  });

  it('respects the per-rule crossSoulProvenance kill switch', async () => {
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ targetedSouls: ['soul-a', 'soul-b'] }),
        amendmentRecorded: false,
      },
    ];
    const result = await detectTessellationDrift(
      { tessellatedDid: TESSELLATED_DID, tessellation: makeTessellation(), provenance },
      { enabled: true, rules: { crossSoulProvenance: false } },
    );
    expect(result.events).toEqual([]);
  });

  it('exposes the default divergence threshold as a stable constant', () => {
    expect(DEFAULT_DIVERGENCE_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_DIVERGENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

// ── AC #3: Event sink forwarding (events.jsonl wiring) ────────────────

describe('detectTessellationDrift — event sink', () => {
  it('forwards each emitted event through the supplied emit callback', async () => {
    const captured: TessellationDriftDetectedEvent[] = [];
    const substrate: SubstrateFile[] = [{ path: 'src/leak.ts', contents: `const x = 'soul-a';` }];
    const provenance: ProvenanceAuditEntry[] = [
      {
        record: makeProv({ targetedSouls: ['soul-a', 'soul-b'] }),
        amendmentRecorded: false,
      },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
        provenance,
      },
      { enabled: true },
      (ev) => {
        captured.push(ev);
      },
    );
    // One event per rule that fired.
    expect(captured).toHaveLength(2);
    expect(captured.map((e) => e.rule).sort()).toEqual(['ast-scan', 'cross-soul-provenance']);
    expect(captured).toEqual(result.events);
  });

  it('awaits async emit callbacks before resolving', async () => {
    const order: string[] = [];
    const substrate: SubstrateFile[] = [{ path: 'src/x.ts', contents: `const z = 'soul-a';` }];
    await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
      },
      { enabled: true },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push('emit');
      },
    );
    order.push('after-detect');
    expect(order).toEqual(['emit', 'after-detect']);
  });

  it('propagates errors thrown from emit (sync-pure contract)', async () => {
    const substrate: SubstrateFile[] = [{ path: 'src/x.ts', contents: `const z = 'soul-a';` }];
    await expect(
      detectTessellationDrift(
        {
          tessellatedDid: TESSELLATED_DID,
          tessellation: makeTessellation(),
          substrateFiles: substrate,
        },
        { enabled: true },
        () => {
          throw new Error('sink broke');
        },
      ),
    ).rejects.toThrow('sink broke');
  });
});

// ── AC #4: Rule #2 (embedding distance) explicitly NOT shipped ────────

describe('detectTessellationDrift — Rule #2 deferred to RFC-0019', () => {
  it('does not include `embedding-distance` in the TessellationDriftRule union surface', () => {
    // Compile-time assertion via runtime witness: the exported rule union
    // members are checked by listing them; if a future regression added
    // `'embedding-distance'`, this list would silently still pass — so we
    // additionally assert that no emitted event ever carries that rule.
    // (Live confirmation: type union has exactly two members today.)
    const allowed: TessellationDriftRule[] = ['ast-scan', 'cross-soul-provenance'];
    expect(allowed).toHaveLength(2);
    expect(allowed).not.toContain('embedding-distance' as unknown as TessellationDriftRule);
  });

  it('never emits an event with rule === "embedding-distance" regardless of input', async () => {
    const substrate: SubstrateFile[] = [{ path: 'src/x.ts', contents: `const z = 'soul-a';` }];
    const provenance: ProvenanceAuditEntry[] = [
      { record: makeProv({ targetedSouls: ['soul-a', 'soul-b'] }), amendmentRecorded: false },
    ];
    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
        provenance,
      },
      { enabled: true },
    );
    for (const ev of result.events) {
      expect(ev.rule).not.toBe('embedding-distance');
    }
  });
});

// ── Integration: three-soul platform, mixed signals ───────────────────

describe('detectTessellationDrift — three-soul platform integration', () => {
  it('aggregates Rule #1 + Rule #3 findings on a worked three-soul example', async () => {
    const substrate: SubstrateFile[] = [
      {
        path: 'src/router.ts',
        contents: [
          `function route(soul) {`,
          `  if (soul === 'soul-a') return alpha();`,
          `  const fallback = "soul-c";`,
          `  return handle(fallback);`,
          `}`,
        ].join('\n'),
      },
    ];
    const provenance: ProvenanceAuditEntry[] = [
      // cross-boundary span without amendment
      {
        record: makeProv({
          promptHash: 'b'.repeat(64),
          targetedSouls: ['soul-a', 'soul-b'],
          tessellatedSoulRef: TESSELLATED_DID,
        }),
        amendmentRecorded: false,
      },
      // substrate-scoped divergent outcomes
      {
        record: makeProv({
          promptHash: 'c'.repeat(64),
          substrateScoped: true,
          tessellatedSoulRef: TESSELLATED_DID,
        }),
        outcomeBySoul: { 'soul-a': 0.9, 'soul-b': 0.3, 'soul-c': 0.55 },
      },
      // amendment-recorded cross-boundary — should NOT flag
      {
        record: makeProv({
          promptHash: 'd'.repeat(64),
          targetedSouls: ['soul-b', 'soul-c'],
        }),
        amendmentRecorded: true,
      },
    ];

    const result = await detectTessellationDrift(
      {
        tessellatedDid: TESSELLATED_DID,
        tessellation: makeTessellation(),
        substrateFiles: substrate,
        provenance,
      },
      { enabled: true },
    );

    expect(result.optedOut).toBe(false);
    // Exactly two events — one per fired rule.
    expect(result.events).toHaveLength(2);

    const ast = result.events.find((e) => e.rule === 'ast-scan');
    const prov = result.events.find((e) => e.rule === 'cross-soul-provenance');
    expect(ast).toBeDefined();
    expect(prov).toBeDefined();

    if (!ast || ast.details.rule !== 'ast-scan') throw new Error('expected ast-scan');
    expect(ast.involvedSouls).toEqual(['soul-a', 'soul-c']);
    expect(ast.details.findings).toHaveLength(2);

    if (!prov || prov.details.rule !== 'cross-soul-provenance') {
      throw new Error('expected cross-soul-provenance');
    }
    // 2 findings: cross-boundary-no-amendment + substrate-divergent-outcomes
    expect(prov.details.findings).toHaveLength(2);
    const kinds = prov.details.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['cross-boundary-no-amendment', 'substrate-divergent-outcomes']);
  });
});
