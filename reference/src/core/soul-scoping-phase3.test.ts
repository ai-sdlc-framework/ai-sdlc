/**
 * RFC-0009 Phase 3 — Soul-scoping tests for AgentRole, AdapterBinding,
 * ProvenanceRecord, and QualityGate.
 *
 * Acceptance criteria covered:
 *   AC #1: AgentRole schema extended with soulScope field per §8.1
 *   AC #2: AdapterBinding schema extended with soulScope field per §8.2
 *   AC #3: ProvenanceRecord extended with soulScope + tessellatedSoulRef per §8.3
 *   AC #4: QualityGate schema extended with soulScope field per §8.4
 *   AC #5: Backwards-compat — all four resources work with omitted soulScope (= platform-wide)
 *   AC #7: soul-scoped + platform-wide + mixed-scope scenarios per resource
 */

import { describe, it, expect } from 'vitest';
import { validate } from './validation.js';
import {
  createProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
} from './provenance.js';
import type { AgentRole, AdapterBinding, QualityGate } from './types.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

// ─── §8.1 AgentRole soul-scoping ─────────────────────────────────────────────

describe('RFC-0009 Phase 3 — AgentRole soul-scoping (AC #1 + AC #5 + AC #7)', () => {
  const baseAgentRole = {
    apiVersion: API_VERSION,
    kind: 'AgentRole' as const,
    metadata: { name: 'test-agent' },
    spec: {
      role: 'Developer',
      goal: 'Implement features.',
      tools: ['read', 'write'],
    },
  };

  // AC #5: backwards-compat — omitting scope = platform-wide
  it('validates an AgentRole without soulScope (backward-compat, defaults to platform-wide)', () => {
    const result = validate('AgentRole', baseAgentRole);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  // AC #7: platform-wide scenario
  it('validates an AgentRole with scope: platform (explicit platform-wide)', () => {
    const agentRole: AgentRole = {
      ...baseAgentRole,
      spec: { ...baseAgentRole.spec, scope: 'platform' },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(true);
  });

  // AC #7: soul-scoped scenario with soulBindings
  it('validates an AgentRole with scope: soul and soulBindings', () => {
    const agentRole: AgentRole = {
      ...baseAgentRole,
      spec: {
        ...baseAgentRole.spec,
        scope: 'soul',
        soulBindings: ['did:platform-x:soul:soul-a', 'did:platform-x:soul:soul-b'],
      },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(true);
  });

  // AC #7: tenant-scoped scenario
  it('validates an AgentRole with scope: tenant', () => {
    const agentRole: AgentRole = {
      ...baseAgentRole,
      spec: { ...baseAgentRole.spec, scope: 'tenant' },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(true);
  });

  // AC #7: soul-scoped with single soul binding
  it('validates an AgentRole with scope: soul and a single soulBinding', () => {
    const agentRole: AgentRole = {
      ...baseAgentRole,
      spec: {
        ...baseAgentRole.spec,
        scope: 'soul',
        soulBindings: ['did:platform-x:soul:soul-a'],
      },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(true);
  });

  // AC #7: mixed-scope — scope present but soulBindings absent (platform-wide default)
  it('validates an AgentRole with scope: soul but no soulBindings (empty soul binding list)', () => {
    const agentRole: AgentRole = {
      ...baseAgentRole,
      spec: { ...baseAgentRole.spec, scope: 'soul', soulBindings: [] },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(true);
  });

  // AC #7: schema rejects invalid scope value
  it('rejects an AgentRole with an invalid scope value', () => {
    const agentRole = {
      ...baseAgentRole,
      spec: { ...baseAgentRole.spec, scope: 'unknown-scope' },
    };
    const result = validate('AgentRole', agentRole);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  // AC #1: TypeScript type shape — soul-scoping fields present
  it('constructs a soul-scoped AgentRole TypeScript value correctly', () => {
    const agentRole: AgentRole = {
      apiVersion: API_VERSION,
      kind: 'AgentRole',
      metadata: { name: 'soul-a-specialist' },
      spec: {
        role: 'Soul-A Specialist',
        goal: 'Implement features scoped to Soul-A.',
        tools: ['read', 'write', 'bash'],
        scope: 'soul',
        soulBindings: ['did:platform-x:soul:soul-a'],
      },
    };
    expect(agentRole.spec.scope).toBe('soul');
    expect(agentRole.spec.soulBindings).toEqual(['did:platform-x:soul:soul-a']);
  });
});

// ─── §8.2 AdapterBinding soul-scoping ────────────────────────────────────────

describe('RFC-0009 Phase 3 — AdapterBinding soul-scoping (AC #2 + AC #5 + AC #7)', () => {
  const baseAdapterBinding = {
    apiVersion: API_VERSION,
    kind: 'AdapterBinding' as const,
    metadata: { name: 'issue-tracker' },
    spec: {
      interface: 'IssueTracker' as const,
      type: 'linear',
      version: '1.0.0',
    },
  };

  // AC #5: backwards-compat — omitting soulOverrides = platform-wide
  it('validates an AdapterBinding without soulOverrides (backward-compat, platform-wide)', () => {
    const result = validate('AdapterBinding', baseAdapterBinding);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  // AC #7: soul-scoped scenario with soulOverrides
  it('validates an AdapterBinding with soulOverrides for two souls', () => {
    const adapterBinding: AdapterBinding = {
      ...baseAdapterBinding,
      spec: {
        ...baseAdapterBinding.spec,
        soulOverrides: [
          {
            soul: 'did:platform-x:soul:soul-a',
            config: { teamId: 'team-alpha', issueChannel: 'ALPHA' },
          },
          {
            soul: 'did:platform-x:soul:soul-b',
            config: { teamId: 'team-beta', issueChannel: 'BETA' },
          },
        ],
      },
    };
    const result = validate('AdapterBinding', adapterBinding);
    expect(result.valid).toBe(true);
  });

  // AC #7: single soul override scenario
  it('validates an AdapterBinding with a single soulOverride', () => {
    const adapterBinding: AdapterBinding = {
      ...baseAdapterBinding,
      spec: {
        ...baseAdapterBinding.spec,
        soulOverrides: [
          {
            soul: 'did:platform-x:soul:soul-a',
            config: { teamId: 'team-alpha' },
          },
        ],
      },
    };
    const result = validate('AdapterBinding', adapterBinding);
    expect(result.valid).toBe(true);
  });

  // AC #7: mixed-scope — platform-level config + soul overrides
  it('validates an AdapterBinding with top-level config AND soulOverrides (mixed-scope)', () => {
    const adapterBinding: AdapterBinding = {
      ...baseAdapterBinding,
      spec: {
        ...baseAdapterBinding.spec,
        config: { apiKey: 'ref:secrets/linear-api-key', defaultTeamId: 'global-team' },
        soulOverrides: [
          {
            soul: 'did:platform-x:soul:soul-a',
            config: { defaultTeamId: 'team-alpha' },
          },
        ],
      },
    };
    const result = validate('AdapterBinding', adapterBinding);
    expect(result.valid).toBe(true);
  });

  // AC #7: rejects a soulOverride missing the required 'config' field
  it('rejects a soulOverride missing the required config field', () => {
    const adapterBinding = {
      ...baseAdapterBinding,
      spec: {
        ...baseAdapterBinding.spec,
        soulOverrides: [
          { soul: 'did:platform-x:soul:soul-a' }, // config missing — required
        ],
      },
    };
    const result = validate('AdapterBinding', adapterBinding);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  // AC #7: rejects a soulOverride missing the required 'soul' field
  it('rejects a soulOverride missing the required soul field', () => {
    const adapterBinding = {
      ...baseAdapterBinding,
      spec: {
        ...baseAdapterBinding.spec,
        soulOverrides: [
          { config: { teamId: 'team-alpha' } }, // soul missing — required
        ],
      },
    };
    const result = validate('AdapterBinding', adapterBinding);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  // AC #2: TypeScript type shape — soul override fields present
  it('constructs a soul-scoped AdapterBinding TypeScript value correctly', () => {
    const adapterBinding: AdapterBinding = {
      apiVersion: API_VERSION,
      kind: 'AdapterBinding',
      metadata: { name: 'issue-tracker-tessellated' },
      spec: {
        interface: 'IssueTracker',
        type: 'linear',
        version: '1.0.0',
        soulOverrides: [
          {
            soul: 'did:platform-x:soul:soul-a',
            config: { teamId: 'soul-a-team' },
          },
        ],
      },
    };
    expect(adapterBinding.spec.soulOverrides).toHaveLength(1);
    expect(adapterBinding.spec.soulOverrides![0].soul).toBe('did:platform-x:soul:soul-a');
  });
});

// ─── §8.3 ProvenanceRecord soul-scoping ──────────────────────────────────────

describe('RFC-0009 Phase 3 — ProvenanceRecord soul-scoping (AC #3 + AC #5 + AC #7)', () => {
  // AC #5: backwards-compat — omitting soul fields = platform-wide
  it('creates a ProvenanceRecord without soul-scoping fields (backward-compat)', () => {
    const prov = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
    });
    expect(prov.targetedSouls).toBeUndefined();
    expect(prov.substrateScoped).toBeUndefined();
    expect(prov.tessellatedSoulRef).toBeUndefined();
  });

  // AC #7: soul-scoped scenario
  it('creates a soul-scoped ProvenanceRecord targeting two souls', () => {
    const prov = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
      targetedSouls: ['did:platform-x:soul:soul-a', 'did:platform-x:soul:soul-b'],
      tessellatedSoulRef: 'did:platform-x:platform',
    });
    expect(prov.targetedSouls).toEqual([
      'did:platform-x:soul:soul-a',
      'did:platform-x:soul:soul-b',
    ]);
    expect(prov.tessellatedSoulRef).toBe('did:platform-x:platform');
    expect(prov.substrateScoped).toBeUndefined();
  });

  // AC #7: substrate-scoped scenario
  it('creates a substrate-scoped ProvenanceRecord (cross-soul substrate work)', () => {
    const prov = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'def456',
      substrateScoped: true,
      tessellatedSoulRef: 'did:platform-x:platform',
    });
    expect(prov.substrateScoped).toBe(true);
    expect(prov.tessellatedSoulRef).toBe('did:platform-x:platform');
    expect(prov.targetedSouls).toBeUndefined();
  });

  // AC #7: mixed-scope — substrate-scoped but also lists transitively-affected souls
  it('creates a mixed-scope ProvenanceRecord (substrate + transitive soul refs)', () => {
    const prov = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'ghi789',
      substrateScoped: true,
      targetedSouls: [
        'did:platform-x:soul:soul-a',
        'did:platform-x:soul:soul-b',
        'did:platform-x:soul:soul-c',
      ],
      tessellatedSoulRef: 'did:platform-x:platform',
    });
    expect(prov.substrateScoped).toBe(true);
    expect(prov.targetedSouls).toHaveLength(3);
  });

  // AC #3: round-trip annotation serialization — soul-scoping fields survive
  it('round-trips a soul-scoped ProvenanceRecord through annotations', () => {
    const original = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
      timestamp: '2026-05-23T00:00:00Z',
      reviewDecision: 'approved',
      targetedSouls: ['did:platform-x:soul:soul-a', 'did:platform-x:soul:soul-b'],
      tessellatedSoulRef: 'did:platform-x:platform',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored).not.toBeUndefined();
    expect(restored!.targetedSouls).toEqual([
      'did:platform-x:soul:soul-a',
      'did:platform-x:soul:soul-b',
    ]);
    expect(restored!.tessellatedSoulRef).toBe('did:platform-x:platform');
    expect(restored!.substrateScoped).toBeUndefined();
  });

  // AC #3: round-trip — substrate-scoped ProvenanceRecord
  it('round-trips a substrate-scoped ProvenanceRecord through annotations', () => {
    const original = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'def456',
      timestamp: '2026-05-23T00:00:00Z',
      reviewDecision: 'pending',
      substrateScoped: true,
      tessellatedSoulRef: 'did:platform-x:platform',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored).not.toBeUndefined();
    expect(restored!.substrateScoped).toBe(true);
    expect(restored!.tessellatedSoulRef).toBe('did:platform-x:platform');
    expect(restored!.targetedSouls).toBeUndefined();
  });

  // AC #5: backwards-compat round-trip — no soul fields survive cleanly
  it('round-trips a legacy (non-soul-scoped) ProvenanceRecord without adding soul fields', () => {
    const original = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
      timestamp: '2026-05-23T00:00:00Z',
      reviewDecision: 'approved',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored).not.toBeUndefined();
    expect(restored!.targetedSouls).toBeUndefined();
    expect(restored!.substrateScoped).toBeUndefined();
    expect(restored!.tessellatedSoulRef).toBeUndefined();
  });

  // AC #3: single-soul targeted record
  it('round-trips a single-soul targeted ProvenanceRecord', () => {
    const original = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'terminal',
      promptHash: 'jkl012',
      timestamp: '2026-05-23T12:00:00Z',
      reviewDecision: 'approved',
      targetedSouls: ['did:platform-x:soul:soul-a'],
      tessellatedSoulRef: 'did:platform-x:platform',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored!.targetedSouls).toEqual(['did:platform-x:soul:soul-a']);
    expect(restored!.tessellatedSoulRef).toBe('did:platform-x:platform');
  });
});

// ─── §8.4 QualityGate soul-scoping ───────────────────────────────────────────

describe('RFC-0009 Phase 3 — QualityGate soul-scoping (AC #4 + AC #5 + AC #7)', () => {
  const baseQualityGate = {
    apiVersion: API_VERSION,
    kind: 'QualityGate' as const,
    metadata: { name: 'platform-gate' },
    spec: {
      gates: [
        {
          name: 'test-coverage',
          enforcement: 'hard-mandatory' as const,
          rule: { metric: 'test-coverage', operator: '>=' as const, threshold: 0.8 },
        },
      ],
    },
  };

  // AC #5: backwards-compat — omitting soulScope = platform-wide
  it('validates a QualityGate without soulScope (backward-compat, platform-wide)', () => {
    const result = validate('QualityGate', baseQualityGate);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  // AC #7: soul-scoped scenario
  it('validates a QualityGate with a soulScope (soul-specific gate)', () => {
    const qualityGate: QualityGate = {
      ...baseQualityGate,
      metadata: { name: 'soul-a-voice-gate' },
      spec: {
        ...baseQualityGate.spec,
        soulScope: 'did:platform-x:soul:soul-a',
      },
    };
    const result = validate('QualityGate', qualityGate);
    expect(result.valid).toBe(true);
  });

  // AC #7: soul-scoped gate with multiple per-soul criteria
  it('validates a soul-scoped QualityGate with multiple gate rules', () => {
    const qualityGate: QualityGate = {
      apiVersion: API_VERSION,
      kind: 'QualityGate',
      metadata: { name: 'soul-a-compliance-gate' },
      spec: {
        soulScope: 'did:platform-x:soul:soul-a',
        gates: [
          {
            name: 'hipaa-audit-pass',
            enforcement: 'hard-mandatory',
            rule: { metric: 'hipaa-audit-pass-rate', operator: '>=', threshold: 1.0 },
          },
          {
            name: 'data-isolation-check',
            enforcement: 'hard-mandatory',
            rule: { metric: 'data-isolation-violations', operator: '==', threshold: 0 },
          },
        ],
      },
    };
    const result = validate('QualityGate', qualityGate);
    expect(result.valid).toBe(true);
  });

  // AC #7: mixed-scope — platform gate alongside soul-scoped gate (two separate resources)
  it('validates platform-wide and soul-scoped QualityGates independently (mixed-scope)', () => {
    const platformGate: QualityGate = {
      ...baseQualityGate,
      metadata: { name: 'platform-coverage-gate' },
    };

    const soulGate: QualityGate = {
      ...baseQualityGate,
      metadata: { name: 'soul-a-voice-gate' },
      spec: {
        ...baseQualityGate.spec,
        soulScope: 'did:platform-x:soul:soul-a',
      },
    };

    const platformResult = validate('QualityGate', platformGate);
    const soulResult = validate('QualityGate', soulGate);

    expect(platformResult.valid).toBe(true);
    expect(soulResult.valid).toBe(true);
  });

  // AC #7: voice coherence gate — example from RFC-0009 §8.4 narrative
  it('validates a voice-coherence soul gate (RFC-0009 §8.4 example)', () => {
    const voiceGate: QualityGate = {
      apiVersion: API_VERSION,
      kind: 'QualityGate',
      metadata: { name: 'soul-b-voice-coherence' },
      spec: {
        soulScope: 'did:platform-x:soul:soul-b',
        gates: [
          {
            name: 'voice-register-compliance',
            enforcement: 'advisory',
            rule: {
              metric: 'voice-register-adherence',
              operator: '>=',
              threshold: 0.9,
            },
          },
        ],
        evaluation: {
          pipeline: 'pre-merge',
        },
      },
    };
    const result = validate('QualityGate', voiceGate);
    expect(result.valid).toBe(true);
  });

  // AC #4: TypeScript type shape — soulScope field present
  it('constructs a soul-scoped QualityGate TypeScript value correctly', () => {
    const qualityGate: QualityGate = {
      apiVersion: API_VERSION,
      kind: 'QualityGate',
      metadata: { name: 'soul-c-pci-gate' },
      spec: {
        soulScope: 'did:platform-x:soul:soul-c',
        gates: [
          {
            name: 'pci-compliance',
            enforcement: 'hard-mandatory',
            rule: { metric: 'pci-violations', operator: '==', threshold: 0 },
          },
        ],
      },
    };
    expect(qualityGate.spec.soulScope).toBe('did:platform-x:soul:soul-c');
    expect(qualityGate.spec.gates).toHaveLength(1);
  });
});

// ─── Cross-resource integration scenario ─────────────────────────────────────

describe('RFC-0009 Phase 3 — cross-resource integration (three-soul platform scenario)', () => {
  /**
   * Simulates the worked example from RFC-0009 §11:
   *   Platform-X with three souls: Soul-A (HIPAA), Soul-B (SOC2), Soul-C (PCI-DSS)
   *
   * Tests that soul-scoping fields compose across all four resource types
   * simultaneously without validation errors.
   */
  it('all four resource types validate together in a three-soul platform scenario', () => {
    // AgentRole: soul-a specialist
    const soulAAgent = {
      apiVersion: API_VERSION,
      kind: 'AgentRole' as const,
      metadata: { name: 'soul-a-hipaa-developer' },
      spec: {
        role: 'HIPAA-scoped Developer',
        goal: 'Implement features compliant with HIPAA requirements for Soul-A.',
        tools: ['read', 'write', 'bash'],
        scope: 'soul' as const,
        soulBindings: ['did:platform-x:soul:soul-a'],
      },
    };

    // AdapterBinding: per-soul issue tracker channels
    const issueTrackerBinding = {
      apiVersion: API_VERSION,
      kind: 'AdapterBinding' as const,
      metadata: { name: 'issue-tracker' },
      spec: {
        interface: 'IssueTracker' as const,
        type: 'linear',
        version: '1.0.0',
        config: { workspace: 'platform-x' },
        soulOverrides: [
          { soul: 'did:platform-x:soul:soul-a', config: { teamId: 'alpha-team' } },
          { soul: 'did:platform-x:soul:soul-b', config: { teamId: 'beta-team' } },
          { soul: 'did:platform-x:soul:soul-c', config: { teamId: 'gamma-team' } },
        ],
      },
    };

    // QualityGate: soul-a HIPAA compliance gate
    const soulAComplianceGate = {
      apiVersion: API_VERSION,
      kind: 'QualityGate' as const,
      metadata: { name: 'soul-a-hipaa-compliance' },
      spec: {
        soulScope: 'did:platform-x:soul:soul-a',
        gates: [
          {
            name: 'hipaa-data-isolation',
            enforcement: 'hard-mandatory' as const,
            rule: { metric: 'phi-isolation-violations', operator: '==' as const, threshold: 0 },
          },
        ],
      },
    };

    // ProvenanceRecord: soul-a-targeted work item
    const soulAProvenance = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'soul-a-work-xyz',
      reviewDecision: 'approved',
      targetedSouls: ['did:platform-x:soul:soul-a'],
      tessellatedSoulRef: 'did:platform-x:platform',
    });

    // Validate all schema-validatable resources
    const agentResult = validate('AgentRole', soulAAgent);
    const adapterResult = validate('AdapterBinding', issueTrackerBinding);
    const gateResult = validate('QualityGate', soulAComplianceGate);

    expect(agentResult.valid).toBe(true);
    expect(adapterResult.valid).toBe(true);
    expect(gateResult.valid).toBe(true);

    // Verify ProvenanceRecord soul fields
    expect(soulAProvenance.targetedSouls).toEqual(['did:platform-x:soul:soul-a']);
    expect(soulAProvenance.tessellatedSoulRef).toBe('did:platform-x:platform');
  });

  it('platform-wide resources coexist with soul-scoped resources (mixed-scope scenario)', () => {
    // Platform-wide agent (no soulScope)
    const platformAgent = {
      apiVersion: API_VERSION,
      kind: 'AgentRole' as const,
      metadata: { name: 'substrate-developer' },
      spec: {
        role: 'Substrate Developer',
        goal: 'Maintain the shared substrate.',
        tools: ['read', 'write'],
        // scope absent — defaults to platform-wide
      },
    };

    // Platform-wide adapter (no soulOverrides)
    const platformAdapter = {
      apiVersion: API_VERSION,
      kind: 'AdapterBinding' as const,
      metadata: { name: 'source-control' },
      spec: {
        interface: 'SourceControl' as const,
        type: 'github',
        version: '1.0.0',
        // no soulOverrides — platform-wide
      },
    };

    // Platform-wide gate (no soulScope)
    const platformGate = {
      apiVersion: API_VERSION,
      kind: 'QualityGate' as const,
      metadata: { name: 'platform-coverage' },
      spec: {
        gates: [
          {
            name: 'test-coverage',
            enforcement: 'hard-mandatory' as const,
            rule: { metric: 'test-coverage', operator: '>=' as const, threshold: 0.8 },
          },
        ],
        // no soulScope — platform-wide
      },
    };

    // Soul-scoped agent
    const soulAgent = {
      apiVersion: API_VERSION,
      kind: 'AgentRole' as const,
      metadata: { name: 'soul-c-pci-developer' },
      spec: {
        role: 'PCI-scoped Developer',
        goal: 'Implement Soul-C PCI-DSS-compliant features.',
        tools: ['read', 'write'],
        scope: 'soul' as const,
        soulBindings: ['did:platform-x:soul:soul-c'],
      },
    };

    const results = [
      validate('AgentRole', platformAgent),
      validate('AdapterBinding', platformAdapter),
      validate('QualityGate', platformGate),
      validate('AgentRole', soulAgent),
    ];

    for (const r of results) {
      expect(r.valid).toBe(true);
    }

    // Platform-wide ProvenanceRecord (substrate-scoped)
    const substrateProvenance = createProvenance({
      model: 'claude-sonnet-4-6',
      tool: 'code-editor',
      promptHash: 'substrate-work-abc',
      substrateScoped: true,
      tessellatedSoulRef: 'did:platform-x:platform',
    });
    expect(substrateProvenance.substrateScoped).toBe(true);
    expect(substrateProvenance.targetedSouls).toBeUndefined();
  });
});
