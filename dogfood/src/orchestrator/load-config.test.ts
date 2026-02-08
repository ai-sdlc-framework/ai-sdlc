import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from './load-config.js';

const CONFIG_DIR = resolve(import.meta.dirname, '../../../.ai-sdlc');

describe('loadConfig()', () => {
  it('loads and validates all .ai-sdlc/ resources', () => {
    const config = loadConfig(CONFIG_DIR);

    expect(config.pipeline).toBeDefined();
    expect(config.pipeline!.kind).toBe('Pipeline');
    expect(config.pipeline!.metadata.name).toBe('dogfood-pipeline');

    expect(config.agentRole).toBeDefined();
    expect(config.agentRole!.kind).toBe('AgentRole');
    expect(config.agentRole!.spec.role).toBe('coding-agent');

    expect(config.qualityGate).toBeDefined();
    expect(config.qualityGate!.kind).toBe('QualityGate');
    expect(config.qualityGate!.spec.gates).toHaveLength(3);

    expect(config.autonomyPolicy).toBeDefined();
    expect(config.autonomyPolicy!.kind).toBe('AutonomyPolicy');
    expect(config.autonomyPolicy!.spec.levels).toHaveLength(2);

    expect(config.adapterBinding).toBeDefined();
    expect(config.adapterBinding!.kind).toBe('AdapterBinding');
    expect(config.adapterBinding!.spec.type).toBe('github');
  });

  it('returns correct pipeline triggers', () => {
    const config = loadConfig(CONFIG_DIR);
    expect(config.pipeline!.spec.triggers[0].event).toBe('issue.labeled');
    expect(config.pipeline!.spec.triggers[0].filter?.labels).toContain('ai-eligible');
  });

  it('returns correct agent constraints', () => {
    const config = loadConfig(CONFIG_DIR);
    const constraints = config.agentRole!.spec.constraints!;
    expect(constraints.maxFilesPerChange).toBe(15);
    expect(constraints.requireTests).toBe(true);
    expect(constraints.blockedPaths).toContain('.github/workflows/**');
    expect(constraints.blockedPaths).toContain('.ai-sdlc/**');
  });

  it('returns correct quality gates', () => {
    const config = loadConfig(CONFIG_DIR);
    const gates = config.qualityGate!.spec.gates;

    const advisory = gates.find((g) => g.name === 'issue-has-description');
    expect(advisory?.enforcement).toBe('advisory');

    const softMandatory = gates.find((g) => g.name === 'issue-has-acceptance-criteria');
    expect(softMandatory?.enforcement).toBe('soft-mandatory');

    const hardMandatory = gates.find((g) => g.name === 'complexity-in-range');
    expect(hardMandatory?.enforcement).toBe('hard-mandatory');
  });

  it('returns correct autonomy policy levels', () => {
    const config = loadConfig(CONFIG_DIR);
    const levels = config.autonomyPolicy!.spec.levels;

    expect(levels[0].level).toBe(0);
    expect(levels[0].name).toBe('Observer');
    expect(levels[0].guardrails.requireApproval).toBe('all');

    expect(levels[1].level).toBe(1);
    expect(levels[1].name).toBe('Junior');
    expect(levels[1].guardrails.maxLinesPerPR).toBe(200);
  });

  it('throws on invalid config directory', () => {
    expect(() => loadConfig('/nonexistent')).toThrow();
  });
});
