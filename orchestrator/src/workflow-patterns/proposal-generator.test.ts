import { describe, it, expect } from 'vitest';
import { generateProposal, generateName } from './proposal-generator.js';
import type { DetectedPattern } from './types.js';

function makePattern(overrides?: Partial<DetectedPattern>): DetectedPattern {
  return {
    hash: 'abc12345',
    steps: [
      { tool: 'Bash', action: 'pnpm build', category: 'build' },
      { tool: 'Bash', action: 'pnpm test', category: 'test' },
      { tool: 'Bash', action: 'pnpm lint', category: 'other' },
    ],
    frequency: 5,
    sessionCount: 3,
    confidence: 0.8,
    patternType: 'command-sequence',
    suggestedArtifactType: 'command',
    firstSeen: '2026-01-01',
    lastSeen: '2026-01-10',
    exampleSessionIds: ['s1', 's2', 's3'],
    ...overrides,
  };
}

describe('generateName', () => {
  it('generates kebab-case name from steps', () => {
    const name = generateName(makePattern());
    expect(name).toMatch(/^auto-/);
    expect(name).toContain('pnpm');
  });

  it('limits name length', () => {
    const name = generateName(makePattern());
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it('uses hash fallback for empty actions', () => {
    const name = generateName(
      makePattern({
        steps: [{ tool: 'Bash', action: '...', category: 'other' }],
      }),
    );
    expect(name).toMatch(/^auto-pattern-/);
  });

  it('deduplicates action parts', () => {
    const name = generateName(
      makePattern({
        steps: [
          { tool: 'Bash', action: 'pnpm test', category: 'test' },
          { tool: 'Bash', action: 'pnpm test', category: 'test' },
          { tool: 'Bash', action: 'pnpm lint', category: 'other' },
        ],
      }),
    );
    // "pnpm-test" should appear only once in the name
    const matches = name.match(/pnpm-test/g);
    expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe('generateProposal', () => {
  it('generates command proposal for command-sequence', () => {
    const proposal = generateProposal(makePattern());

    expect(proposal.artifactType).toBe('command');
    expect(proposal.artifactPath).toMatch(/^\.claude\/commands\/auto-.*\.md$/);
    expect(proposal.draftContent).toContain('---');
    expect(proposal.draftContent).toContain('name:');
    expect(proposal.draftContent).toContain('pnpm build');
    expect(proposal.draftContent).toContain('pnpm test');
    expect(proposal.draftContent).toContain('80%'); // confidence
    expect(proposal.status).toBe('pending');
  });

  it('generates skill proposal for copy-paste-cycle', () => {
    const proposal = generateProposal(
      makePattern({
        patternType: 'copy-paste-cycle',
        suggestedArtifactType: 'skill',
      }),
    );

    expect(proposal.artifactType).toBe('skill');
    expect(proposal.artifactPath).toMatch(/^\.claude\/skills\/auto-.*\/SKILL\.md$/);
    expect(proposal.draftContent).toContain('name:');
    expect(proposal.draftContent).toContain('Workflow');
  });

  it('generates workflow proposal for periodic-task', () => {
    const proposal = generateProposal(
      makePattern({
        patternType: 'periodic-task',
        suggestedArtifactType: 'workflow',
      }),
    );

    expect(proposal.artifactType).toBe('workflow');
    expect(proposal.artifactPath).toMatch(/^\.github\/workflows\/auto-.*\.yml$/);
    expect(proposal.draftContent).toContain('schedule');
    expect(proposal.draftContent).toContain('cron');
  });

  it('generates hook proposal', () => {
    const proposal = generateProposal(
      makePattern({
        suggestedArtifactType: 'hook',
      }),
    );

    expect(proposal.artifactType).toBe('hook');
    expect(proposal.artifactPath).toMatch(/^\.claude\/hooks\/auto-.*\.sh$/);
    expect(proposal.draftContent).toContain('#!/bin/bash');
    expect(proposal.draftContent).toContain('set -euo pipefail');
  });

  it('includes confidence and frequency in template', () => {
    const proposal = generateProposal(makePattern({ confidence: 0.92, frequency: 12 }));

    expect(proposal.draftContent).toContain('92%');
    expect(proposal.draftContent).toContain('12 times');
  });

  it('proposal confidence accounts for artifact type fit', () => {
    const cmdProposal = generateProposal(
      makePattern({ confidence: 0.8, suggestedArtifactType: 'command' }),
    );
    const wfProposal = generateProposal(
      makePattern({ confidence: 0.8, suggestedArtifactType: 'workflow' }),
    );

    // Workflow has lower template fit (0.8) vs command (1.0)
    expect(wfProposal.confidence).toBeLessThan(cmdProposal.confidence);
  });

  it('confidence is bounded at 1.0', () => {
    const proposal = generateProposal(makePattern({ confidence: 1.0 }));
    expect(proposal.confidence).toBeLessThanOrEqual(1.0);
  });
});
