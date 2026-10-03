/**
 * Shape check for the synthesizer's verdict: the existing verdict envelope with
 * `evidence` on every finding.
 *
 * @module review-synth/verdict
 */

const SEVERITIES = ['critical', 'major', 'minor', 'suggestion'];

export function validateStagedVerdict(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const v = value as Record<string, unknown> | null;
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    return { valid: false, errors: ['verdict must be an object'] };
  if (typeof v.approved !== 'boolean') errors.push('approved must be a boolean');
  if (typeof v.summary !== 'string') errors.push('summary must be a string');
  if (typeof v.promptInjectionDetected !== 'boolean')
    errors.push('promptInjectionDetected must be a boolean');
  if (!Array.isArray(v.findings)) {
    errors.push('findings must be an array');
    return { valid: false, errors };
  }
  v.findings.forEach((f: unknown, i: number) => {
    const o = f as Record<string, unknown> | null;
    if (o === null || typeof o !== 'object') {
      errors.push(`findings[${i}] must be an object`);
      return;
    }
    if (typeof o.severity !== 'string' || !SEVERITIES.includes(o.severity))
      errors.push(`findings[${i}].severity is not a known severity`);
    if (typeof o.message !== 'string' || o.message === '')
      errors.push(`findings[${i}].message must be a non-empty string`);
    if (!Array.isArray(o.evidence) || o.evidence.length === 0) {
      errors.push(`findings[${i}].evidence must name at least one probe`);
      return;
    }
    o.evidence.forEach((e: unknown, j: number) => {
      const ref = e as Record<string, unknown> | null;
      if (
        ref === null ||
        typeof ref !== 'object' ||
        typeof ref.probeId !== 'string' ||
        ref.probeId === ''
      )
        errors.push(`findings[${i}].evidence[${j}].probeId must be a string`);
      else if (ref.excerpt !== undefined && typeof ref.excerpt !== 'string')
        errors.push(`findings[${i}].evidence[${j}].excerpt must be a string`);
    });
  });
  return { valid: errors.length === 0, errors };
}
