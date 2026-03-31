import { describe, it, expect } from 'vitest';
import type { ToolSequenceEvent } from '../state/types.js';
import type { DetectedPattern } from './types.js';
import {
  canonicalizeStep,
  hashSequence,
  extractSessionSequences,
  generateNGrams,
  mineFrequentPatterns,
} from './detector.js';
import { classifyPattern } from './classifiers.js';

function makeEvent(
  sessionId: string,
  tool: string,
  action: string,
  timestamp: string,
): ToolSequenceEvent {
  return { sessionId, toolName: tool, actionCanonical: action, timestamp };
}

// Helper: create a standard 4-step sequence for a session
function makeSession(sessionId: string, baseTime: string): ToolSequenceEvent[] {
  const base = new Date(baseTime).getTime();
  return [
    makeEvent(sessionId, 'Read', 'read:.ts', new Date(base).toISOString()),
    makeEvent(sessionId, 'Edit', 'edit:.ts', new Date(base + 1000).toISOString()),
    makeEvent(sessionId, 'Bash', 'pnpm test', new Date(base + 2000).toISOString()),
    makeEvent(sessionId, 'Bash', 'git commit -m', new Date(base + 3000).toISOString()),
  ];
}

describe('canonicalizeStep', () => {
  it('creates a canonical step from an event', () => {
    const step = canonicalizeStep(makeEvent('s1', 'Bash', 'pnpm test', '2026-01-01'));
    expect(step.tool).toBe('Bash');
    expect(step.action).toBe('pnpm test');
    expect(step.category).toBe('test');
  });

  it('categorizes git commands', () => {
    const step = canonicalizeStep(makeEvent('s1', 'Bash', 'git commit -m', '2026-01-01'));
    expect(step.category).toBe('git');
  });
});

describe('hashSequence', () => {
  it('produces consistent hashes for same sequences', () => {
    const steps = [
      { tool: 'Read', action: 'read:.ts', category: 'read' as const },
      { tool: 'Edit', action: 'edit:.ts', category: 'write' as const },
    ];
    expect(hashSequence(steps)).toBe(hashSequence(steps));
  });

  it('produces different hashes for different sequences', () => {
    const a = [{ tool: 'Read', action: 'read:.ts', category: 'read' as const }];
    const b = [{ tool: 'Edit', action: 'edit:.ts', category: 'write' as const }];
    expect(hashSequence(a)).not.toBe(hashSequence(b));
  });
});

describe('extractSessionSequences', () => {
  it('groups events by session and sorts by timestamp', () => {
    const events = [
      makeEvent('s1', 'Edit', 'edit:.ts', '2026-01-01T00:00:02Z'),
      makeEvent('s1', 'Read', 'read:.ts', '2026-01-01T00:00:01Z'),
      makeEvent('s2', 'Bash', 'pnpm test', '2026-01-01T00:00:00Z'),
    ];

    const sessions = extractSessionSequences(events);
    expect(sessions.size).toBe(2);

    const s1 = sessions.get('s1')!;
    expect(s1).toHaveLength(2);
    expect(s1[0].tool).toBe('Read'); // sorted first
    expect(s1[1].tool).toBe('Edit');
  });
});

describe('generateNGrams', () => {
  it('generates correct n-grams', () => {
    const steps = [
      { tool: 'A', action: 'a', category: 'other' as const },
      { tool: 'B', action: 'b', category: 'other' as const },
      { tool: 'C', action: 'c', category: 'other' as const },
      { tool: 'D', action: 'd', category: 'other' as const },
    ];

    const ngrams = generateNGrams(steps, 's1', 3, 4);

    // 3-grams: [A,B,C], [B,C,D] = 2
    // 4-grams: [A,B,C,D] = 1
    expect(ngrams).toHaveLength(3);
  });

  it('returns empty for sequences shorter than minN', () => {
    const steps = [{ tool: 'A', action: 'a', category: 'other' as const }];
    expect(generateNGrams(steps, 's1', 3, 5)).toHaveLength(0);
  });
});

describe('mineFrequentPatterns', () => {
  it('returns empty for no events', () => {
    expect(mineFrequentPatterns([])).toEqual([]);
  });

  it('returns empty when too few sessions', () => {
    const events = makeSession('s1', '2026-01-01T00:00:00Z');
    expect(mineFrequentPatterns(events, { minSessionCount: 3 })).toEqual([]);
  });

  it('detects a repeated 4-step sequence across 3 sessions', () => {
    const events = [
      ...makeSession('s1', '2026-01-01T00:00:00Z'),
      ...makeSession('s2', '2026-01-02T00:00:00Z'),
      ...makeSession('s3', '2026-01-03T00:00:00Z'),
    ];

    const patterns = mineFrequentPatterns(events, {
      minSequenceLength: 3,
      maxSequenceLength: 4,
      minFrequency: 3,
      minSessionCount: 3,
      minConfidence: 0,
    });

    expect(patterns.length).toBeGreaterThan(0);
    // Should find the 4-step pattern or 3-step subsets
    const longest = patterns.reduce((a, b) => (a.steps.length > b.steps.length ? a : b));
    expect(longest.steps.length).toBeGreaterThanOrEqual(3);
    expect(longest.sessionCount).toBe(3);
  });

  it('removes subsumed shorter patterns', () => {
    const events = [
      ...makeSession('s1', '2026-01-01T00:00:00Z'),
      ...makeSession('s2', '2026-01-02T00:00:00Z'),
      ...makeSession('s3', '2026-01-03T00:00:00Z'),
    ];

    const patterns = mineFrequentPatterns(events, {
      minSequenceLength: 3,
      maxSequenceLength: 8,
      minFrequency: 3,
      minSessionCount: 3,
      minConfidence: 0,
    });

    // The 4-step pattern should subsume the 3-step patterns
    const fourStepPatterns = patterns.filter((p) => p.steps.length === 4);
    const threeStepPatterns = patterns.filter((p) => p.steps.length === 3);

    // If a 4-step pattern exists, 3-step subsets should be removed
    if (fourStepPatterns.length > 0) {
      expect(threeStepPatterns.length).toBe(0);
    }
  });

  it('filters by project path', () => {
    const events = [
      ...makeSession('s1', '2026-01-01T00:00:00Z').map((e) => ({ ...e, projectPath: '/repo-a' })),
      ...makeSession('s2', '2026-01-02T00:00:00Z').map((e) => ({ ...e, projectPath: '/repo-a' })),
      ...makeSession('s3', '2026-01-03T00:00:00Z').map((e) => ({ ...e, projectPath: '/repo-a' })),
      ...makeSession('s4', '2026-01-04T00:00:00Z').map((e) => ({ ...e, projectPath: '/repo-b' })),
    ];

    const patterns = mineFrequentPatterns(events, {
      projectFilter: '/repo-a',
      minSequenceLength: 3,
      minFrequency: 3,
      minSessionCount: 3,
      minConfidence: 0,
    });

    // Only repo-a sessions should be considered
    for (const p of patterns) {
      expect(p.exampleSessionIds.every((id) => ['s1', 's2', 's3'].includes(id))).toBe(true);
    }
  });

  it('filters by since timestamp', () => {
    const events = [
      ...makeSession('s1', '2025-01-01T00:00:00Z'),
      ...makeSession('s2', '2026-06-01T00:00:00Z'),
      ...makeSession('s3', '2026-06-02T00:00:00Z'),
      ...makeSession('s4', '2026-06-03T00:00:00Z'),
    ];

    const patterns = mineFrequentPatterns(events, {
      since: '2026-01-01T00:00:00Z',
      minSequenceLength: 3,
      minFrequency: 3,
      minSessionCount: 3,
      minConfidence: 0,
    });

    // s1 should be excluded
    for (const p of patterns) {
      expect(p.exampleSessionIds).not.toContain('s1');
    }
  });

  it('confidence is bounded [0, 1]', () => {
    const events = [
      ...makeSession('s1', '2026-01-01T00:00:00Z'),
      ...makeSession('s2', '2026-01-02T00:00:00Z'),
      ...makeSession('s3', '2026-01-03T00:00:00Z'),
    ];

    const patterns = mineFrequentPatterns(events, {
      minSequenceLength: 3,
      minFrequency: 3,
      minSessionCount: 3,
      minConfidence: 0,
    });

    for (const p of patterns) {
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('classifyPattern', () => {
  it('classifies read→write pattern as copy-paste-cycle', () => {
    const pattern: DetectedPattern = {
      hash: 'test',
      steps: [
        { tool: 'Read', action: 'read:.tsx', category: 'read' },
        { tool: 'Write', action: 'write:.tsx', category: 'write' },
        { tool: 'Write', action: 'write:.test.tsx', category: 'write' },
      ],
      frequency: 5,
      sessionCount: 3,
      confidence: 0.8,
      patternType: 'command-sequence',
      suggestedArtifactType: 'command',
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-10',
      exampleSessionIds: ['s1', 's2', 's3'],
    };

    const classified = classifyPattern(pattern);
    expect(classified.patternType).toBe('copy-paste-cycle');
    expect(classified.suggestedArtifactType).toBe('skill');
  });

  it('classifies long-spanning pattern as periodic-task', () => {
    const pattern: DetectedPattern = {
      hash: 'test',
      steps: [
        { tool: 'Bash', action: 'pnpm test', category: 'test' },
        { tool: 'Bash', action: 'git commit -m', category: 'git' },
        { tool: 'Bash', action: 'git push origin', category: 'git' },
      ],
      frequency: 10,
      sessionCount: 5,
      confidence: 0.9,
      patternType: 'command-sequence',
      suggestedArtifactType: 'command',
      firstSeen: '2026-01-01',
      lastSeen: '2026-02-01', // 31 days span
      exampleSessionIds: ['s1', 's2', 's3', 's4', 's5'],
    };

    const classified = classifyPattern(pattern);
    expect(classified.patternType).toBe('periodic-task');
    expect(classified.suggestedArtifactType).toBe('workflow');
  });

  it('defaults to command-sequence for simple tool chains', () => {
    const pattern: DetectedPattern = {
      hash: 'test',
      steps: [
        { tool: 'Bash', action: 'pnpm build', category: 'build' },
        { tool: 'Bash', action: 'pnpm test', category: 'test' },
        { tool: 'Bash', action: 'pnpm lint', category: 'other' },
      ],
      frequency: 5,
      sessionCount: 3,
      confidence: 0.7,
      patternType: 'command-sequence',
      suggestedArtifactType: 'command',
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-03', // Only 2 days
      exampleSessionIds: ['s1', 's2', 's3'],
    };

    const classified = classifyPattern(pattern);
    expect(classified.patternType).toBe('command-sequence');
    expect(classified.suggestedArtifactType).toBe('command');
  });

  it('periodic-task requires 7+ day span', () => {
    const pattern: DetectedPattern = {
      hash: 'test',
      steps: [{ tool: 'Bash', action: 'check', category: 'other' }],
      frequency: 5,
      sessionCount: 3,
      confidence: 0.8,
      patternType: 'command-sequence',
      suggestedArtifactType: 'command',
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-05', // Only 4 days
      exampleSessionIds: ['s1', 's2', 's3'],
    };

    const classified = classifyPattern(pattern);
    expect(classified.patternType).not.toBe('periodic-task');
  });
});
