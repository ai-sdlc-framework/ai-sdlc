/**
 * Shared comparison utilities used across policy modules.
 */

/**
 * Compare a numeric value against a threshold using the given operator.
 */
export function compareMetric(actual: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>=':
      return actual >= threshold;
    case '<=':
      return actual <= threshold;
    case '==':
      return actual === threshold;
    case '!=':
      return actual !== threshold;
    case '>':
      return actual > threshold;
    case '<':
      return actual < threshold;
    default:
      return false;
  }
}

/** Severity ordering for tool-rule evaluation. */
const SEVERITY_ORDER: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Return true if `actual` severity exceeds `max` severity.
 */
export function exceedsSeverity(
  actual: 'low' | 'medium' | 'high' | 'critical',
  max: 'low' | 'medium' | 'high' | 'critical',
): boolean {
  return SEVERITY_ORDER[actual] > SEVERITY_ORDER[max];
}
