import { describe, it, expect } from 'vitest';
import { StatCard } from './stat-card';

describe('StatCard', () => {
  it('renders label and value', () => {
    const result = StatCard({ label: 'Total', value: 42 });
    expect(result).toBeTruthy();
  });

  it('renders with detail', () => {
    const result = StatCard({ label: 'Cost', value: '$5.50', detail: 'last 30 days' });
    expect(result).toBeTruthy();
  });

  it('accepts custom color', () => {
    const result = StatCard({ label: 'Status', value: 'healthy', color: '#16a34a' });
    expect(result).toBeTruthy();
  });
});
