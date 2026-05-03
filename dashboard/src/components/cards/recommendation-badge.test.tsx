import { describe, it, expect } from 'vitest';
import { RecommendationBadge } from './recommendation-badge';

describe('RecommendationBadge', () => {
  it('renders the safe-to-enforce variant', () => {
    const result = RecommendationBadge({ recommendation: 'safe-to-enforce' });
    expect(result).toBeTruthy();
    expect(result.props.children[0]).toBe('safe to enforce');
  });

  it('renders the continue-soak variant', () => {
    const result = RecommendationBadge({ recommendation: 'continue-soak' });
    expect(result).toBeTruthy();
    expect(result.props.children[0]).toBe('continue soak');
  });

  it('renders the insufficient-data variant', () => {
    const result = RecommendationBadge({ recommendation: 'insufficient-data' });
    expect(result).toBeTruthy();
    expect(result.props.children[0]).toBe('insufficient data');
  });

  it('appends the n=count when provided', () => {
    const result = RecommendationBadge({ recommendation: 'safe-to-enforce', n: 42 });
    expect(result.props.children[1]).toBe(' · n=42');
  });

  it('omits n when not provided', () => {
    const result = RecommendationBadge({ recommendation: 'continue-soak' });
    expect(result.props.children[1]).toBe('');
  });
});
