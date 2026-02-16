/**
 * Codebase health page — complexity, hotspots, module graph.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { Heatmap, type HeatmapCell } from '@/components/charts/heatmap';
import { ModuleGraph, type GraphNode, type GraphEdge } from '@/components/graphs/module-graph';
import { DataTable, type Column } from '@/components/tables/data-table';
import { getStateStore } from '@/lib/state';

function getCodebaseData() {
  const store = getStateStore();

  const profiles = store.getDatabase()
    .prepare(
      `SELECT repo_path, score, files_count, modules_count, dependency_count,
              analyzed_at, module_graph
       FROM complexity_profiles ORDER BY analyzed_at DESC LIMIT 1`,
    )
    .all() as Array<Record<string, unknown>>;

  const hotspots = store.getDatabase()
    .prepare(
      `SELECT file_path, churn_rate, complexity, commit_count, last_modified
       FROM hotspots ORDER BY churn_rate DESC LIMIT 30`,
    )
    .all() as Array<Record<string, unknown>>;

  return { profiles, hotspots };
}

export default function CodebasePage() {
  const { profiles, hotspots } = getCodebaseData();

  const latest = profiles[0];
  const score = latest ? (latest.score as number) : 0;
  const filesCount = latest ? ((latest.files_count as number) || 0) : 0;
  const modulesCount = latest ? ((latest.modules_count as number) || 0) : 0;

  // Parse module graph for visualization
  let graphNodes: GraphNode[] = [];
  let graphEdges: GraphEdge[] = [];
  if (latest?.module_graph) {
    try {
      const mg = JSON.parse(latest.module_graph as string);
      if (mg.modules && Array.isArray(mg.modules)) {
        graphNodes = mg.modules.map((m: { name: string; type?: string }) => ({
          id: m.name,
          label: m.name,
          group: m.type ?? 'default',
        }));
      }
      if (mg.edges && Array.isArray(mg.edges)) {
        graphEdges = mg.edges.map((e: { from: string; to: string }) => ({
          source: e.from,
          target: e.to,
        }));
      }
    } catch {
      // Ignore parse errors
    }
  }

  const heatmapData: HeatmapCell[] = hotspots.slice(0, 20).map((h) => ({
    label: (h.file_path as string).split('/').pop() ?? (h.file_path as string),
    value: h.churn_rate as number,
  }));

  const hotspotColumns: Column<Record<string, unknown>>[] = [
    {
      key: 'file_path',
      label: 'File',
      render: (r) => {
        const path = r.file_path as string;
        return path.length > 50 ? `...${path.slice(-47)}` : path;
      },
    },
    { key: 'churn_rate', label: 'Churn', align: 'right', render: (r) => (r.churn_rate as number).toFixed(2) },
    { key: 'complexity', label: 'Complexity', align: 'right' },
    { key: 'commit_count', label: 'Commits', align: 'right' },
  ];

  return (
    <div>
      <Header title="Codebase Health" subtitle="Complexity metrics and hotspot analysis" />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Complexity" value={score.toFixed(1)} />
        <StatCard label="Files" value={filesCount} />
        <StatCard label="Modules" value={modulesCount} />
        <StatCard label="Hotspots" value={hotspots.length} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Churn Heatmap</h2>
          {heatmapData.length === 0
            ? <p style={{ color: '#94a3b8' }}>No hotspot data.</p>
            : <Heatmap data={heatmapData} width={500} height={240} columns={4} />
          }
        </section>

        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Module Graph</h2>
          {graphNodes.length === 0
            ? <p style={{ color: '#94a3b8' }}>No module graph data.</p>
            : <ModuleGraph nodes={graphNodes} edges={graphEdges} width={500} height={300} />
          }
        </section>
      </div>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Hotspots</h2>
        <DataTable columns={hotspotColumns} rows={hotspots} keyField="file_path" />
      </section>
    </div>
  );
}
