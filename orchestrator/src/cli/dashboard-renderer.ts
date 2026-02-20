/**
 * Dashboard renderer — pure render functions per panel (no I/O).
 * Composes ANSI box-drawing characters for a TUI monitoring view.
 *
 * D1: Zero dependencies, unit-testable pure functions.
 */

import type { AutonomyLedgerEntry } from '../state/types.js';
import type { CostSummary, BudgetStatus } from '../cost-tracker.js';

export interface DashboardData {
  runs: Array<{ runId: string; status: string; startedAt?: string }>;
  agents: AutonomyLedgerEntry[];
  costSummary: CostSummary;
  budgetStatus: BudgetStatus;
}

// ── Box drawing helpers ─────────────────────────────────────────

const BOX = {
  topLeft: '\u250C',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
  horizontal: '\u2500',
  vertical: '\u2502',
  teeRight: '\u251C',
  teeLeft: '\u2524',
} as const;

function boxTop(width: number, title?: string): string {
  if (title) {
    const titleStr = ` ${title} `;
    const remaining = width - 2 - titleStr.length;
    return BOX.topLeft + titleStr + BOX.horizontal.repeat(Math.max(0, remaining)) + BOX.topRight;
  }
  return BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight;
}

function boxBottom(width: number): string {
  return BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight;
}

function boxLine(content: string, width: number): string {
  const padded = content.slice(0, width - 4).padEnd(width - 4);
  return `${BOX.vertical} ${padded} ${BOX.vertical}`;
}

function boxSeparator(width: number): string {
  return BOX.teeRight + BOX.horizontal.repeat(width - 2) + BOX.teeLeft;
}

// ── Panel renderers ─────────────────────────────────────────────

export function renderPipelinePanel(runs: DashboardData['runs'], width: number): string[] {
  const lines: string[] = [];
  lines.push(boxTop(width, 'Active Pipelines'));

  if (runs.length === 0) {
    lines.push(boxLine('No recent runs.', width));
  } else {
    lines.push(boxLine('Run ID'.padEnd(24) + 'Status'.padEnd(12) + 'Started', width));
    lines.push(boxSeparator(width));
    for (const run of runs.slice(0, 5)) {
      const started = run.startedAt?.split('T')[1]?.slice(0, 8) ?? '-';
      lines.push(
        boxLine(run.runId.slice(0, 22).padEnd(24) + run.status.padEnd(12) + started, width),
      );
    }
  }

  lines.push(boxBottom(width));
  return lines;
}

export function renderAgentPanel(agents: DashboardData['agents'], width: number): string[] {
  const lines: string[] = [];
  lines.push(boxTop(width, 'Agents'));

  if (agents.length === 0) {
    lines.push(boxLine('No agents registered.', width));
  } else {
    lines.push(
      boxLine(
        'Agent'.padEnd(18) + 'Lvl'.padEnd(5) + 'Tasks'.padEnd(8) + 'Rate'.padEnd(8) + 'Last',
        width,
      ),
    );
    lines.push(boxSeparator(width));
    for (const agent of agents.slice(0, 5)) {
      const rate =
        agent.totalTasks > 0
          ? `${Math.round((agent.successCount / agent.totalTasks) * 100)}%`
          : '-';
      const last = agent.lastTaskAt?.split('T')[0] ?? '-';
      lines.push(
        boxLine(
          agent.agentName.slice(0, 16).padEnd(18) +
            String(agent.currentLevel).padEnd(5) +
            String(agent.totalTasks).padEnd(8) +
            rate.padEnd(8) +
            last,
          width,
        ),
      );
    }
  }

  lines.push(boxBottom(width));
  return lines;
}

export function renderCostPanel(
  summary: CostSummary,
  budget: BudgetStatus,
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push(boxTop(width, 'Cost'));

  lines.push(
    boxLine(
      `Total: $${summary.totalCostUsd.toFixed(2)}  |  Tokens: ${formatNumber(summary.totalTokens)}  |  Runs: ${summary.entryCount}`,
      width,
    ),
  );
  lines.push(
    boxLine(
      `Avg/run: $${summary.avgCostPerRun.toFixed(4)}  |  Budget: $${budget.budgetUsd} (${budget.utilizationPercent.toFixed(0)}% used)`,
      width,
    ),
  );

  // Budget bar
  const barWidth = Math.max(10, width - 20);
  const filled = Math.min(barWidth, Math.round((budget.utilizationPercent / 100) * barWidth));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
  const budgetStatus = budget.overBudget ? ' OVER BUDGET!' : '';
  lines.push(boxLine(`[${bar}]${budgetStatus}`, width));

  // Cost by agent
  if (Object.keys(summary.costByAgent).length > 0) {
    lines.push(boxSeparator(width));
    for (const [agent, cost] of Object.entries(summary.costByAgent).slice(0, 3)) {
      lines.push(boxLine(`  ${agent.padEnd(16)} $${cost.toFixed(4)}`, width));
    }
  }

  lines.push(boxBottom(width));
  return lines;
}

export function renderHeaderPanel(width: number): string[] {
  const now = new Date().toLocaleString();
  return [boxTop(width, 'AI-SDLC Dashboard'), boxLine(`Updated: ${now}`, width), boxBottom(width)];
}

// ── Composer ─────────────────────────────────────────────────────

export function renderDashboardFrame(data: DashboardData, width: number): string {
  const panelWidth = Math.max(40, width);
  const allLines: string[] = [];

  allLines.push(...renderHeaderPanel(panelWidth));
  allLines.push('');
  allLines.push(...renderPipelinePanel(data.runs, panelWidth));
  allLines.push('');
  allLines.push(...renderAgentPanel(data.agents, panelWidth));
  allLines.push('');
  allLines.push(...renderCostPanel(data.costSummary, data.budgetStatus, panelWidth));

  // Pad to fill terminal height to avoid artifacts
  const termHeight = process.stdout.rows || 40;
  while (allLines.length < termHeight - 1) {
    allLines.push('');
  }

  return allLines.join('\n');
}

// ── Utilities ───────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
