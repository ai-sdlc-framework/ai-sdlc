/**
 * Table output formatter — human-readable tabular output.
 */

export function formatTable(data: Record<string, unknown>): string {
  const type = data.type as string;
  const lines: string[] = [];

  switch (type) {
    case 'run': {
      lines.push('Pipeline Run Result');
      lines.push('─'.repeat(40));
      lines.push(`Issue:      #${data.issueNumber}`);
      lines.push(`PR URL:     ${data.prUrl}`);
      lines.push(`Files:      ${data.filesChanged}`);
      lines.push(`Promotion:  ${data.promotionEligible ? 'eligible' : 'not eligible'}`);
      break;
    }
    case 'status': {
      lines.push(`Pipeline: ${data.pipeline}`);
      lines.push('─'.repeat(50));
      const runs = data.recentRuns as Array<Record<string, unknown>>;
      if (runs.length === 0) {
        lines.push('No recent runs.');
      } else {
        lines.push('Run ID'.padEnd(30) + 'Issue'.padEnd(10) + 'Status'.padEnd(12) + 'Started');
        lines.push('─'.repeat(70));
        for (const run of runs) {
          lines.push(
            String(run.runId ?? '').padEnd(30) +
              String(run.issueNumber ? `#${run.issueNumber}` : '-').padEnd(10) +
              String(run.status ?? '').padEnd(12) +
              String(run.startedAt ?? '-'),
          );
        }
      }
      break;
    }
    case 'health': {
      lines.push('Health Check');
      lines.push('─'.repeat(40));
      lines.push(`Config:      ${data.configValid ? 'valid' : 'INVALID'}`);
      lines.push(`State Store: ${data.stateStoreConnected ? 'connected' : 'not configured'}`);
      const errors = data.errors as string[];
      if (errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const e of errors) {
          lines.push(`  - ${e}`);
        }
      }
      break;
    }
    case 'agents': {
      lines.push('Agent Roster');
      lines.push('─'.repeat(50));
      const agents = data.agents as Array<Record<string, unknown>>;
      if (agents.length === 0) {
        lines.push('No agents registered.');
      } else {
        lines.push(
          'Agent'.padEnd(20) +
            'Level'.padEnd(7) +
            'Tasks'.padEnd(7) +
            'Success'.padEnd(9) +
            'Last Task',
        );
        lines.push('─'.repeat(70));
        for (const agent of agents) {
          const total = agent.totalTasks as number;
          const success = agent.successCount as number;
          const pct = total > 0 ? `${Math.round((success / total) * 100)}%` : '-';
          const lastTask = agent.lastTaskAt ? (agent.lastTaskAt as string).split('T')[0] : '-';
          lines.push(
            String(agent.agentName ?? '').padEnd(20) +
              String(agent.currentLevel ?? 0).padEnd(7) +
              String(total).padEnd(7) +
              pct.padEnd(9) +
              lastTask,
          );
        }
      }
      break;
    }
    case 'routing': {
      const duration = (data.duration as string) ?? '30d';
      lines.push(`Routing Distribution (last ${duration})`);
      lines.push('─'.repeat(50));
      const history = data.history as Array<Record<string, unknown>>;

      // Group by strategy
      const groups = new Map<string, number>();
      for (const entry of history) {
        const strategy = entry.routingStrategy as string;
        groups.set(strategy, (groups.get(strategy) ?? 0) + 1);
      }

      if (groups.size === 0) {
        lines.push('No routing decisions recorded.');
      } else {
        lines.push('Strategy'.padEnd(20) + 'Count'.padEnd(8) + 'Percentage');
        lines.push('─'.repeat(50));
        const total = history.length;
        const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
        for (const [strategy, count] of sorted) {
          const pct = `${Math.round((count / total) * 100)}%`;
          lines.push(strategy.padEnd(20) + String(count).padEnd(8) + pct);
        }
      }
      break;
    }
    case 'complexity': {
      const profile = data.profile as Record<string, unknown>;
      const _context = data.context as Record<string, unknown>;
      lines.push('Codebase Complexity Profile');
      lines.push('─'.repeat(50));
      lines.push(
        `Score: ${profile.score}/10 | Files: ${profile.filesCount} | Modules: ${profile.modulesCount} | Deps: ${profile.dependencyCount}`,
      );

      const patterns = profile.architecturalPatterns as Array<Record<string, unknown>> | undefined;
      if (patterns && patterns.length > 0) {
        lines.push('');
        lines.push('Architectural Patterns');
        for (const p of patterns.slice(0, 5)) {
          const pct = Math.round((p.confidence as number) * 100);
          lines.push(`  ${String(p.name).padEnd(16)} ${pct}% — ${p.description}`);
        }
      }

      const hotspots = profile.hotspots as Array<Record<string, unknown>> | undefined;
      if (hotspots && hotspots.length > 0) {
        lines.push('');
        lines.push('Hotspots (top 5)');
        for (const h of hotspots.slice(0, 5)) {
          const churnPct = Math.round((h.churnRate as number) * 100);
          lines.push(
            `  ${String(h.filePath).padEnd(40)} churn: ${churnPct}%  complexity: ${h.complexity}`,
          );
        }
      }

      const conventions = profile.conventions as Array<Record<string, unknown>> | undefined;
      if (conventions && conventions.length > 0) {
        lines.push('');
        lines.push('Conventions');
        for (const c of conventions) {
          lines.push(`  ${c.category}:  ${c.pattern}`);
        }
      }
      break;
    }
    case 'cost': {
      const summary = data.summary as Record<string, unknown>;
      const budget = data.budget as Record<string, unknown>;
      const period = (data.period as string) ?? 'all-time';
      lines.push(`Cost Summary (${period})`);
      lines.push('─'.repeat(50));
      lines.push(`Total Cost:     $${(summary.totalCostUsd as number).toFixed(2)}`);
      lines.push(`Total Tokens:   ${summary.totalTokens}`);
      lines.push(`Runs:           ${summary.entryCount}`);
      lines.push(`Avg Cost/Run:   $${(summary.avgCostPerRun as number).toFixed(4)}`);
      lines.push('');
      lines.push('Budget Status');
      lines.push('─'.repeat(50));
      lines.push(`Budget:         $${budget.budgetUsd}`);
      lines.push(`Spent:          $${(budget.spentUsd as number).toFixed(2)}`);
      lines.push(`Remaining:      $${(budget.remainingUsd as number).toFixed(2)}`);
      lines.push(`Utilization:    ${(budget.utilizationPercent as number).toFixed(1)}%`);
      if (budget.overBudget) {
        lines.push('  ** OVER BUDGET **');
      }

      const costByAgent = summary.costByAgent as Record<string, number> | undefined;
      if (costByAgent && Object.keys(costByAgent).length > 0) {
        lines.push('');
        lines.push('Cost by Agent');
        lines.push('─'.repeat(50));
        lines.push('Agent'.padEnd(20) + 'Cost');
        for (const [agent, cost] of Object.entries(costByAgent)) {
          lines.push(agent.padEnd(20) + `$${cost.toFixed(4)}`);
        }
      }

      if (data.agent && data.filteredCost !== undefined) {
        lines.push('');
        lines.push(`Filtered (${data.agent}): $${(data.filteredCost as number).toFixed(4)}`);
      }
      break;
    }
    default: {
      // Generic key-value output
      for (const [key, value] of Object.entries(data)) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  return lines.join('\n');
}
