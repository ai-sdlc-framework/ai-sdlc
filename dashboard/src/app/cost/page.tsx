/**
 * Cost analytics page — summary, time series, by-agent breakdown, budget gauge.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { BarChart, type BarChartDatum } from '@/components/charts/bar-chart';
import { LineChart, type LineChartDatum } from '@/components/charts/line-chart';
import { getStateStore } from '@/lib/state';

function getCostData() {
  const store = getStateStore();

  const totals = store
    .getDatabase()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
              COALESCE(SUM(total_tokens), 0) as total_tokens,
              COUNT(*) as run_count
       FROM cost_ledger`,
    )
    .get() as Record<string, number>;

  const byAgent = store
    .getDatabase()
    .prepare(
      `SELECT agent_name, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
       FROM cost_ledger GROUP BY agent_name ORDER BY cost_usd DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const byModel = store
    .getDatabase()
    .prepare(
      `SELECT model, COALESCE(SUM(cost_usd), 0) as cost_usd, COUNT(*) as runs
       FROM cost_ledger WHERE model IS NOT NULL GROUP BY model ORDER BY cost_usd DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const timeSeries = store
    .getDatabase()
    .prepare(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(cost_usd), 0) as cost_usd,
              COUNT(*) as runs
       FROM cost_ledger
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY DATE(created_at)
       ORDER BY date`,
    )
    .all() as Array<Record<string, unknown>>;

  return { totals, byAgent, byModel, timeSeries };
}

function BudgetGauge({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
  const overBudget = spent > budget;
  const barColor = overBudget ? '#ef4444' : pct > 80 ? '#f59e0b' : '#22c55e';

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 14 }}
      >
        <span>
          Budget: ${spent.toFixed(2)} / ${budget.toFixed(2)}
        </span>
        <span style={{ color: barColor }}>{pct.toFixed(1)}%</span>
      </div>
      <div
        style={{
          width: '100%',
          height: 8,
          backgroundColor: '#e2e8f0',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: barColor,
            borderRadius: 4,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      {overBudget && (
        <p style={{ color: '#ef4444', fontSize: 12, marginTop: 4 }}>
          Over budget by ${(spent - budget).toFixed(2)}
        </p>
      )}
    </div>
  );
}

export default function CostPage() {
  const { totals, byAgent, byModel, timeSeries } = getCostData();

  const agentBarData: BarChartDatum[] = byAgent.map((r) => ({
    label: (r.agent_name as string).slice(0, 10),
    value: r.cost_usd as number,
  }));

  const modelBarData: BarChartDatum[] = byModel.map((r) => ({
    label: (r.model as string).replace('claude-', '').slice(0, 12),
    value: r.cost_usd as number,
  }));

  const lineData: LineChartDatum[] = timeSeries.map((r) => ({
    label: (r.date as string).slice(5), // MM-DD
    value: r.cost_usd as number,
  }));

  const avgCost = totals.run_count > 0 ? totals.total_cost / totals.run_count : 0;
  const budgetUsd = 500;

  return (
    <div>
      <Header title="Cost Analytics" subtitle="Token usage, cost tracking, and budget" />

      <BudgetGauge spent={totals.total_cost} budget={budgetUsd} />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Total Cost" value={`$${totals.total_cost.toFixed(2)}`} />
        <StatCard label="Total Tokens" value={totals.total_tokens.toLocaleString()} />
        <StatCard label="Total Runs" value={totals.run_count} />
        <StatCard label="Avg Cost/Run" value={`$${avgCost.toFixed(3)}`} />
        <StatCard
          label="Budget Remaining"
          value={`$${Math.max(0, budgetUsd - totals.total_cost).toFixed(2)}`}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Cost by Agent</h2>
          {agentBarData.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>No cost data yet.</p>
          ) : (
            <BarChart data={agentBarData} width={500} height={250} />
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Cost by Model</h2>
          {modelBarData.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>No cost data yet.</p>
          ) : (
            <BarChart data={modelBarData} width={500} height={250} />
          )}
        </section>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 24, marginTop: 24 }}>
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Daily Cost (30d)</h2>
          {lineData.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>No cost data yet.</p>
          ) : (
            <LineChart data={lineData} width={1024} height={250} />
          )}
        </section>
      </div>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Cost Breakdown</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Agent</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Cost (USD)</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Runs</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Avg/Run</th>
            </tr>
          </thead>
          <tbody>
            {byAgent.map((r) => {
              const cost = r.cost_usd as number;
              const runs = r.runs as number;
              return (
                <tr key={r.agent_name as string} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: 8 }}>{r.agent_name as string}</td>
                  <td style={{ textAlign: 'right', padding: 8 }}>${cost.toFixed(2)}</td>
                  <td style={{ textAlign: 'right', padding: 8 }}>{runs}</td>
                  <td style={{ textAlign: 'right', padding: 8 }}>
                    ${runs > 0 ? (cost / runs).toFixed(3) : '0.000'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
