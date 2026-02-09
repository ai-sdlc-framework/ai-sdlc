import { describe, it, expect } from 'vitest';
import {
  createPipelineProvenance,
  attachProvenanceToPR,
  validatePipelineProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
} from './provenance.js';

describe('Provenance tracking', () => {
  it('creates a provenance record with defaults', () => {
    const prov = createPipelineProvenance({});
    expect(prov.model).toBe('claude-opus-4-6');
    expect(prov.tool).toBe('claude-code');
    expect(prov.promptHash).toBe('no-prompt');
    expect(prov.reviewDecision).toBe('pending');
    expect(prov.timestamp).toBeDefined();
  });

  it('hashes prompt text when provided', () => {
    const prov = createPipelineProvenance({ promptText: 'fix the bug' });
    expect(prov.promptHash).not.toBe('no-prompt');
    expect(prov.promptHash).toHaveLength(16);
  });

  it('creates deterministic prompt hashes', () => {
    const prov1 = createPipelineProvenance({ promptText: 'fix the bug' });
    const prov2 = createPipelineProvenance({ promptText: 'fix the bug' });
    expect(prov1.promptHash).toBe(prov2.promptHash);
  });

  it('validates a complete provenance record', () => {
    const prov = createPipelineProvenance({});
    const result = validatePipelineProvenance(prov);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('detects missing fields in partial provenance', () => {
    const result = validatePipelineProvenance({ model: 'test' });
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('tool');
    expect(result.missing).toContain('promptHash');
  });

  it('generates PR description with provenance block', () => {
    const prov = createPipelineProvenance({ promptText: 'hello' });
    const block = attachProvenanceToPR(prov);
    expect(block).toContain('## Provenance');
    expect(block).toContain('claude-opus-4-6');
    expect(block).toContain('claude-code');
    expect(block).toContain('provenance-annotations');
  });

  it('round-trips provenance through annotations', () => {
    const prov = createPipelineProvenance({
      model: 'gpt-4',
      tool: 'copilot',
      promptText: 'test prompt',
    });
    const annotations = provenanceToAnnotations(prov);
    const restored = provenanceFromAnnotations(annotations);
    expect(restored).toBeDefined();
    expect(restored!.model).toBe('gpt-4');
    expect(restored!.tool).toBe('copilot');
    expect(restored!.promptHash).toBe(prov.promptHash);
  });

  it('includes human reviewer when present', () => {
    const prov = createPipelineProvenance({ humanReviewer: 'alice' });
    const block = attachProvenanceToPR(prov);
    expect(block).toContain('alice');
  });
});
