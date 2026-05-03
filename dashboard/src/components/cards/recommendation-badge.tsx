/**
 * Recommendation badge for the DoR calibration page (AISDLC-162).
 *
 * Color semantics match the operator runbook in
 * `docs/operations/dor-promotion.md`:
 *   - safe-to-enforce  → green  (dispatch AISDLC-115.9)
 *   - continue-soak    → yellow (keep gathering data)
 *   - insufficient-data → gray  (operator may use override path)
 */

export type Recommendation = 'insufficient-data' | 'safe-to-enforce' | 'continue-soak';

interface RecommendationBadgeProps {
  recommendation: Recommendation;
  /** Optional sample count surfaced inline (e.g. "n=42"). */
  n?: number;
}

const STYLES: Record<Recommendation, { bg: string; fg: string; label: string }> = {
  'safe-to-enforce': { bg: '#dcfce7', fg: '#166534', label: 'safe to enforce' },
  'continue-soak': { bg: '#fef9c3', fg: '#854d0e', label: 'continue soak' },
  'insufficient-data': { bg: '#f1f5f9', fg: '#475569', label: 'insufficient data' },
};

export function RecommendationBadge({ recommendation, n }: RecommendationBadgeProps) {
  const { bg, fg, label } = STYLES[recommendation];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        backgroundColor: bg,
        color: fg,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'lowercase',
        letterSpacing: '0.02em',
      }}
    >
      {label}
      {typeof n === 'number' ? ` · n=${n}` : ''}
    </span>
  );
}
