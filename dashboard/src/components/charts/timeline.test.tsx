import { describe, it, expect } from 'vitest';
import { Timeline, type TimelineEvent } from './timeline';

describe('Timeline', () => {
  it('renders empty SVG for no events', () => {
    const result = Timeline({ events: [] });
    expect(result).toBeTruthy();
  });

  it('renders events', () => {
    const events: TimelineEvent[] = [
      { label: 'dev', timestamp: '2026-01-01', type: 'promotion', fromLevel: 1, toLevel: 2 },
      { label: 'dev', timestamp: '2026-01-15', type: 'evaluation', fromLevel: 2, toLevel: 2 },
    ];
    const result = Timeline({ events });
    expect(result).toBeTruthy();
    expect(result?.props?.width).toBe(600);
  });

  it('renders single event', () => {
    const events: TimelineEvent[] = [
      { label: 'agent', timestamp: '2026-02-01', type: 'demotion', fromLevel: 3, toLevel: 2 },
    ];
    const result = Timeline({ events });
    expect(result).toBeTruthy();
  });

  it('handles reset events', () => {
    const events: TimelineEvent[] = [
      { label: 'agent', timestamp: '2026-02-01', type: 'reset', fromLevel: 4, toLevel: 0 },
    ];
    const result = Timeline({ events });
    expect(result).toBeTruthy();
  });

  it('accepts custom dimensions', () => {
    const events: TimelineEvent[] = [
      { label: 'a', timestamp: '2026-01-01', type: 'promotion', fromLevel: 0, toLevel: 1 },
    ];
    const result = Timeline({ events, width: 800, height: 160 });
    expect(result?.props?.width).toBe(800);
  });
});
