import { describe, it, expect } from 'vitest';
import { AgentCard } from './agent-card';
import type { AgentSummary } from '@/lib/types';

describe('AgentCard', () => {
  it('renders agent summary', () => {
    const agent: AgentSummary = {
      agentName: 'dev-agent',
      currentLevel: 2,
      totalTasks: 50,
      successRate: 0.92,
    };
    const result = AgentCard({ agent });
    expect(result).toBeTruthy();
  });

  it('renders with zero tasks', () => {
    const agent: AgentSummary = {
      agentName: 'new-agent',
      currentLevel: 0,
      totalTasks: 0,
      successRate: 0,
    };
    const result = AgentCard({ agent });
    expect(result).toBeTruthy();
  });

  it('renders highest level', () => {
    const agent: AgentSummary = {
      agentName: 'senior',
      currentLevel: 4,
      totalTasks: 200,
      successRate: 0.99,
    };
    const result = AgentCard({ agent });
    expect(result).toBeTruthy();
  });
});
