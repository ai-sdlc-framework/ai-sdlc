/**
 * Minimal output formatter — single-line output for scripting.
 */

export function formatMinimal(data: Record<string, unknown>): string {
  const type = data.type as string;

  switch (type) {
    case 'run':
      return `PR: ${data.prUrl} (${data.filesChanged} files)`;
    case 'status':
      return `Pipeline: ${data.pipeline} | Runs: ${(data.recentRuns as unknown[]).length}`;
    case 'health': {
      const ok = data.configValid && (data.errors as string[]).length === 0;
      return ok ? 'OK' : `UNHEALTHY: ${(data.errors as string[]).join('; ')}`;
    }
    case 'agents': {
      const agents = data.agents as unknown[];
      return `Agents: ${agents.length}`;
    }
    case 'routing': {
      const history = data.history as unknown[];
      return `Routing decisions: ${history.length} (last ${data.duration ?? '30d'})`;
    }
    case 'complexity': {
      const profile = data.profile as Record<string, unknown>;
      return `Complexity: ${profile.score}/10 | ${profile.filesCount} files | ${profile.modulesCount} modules`;
    }
    case 'cost': {
      const summary = data.summary as Record<string, unknown>;
      const budget = data.budget as Record<string, unknown>;
      return `Cost: $${(summary.totalCostUsd as number).toFixed(2)} | Budget: ${(budget.utilizationPercent as number).toFixed(0)}% used | Runs: ${summary.entryCount}`;
    }
    default:
      return JSON.stringify(data);
  }
}
