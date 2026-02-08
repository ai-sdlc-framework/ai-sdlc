import { describe, it, expect } from 'vitest';
import { classifyApprovalTier, compareTiers } from './approval-tier.js';

describe('classifyApprovalTier', () => {
  it('classifies low complexity (1-3) as auto', () => {
    expect(classifyApprovalTier({ complexityScore: 1 })).toBe('auto');
    expect(classifyApprovalTier({ complexityScore: 2 })).toBe('auto');
    expect(classifyApprovalTier({ complexityScore: 3 })).toBe('auto');
  });

  it('classifies medium complexity (4-6) as peer-review', () => {
    expect(classifyApprovalTier({ complexityScore: 4 })).toBe('peer-review');
    expect(classifyApprovalTier({ complexityScore: 5 })).toBe('peer-review');
    expect(classifyApprovalTier({ complexityScore: 6 })).toBe('peer-review');
  });

  it('classifies high complexity (7-8) as team-lead', () => {
    expect(classifyApprovalTier({ complexityScore: 7 })).toBe('team-lead');
    expect(classifyApprovalTier({ complexityScore: 8 })).toBe('team-lead');
  });

  it('classifies very high complexity (9+) as security-review', () => {
    expect(classifyApprovalTier({ complexityScore: 9 })).toBe('security-review');
    expect(classifyApprovalTier({ complexityScore: 10 })).toBe('security-review');
  });

  it('escalates infra changes to at least team-lead', () => {
    expect(classifyApprovalTier({ complexityScore: 2, isInfraChange: true })).toBe('team-lead');
    expect(classifyApprovalTier({ complexityScore: 5, isInfraChange: true })).toBe('team-lead');
    // Already team-lead or higher, no change
    expect(classifyApprovalTier({ complexityScore: 7, isInfraChange: true })).toBe('team-lead');
    expect(classifyApprovalTier({ complexityScore: 9, isInfraChange: true })).toBe(
      'security-review',
    );
  });

  it('security-sensitive always requires security-review', () => {
    expect(classifyApprovalTier({ complexityScore: 1, securitySensitive: true })).toBe(
      'security-review',
    );
    expect(classifyApprovalTier({ complexityScore: 5, securitySensitive: true })).toBe(
      'security-review',
    );
  });
});

describe('compareTiers', () => {
  it('returns 0 for equal tiers', () => {
    expect(compareTiers('auto', 'auto')).toBe(0);
    expect(compareTiers('security-review', 'security-review')).toBe(0);
  });

  it('returns positive when first tier is higher', () => {
    expect(compareTiers('security-review', 'auto')).toBeGreaterThan(0);
    expect(compareTiers('team-lead', 'peer-review')).toBeGreaterThan(0);
  });

  it('returns negative when first tier is lower', () => {
    expect(compareTiers('auto', 'security-review')).toBeLessThan(0);
    expect(compareTiers('peer-review', 'team-lead')).toBeLessThan(0);
  });
});
