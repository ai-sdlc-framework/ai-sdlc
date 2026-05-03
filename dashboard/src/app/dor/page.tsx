/**
 * DoR calibration page (AISDLC-162) — closes AISDLC-115 AC #5
 * "DoR calibration log feeds metrics dashboard."
 *
 * Reads the corpus of `_dor/calibration.jsonl` files via
 * `loadDorData()` (which wraps the AISDLC-161 `cli-dor-corpus`
 * aggregator) and renders:
 *
 *   - Aggregate recommendation badge (safe-to-enforce / continue-soak /
 *     insufficient-data) — drives the AISDLC-115.9 promotion decision
 *   - Per-gate breakdown table (gate id, n, overrides, FP rate)
 *   - Last-N raw entries for operator spot-checking (collapsed `<details>`
 *     so the page stays scannable when the corpus is large)
 *
 * Data source defaults to `<cwd>/artifacts/_dor` (the conventional
 * local calibration log path); the operator can point at a different
 * directory via the `DOR_CORPUS_DIR` env var (e.g. a `gh run download`
 * output of `dor-calibration-*` workflow artifacts). See
 * `docs/operations/dor-promotion.md`.
 */

export const dynamic = 'force-dynamic';

import { Header } from '@/components/layout/header';
import { StatCard } from '@/components/cards/stat-card';
import { RecommendationBadge, type Recommendation } from '@/components/cards/recommendation-badge';
import { loadDorData } from '@/lib/dor-data';

export default function DorPage() {
  const data = loadDorData();

  if (data === null) {
    return (
      <div>
        <Header
          title="DoR Calibration"
          subtitle="Definition-of-Ready false-positive rate + promotion readiness"
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
            <strong>No DoR calibration corpus found.</strong>
          </p>
          <p style={{ margin: 0 }}>
            Set <code>DOR_CORPUS_DIR</code> to a directory containing one or more{' '}
            <code>calibration.jsonl</code> files (see{' '}
            <a href="https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/dor-promotion.md">
              <code>docs/operations/dor-promotion.md</code>
            </a>{' '}
            for the <code>gh run download</code> recipe), or run the local pipeline so{' '}
            <code>artifacts/_dor/calibration.jsonl</code> exists.
          </p>
        </section>
      </div>
    );
  }

  const { corpusRoot, report, recentEntries } = data;
  const a = report.aggregate;
  const recommendation = a.recommendation as Recommendation;

  const recommendationColor =
    recommendation === 'safe-to-enforce'
      ? '#16a34a'
      : recommendation === 'continue-soak'
        ? '#d97706'
        : '#64748b';

  return (
    <div>
      <Header
        title="DoR Calibration"
        subtitle="Definition-of-Ready false-positive rate + promotion readiness"
      />

      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <StatCard label="Recommendation" value={recommendation} color={recommendationColor} />
        <StatCard label="Corpus N" value={a.n} />
        <StatCard label="Files Read" value={a.filesRead} />
        <StatCard label="Mean FP Rate" value={`${(a.meanFpRate * 100).toFixed(1)}%`} />
        <StatCard label="Override Rate" value={`${(a.overrideRate * 100).toFixed(1)}%`} />
        <StatCard label="Skipped" value={a.skipped} />
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Aggregate</h2>
        <div
          style={{
            padding: 16,
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <RecommendationBadge recommendation={recommendation} n={a.n} />
          <div style={{ fontSize: 13, color: '#475569' }}>{a.reason}</div>
          {a.worstGate && (
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              worst gate: gate-{a.worstGate.gate} ({(a.worstGate.fpRate * 100).toFixed(1)}%)
            </div>
          )}
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
          Source: <code>{corpusRoot}</code>
        </p>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Per-gate breakdown</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Gate</th>
              <th style={{ textAlign: 'right', padding: 8 }}>N</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Overrides</th>
              <th style={{ textAlign: 'right', padding: 8 }}>FP Rate</th>
              <th style={{ textAlign: 'right', padding: 8 }}>Override Rate</th>
            </tr>
          </thead>
          <tbody>
            {report.perGate.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                  No gates have fired yet — every entry passed Stage A cleanly.
                </td>
              </tr>
            ) : (
              report.perGate.map((g) => {
                const fpColor = g.fpRate >= 0.1 ? '#dc2626' : '#0f172a';
                return (
                  <tr key={g.gate} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: 8 }}>gate-{g.gate}</td>
                    <td style={{ textAlign: 'right', padding: 8 }}>{g.n}</td>
                    <td style={{ textAlign: 'right', padding: 8 }}>{g.overrides}</td>
                    <td style={{ textAlign: 'right', padding: 8, color: fpColor }}>
                      {(g.fpRate * 100).toFixed(1)}%
                    </td>
                    <td style={{ textAlign: 'right', padding: 8 }}>
                      {(g.overrideRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <section>
        <details>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 12,
              color: '#0f172a',
            }}
          >
            Recent entries ({recentEntries.length})
          </summary>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
              marginTop: 12,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ textAlign: 'left', padding: 6 }}>Timestamp</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Issue</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Verdict</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Outcome</th>
                <th style={{ textAlign: 'left', padding: 6 }}>Failed Gates</th>
              </tr>
            </thead>
            <tbody>
              {recentEntries.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                    No calibration entries yet.
                  </td>
                </tr>
              ) : (
                recentEntries.map((e, idx) => (
                  <tr
                    key={`${e.ts}-${e.issueId}-${idx}`}
                    style={{ borderBottom: '1px solid #f1f5f9' }}
                  >
                    <td style={{ padding: 6, fontFamily: 'monospace' }}>{e.ts}</td>
                    <td style={{ padding: 6 }}>{e.issueId}</td>
                    <td style={{ padding: 6 }}>{e.overallVerdict}</td>
                    <td style={{ padding: 6 }}>{e.outcome || '(live)'}</td>
                    <td style={{ padding: 6, fontFamily: 'monospace' }}>
                      {e.failedGates.length === 0 ? '—' : e.failedGates.join(', ')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </details>
      </section>
    </div>
  );
}
