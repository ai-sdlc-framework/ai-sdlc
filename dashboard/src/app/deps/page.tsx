/**
 * Dependency-graph page (AISDLC-167.4 / RFC-0014 Phase 4 §7.2).
 *
 * Renders the latest snapshot artifact alongside the enriched live-graph
 * data: per-task cards with id, title, ppa-equivalent priority,
 * effectivePriority, criticalPathLength, downstream count. The top N
 * (default 5) by `effectivePriority` are highlighted as "🛤️ Critical Path"
 * — the same selection the Slack digest renders, so the two surfaces never
 * drift.
 *
 * Per RFC-0014 §7.2 status color-coding:
 *   - To Do                    → blue   (#2563eb)
 *   - In Progress              → yellow (#ca8a04)
 *   - Needs Clarification      → red    (#dc2626)
 *   - Done                     → green  (#16a34a)
 *
 * Other / unknown statuses fall through to a neutral gray so a typo in the
 * frontmatter doesn't render as an alarm color.
 *
 * Data source defaults to `<cwd>/artifacts` (the conventional local path
 * `cli-deps snapshot` writes to). The operator can point at a different
 * directory via the `DEPS_SNAPSHOT_DIR` env var. See
 * `pipeline-cli/docs/deps.md` for the snapshot artifact contract.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { loadDepsData } from '@/lib/deps-data';
import type { EnrichedSnapshotRecord } from '@ai-sdlc/pipeline-cli/deps';
import { colorForStatus, priorityBucketLabel } from './format';

export default function DepsPage() {
  const data = loadDepsData();

  if (data === null) {
    return (
      <div>
        <Header
          title="Dependency Graph"
          subtitle="RFC-0014 critical-path surfacing — top items by effectivePriority"
        />
        <section
          style={{
            padding: 16,
            border: '1px dashed #cbd5e1',
            borderRadius: 8,
            color: '#475569',
            fontSize: 14,
          }}
        >
          <p style={{ margin: 0, marginBottom: 8 }}>
            <strong>No dependency snapshot found.</strong>
          </p>
          <p style={{ margin: 0, marginBottom: 8 }}>
            Set <code>DEPS_SNAPSHOT_DIR</code> to a directory containing one or more{' '}
            <code>_deps/snapshot.&lt;iso&gt;.&lt;tag&gt;.jsonl</code> files (see{' '}
            <a href="https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/deps.md">
              <code>pipeline-cli/docs/deps.md</code>
            </a>
            ), or run the local pipeline so <code>artifacts/_deps/snapshot.*.jsonl</code> exists.
          </p>
          <p style={{ margin: 0 }}>
            To populate one now: <code>AI_SDLC_DEPS_COMPOSITION=1 cli-deps snapshot</code>.
          </p>
        </section>
      </div>
    );
  }

  const {
    artifactsRoot,
    snapshotPath,
    snapshotIsoTimestamp,
    snapshotTag,
    totalRecords,
    skipped,
    enriched,
    criticalPath,
  } = data;

  // Build a Set of IDs in the critical path so we can highlight them in the
  // wide list cheaply (O(1) per row instead of an Array.includes scan).
  const criticalPathIds = new Set(criticalPath.map((r) => r.id));

  // Aggregate the dangling-edge warnings across all rows so the operator can
  // see whether the snapshot is stale (per AC #5 — surface dangling rather
  // than crash).
  const totalWarnings = enriched.reduce((n, r) => n + r.warnings.length, 0);

  return (
    <div>
      <Header
        title="Dependency Graph"
        subtitle="RFC-0014 critical-path surfacing — top items by effectivePriority"
      />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Total tasks" value={totalRecords} />
        <StatCard label="Critical path" value={criticalPath.length} />
        <StatCard label="Snapshot tag" value={snapshotTag} />
        <StatCard label="Snapshot ts" value={snapshotIsoTimestamp.slice(0, 10)} />
        {skipped > 0 ? <StatCard label="Skipped lines" value={skipped} color="#dc2626" /> : null}
        {totalWarnings > 0 ? (
          <StatCard label="Dangling warnings" value={totalWarnings} color="#ca8a04" />
        ) : null}
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>
          🛤️ Critical Path (top {criticalPath.length})
        </h2>
        {criticalPath.length === 0 ? (
          <div
            style={{
              padding: 16,
              border: '1px dashed #cbd5e1',
              borderRadius: 8,
              color: '#475569',
              fontSize: 13,
            }}
          >
            <em>
              No qualifying critical-path items in this snapshot — the graph may be flat (all
              isolated leaves) or every chain is already complete.
            </em>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            {criticalPath.map((item, i) => (
              <CriticalPathCard key={item.id} item={item} rank={i + 1} highlighted />
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
          Source: <code>{snapshotPath}</code>
        </p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>All tasks ({enriched.length})</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>ID</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Title</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Status</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Priority</th>
              <th style={{ textAlign: 'right', padding: 8 }}>EffPri</th>
              <th style={{ textAlign: 'right', padding: 8 }}>CPL</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Downstream</th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                  Snapshot is empty — no tasks to render.
                </td>
              </tr>
            ) : (
              enriched.map((row) => {
                const onCriticalPath = criticalPathIds.has(row.id);
                const statusColor = colorForStatus(row.status);
                return (
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: '1px solid #f1f5f9',
                      backgroundColor: onCriticalPath ? '#fef3c7' : 'transparent',
                    }}
                  >
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>
                      {row.filePath ? (
                        <a
                          href={`file://${row.filePath}`}
                          style={{ color: '#0f172a', textDecoration: 'none' }}
                        >
                          {row.id}
                        </a>
                      ) : (
                        row.id
                      )}
                    </td>
                    <td style={{ padding: 8 }}>{row.title || <em>(missing)</em>}</td>
                    <td style={{ padding: 8 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          backgroundColor: statusColor,
                          marginRight: 6,
                          verticalAlign: 'middle',
                        }}
                      />
                      {row.status || '(unknown)'}
                    </td>
                    <td style={{ textAlign: 'right', padding: 8 }}>
                      {priorityBucketLabel(row.basePriority)}
                    </td>
                    <td style={{ textAlign: 'right', padding: 8, fontWeight: 600 }}>
                      {row.effectivePriority}
                    </td>
                    <td style={{ textAlign: 'right', padding: 8 }}>{row.criticalPathLength}</td>
                    <td style={{ textAlign: 'right', padding: 8 }}>{row.dependentCount}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 8 }}>
          Source: <code>{artifactsRoot}</code>
        </p>
      </section>

      {totalWarnings > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <details>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
                color: '#ca8a04',
              }}
            >
              Dangling-edge warnings ({totalWarnings})
            </summary>
            <ul style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>
              {enriched
                .flatMap((r) => r.warnings.map((w) => ({ id: r.id, w })))
                .map((entry, idx) => (
                  <li key={`${entry.id}-${idx}`} style={{ fontFamily: 'monospace' }}>
                    {entry.w}
                  </li>
                ))}
            </ul>
          </details>
        </section>
      ) : null}
    </div>
  );
}

interface CriticalPathCardProps {
  item: EnrichedSnapshotRecord;
  rank: number;
  highlighted: boolean;
}

/**
 * Per-task card for the highlighted critical-path section. Renders the same
 * pieces of data the Slack digest's `formatCriticalPathEntry` does, but with
 * the dashboard's richer layout (status color dot, priority bucket label,
 * source-file link).
 */
function CriticalPathCard({ item, rank, highlighted }: CriticalPathCardProps) {
  const statusColor = colorForStatus(item.status);
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: '1px solid #e2e8f0',
        backgroundColor: highlighted ? '#fef3c7' : '#ffffff',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: '#0f172a',
          minWidth: 24,
          textAlign: 'center',
        }}
      >
        {rank}.
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
          {item.filePath ? (
            <a
              href={`file://${item.filePath}`}
              style={{ color: '#0f172a', textDecoration: 'none' }}
            >
              {item.id}
            </a>
          ) : (
            item.id
          )}{' '}
          — <span style={{ fontWeight: 400 }}>{item.title || <em>(no title)</em>}</span>
        </div>
        <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
          chain length: <strong>{item.criticalPathLength}</strong> · gates:{' '}
          <strong>{item.dependentCount} downstream</strong> · effective priority:{' '}
          <strong>{item.effectivePriority}</strong> ({priorityBucketLabel(item.basePriority)} base)
        </div>
      </div>
      <span
        title={item.status || '(unknown)'}
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          backgroundColor: statusColor,
        }}
      />
    </div>
  );
}
