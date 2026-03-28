/**
 * Tests for PipelineCycleDetector.
 */

import { describe, it, expect } from 'vitest';
import {
  PipelineCycleDetector,
  createStageMarker,
  parseStageInvocations,
  DEFAULT_CYCLE_LIMITS,
} from './pipeline-cycle-detector.js';

describe('PipelineCycleDetector', () => {
  describe('createStageMarker', () => {
    it('should create a valid HTML comment marker', () => {
      const marker = createStageMarker('agent');
      expect(marker).toMatch(/^<!-- ai-sdlc-cycle:agent:\d+ -->$/);
    });

    it('should include timestamp in marker', () => {
      const marker = createStageMarker('fix-ci');
      const timestampMatch = marker.match(/<!-- ai-sdlc-cycle:fix-ci:(\d+) -->/);
      expect(timestampMatch).not.toBeNull();
      const timestamp = parseInt(timestampMatch![1], 10);
      expect(timestamp).toBeGreaterThan(0);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('parseStageInvocations', () => {
    it('should parse markers from comments', () => {
      const comments = [
        'Fix applied\n<!-- ai-sdlc-cycle:agent:1234567890 -->',
        'Another fix\n<!-- ai-sdlc-cycle:fix-ci:1234567891 -->',
        'Third attempt\n<!-- ai-sdlc-cycle:fix-ci:1234567892 -->',
      ];

      const counts = parseStageInvocations(comments);
      expect(counts.get('agent')).toBe(1);
      expect(counts.get('fix-ci')).toBe(2);
    });

    it('should handle multiple markers in a single comment', () => {
      const comments = [
        'Multi-stage\n<!-- ai-sdlc-cycle:agent:123 -->\n<!-- ai-sdlc-cycle:review:456 -->',
      ];

      const counts = parseStageInvocations(comments);
      expect(counts.get('agent')).toBe(1);
      expect(counts.get('review')).toBe(1);
    });

    it('should return empty map for comments without markers', () => {
      const comments = ['Regular comment', 'Another comment'];
      const counts = parseStageInvocations(comments);
      expect(counts.size).toBe(0);
    });

    it('should handle hyphenated stage names', () => {
      const comments = [
        '<!-- ai-sdlc-cycle:fix-ci:123 -->',
        '<!-- ai-sdlc-cycle:fix-review:456 -->',
      ];

      const counts = parseStageInvocations(comments);
      expect(counts.get('fix-ci')).toBe(1);
      expect(counts.get('fix-review')).toBe(1);
    });
  });

  describe('detectCycleFromComments', () => {
    it('should not detect cycle when below limits', () => {
      const detector = new PipelineCycleDetector();
      const comments = ['<!-- ai-sdlc-cycle:agent:1 -->', '<!-- ai-sdlc-cycle:fix-ci:2 -->'];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(false);
      expect(result.loopingStages).toHaveLength(0);
      expect(result.totalInvocations).toBe(2);
    });

    it('should detect cycle when agent stage exceeds limit', () => {
      const detector = new PipelineCycleDetector();
      const comments = [
        '<!-- ai-sdlc-cycle:agent:1 -->',
        '<!-- ai-sdlc-cycle:agent:2 -->',
        '<!-- ai-sdlc-cycle:agent:3 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      expect(result.loopingStages).toHaveLength(1);
      expect(result.loopingStages[0]).toEqual({
        stage: 'agent',
        count: 3,
        max: DEFAULT_CYCLE_LIMITS.agent,
      });
    });

    it('should detect cycle when fix-ci exceeds limit', () => {
      const detector = new PipelineCycleDetector();
      const comments = ['<!-- ai-sdlc-cycle:fix-ci:1 -->', '<!-- ai-sdlc-cycle:fix-ci:2 -->'];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      expect(result.loopingStages).toHaveLength(1);
      expect(result.loopingStages[0]).toEqual({
        stage: 'fix-ci',
        count: 2,
        max: DEFAULT_CYCLE_LIMITS['fix-ci'],
      });
    });

    it('should detect multiple looping stages', () => {
      const detector = new PipelineCycleDetector();
      const comments = [
        '<!-- ai-sdlc-cycle:agent:1 -->',
        '<!-- ai-sdlc-cycle:agent:2 -->',
        '<!-- ai-sdlc-cycle:agent:3 -->',
        '<!-- ai-sdlc-cycle:fix-ci:4 -->',
        '<!-- ai-sdlc-cycle:fix-ci:5 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      expect(result.loopingStages).toHaveLength(2);
      expect(result.totalInvocations).toBe(5);
    });

    it('should respect custom max invocations', () => {
      const detector = new PipelineCycleDetector({
        maxInvocations: { ...DEFAULT_CYCLE_LIMITS, agent: 5 },
      });
      const comments = [
        '<!-- ai-sdlc-cycle:agent:1 -->',
        '<!-- ai-sdlc-cycle:agent:2 -->',
        '<!-- ai-sdlc-cycle:agent:3 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(false);
    });
  });

  describe('recordInvocation', () => {
    it('should return a valid marker', () => {
      const detector = new PipelineCycleDetector();
      const marker = detector.recordInvocation('review');
      expect(marker).toMatch(/^<!-- ai-sdlc-cycle:review:\d+ -->$/);
    });
  });

  describe('getMaxInvocations', () => {
    it('should return default max for a stage', () => {
      const detector = new PipelineCycleDetector();
      expect(detector.getMaxInvocations('agent')).toBe(DEFAULT_CYCLE_LIMITS.agent);
      expect(detector.getMaxInvocations('fix-ci')).toBe(DEFAULT_CYCLE_LIMITS['fix-ci']);
    });

    it('should return custom max when configured', () => {
      const detector = new PipelineCycleDetector({
        maxInvocations: { ...DEFAULT_CYCLE_LIMITS, agent: 10 },
      });
      expect(detector.getMaxInvocations('agent')).toBe(10);
    });
  });

  describe('updateMaxInvocations', () => {
    it('should update max invocations for specific stages', () => {
      const detector = new PipelineCycleDetector();
      detector.updateMaxInvocations({ agent: 5, 'fix-ci': 4 });
      expect(detector.getMaxInvocations('agent')).toBe(5);
      expect(detector.getMaxInvocations('fix-ci')).toBe(4);
      // Other stages should retain defaults
      expect(detector.getMaxInvocations('review')).toBe(DEFAULT_CYCLE_LIMITS.review);
    });
  });

  describe('integration scenarios', () => {
    it('should detect admission -> triage -> re-edit loop', () => {
      const detector = new PipelineCycleDetector();
      const comments = [
        'Admission scored\n<!-- ai-sdlc-cycle:admission:1 -->',
        'Triage rejected\n<!-- ai-sdlc-cycle:triage:2 -->',
        'Re-admitted\n<!-- ai-sdlc-cycle:admission:3 -->',
        'Triage rejected again\n<!-- ai-sdlc-cycle:triage:4 -->',
        'Third admission\n<!-- ai-sdlc-cycle:admission:5 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      expect(result.loopingStages.length).toBeGreaterThan(0);
      const loopingStageNames = result.loopingStages.map((s) => s.stage);
      expect(loopingStageNames).toContain('admission');
    });

    it('should detect PR -> review -> fix-review loop', () => {
      const detector = new PipelineCycleDetector();
      const comments = [
        'PR created\n<!-- ai-sdlc-cycle:agent:1 -->',
        'Review requested changes\n<!-- ai-sdlc-cycle:review:2 -->',
        'Fix applied\n<!-- ai-sdlc-cycle:fix-review:3 -->',
        'Review requested changes again\n<!-- ai-sdlc-cycle:review:4 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      const loopingStageNames = result.loopingStages.map((s) => s.stage);
      expect(loopingStageNames).toContain('review');
    });

    it('should detect CI -> fix-ci loop', () => {
      const detector = new PipelineCycleDetector();
      const comments = [
        'CI failed\n<!-- ai-sdlc-cycle:fix-ci:1 -->',
        'CI failed differently\n<!-- ai-sdlc-cycle:fix-ci:2 -->',
      ];

      const result = detector.detectCycleFromComments(comments);
      expect(result.cycleDetected).toBe(true);
      expect(result.loopingStages[0].stage).toBe('fix-ci');
    });
  });
});
