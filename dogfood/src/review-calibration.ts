/**
 * Review calibration context assembly.
 *
 * Loads review policy, principles, and exemplars from .ai-sdlc/
 * and assembles them into a single calibration string for review agents.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load and assemble review calibration context from .ai-sdlc/ config files.
 * Returns the combined policy + principles + exemplars, or undefined if none exist.
 */
export function loadReviewCalibration(configDir: string): string | undefined {
  const parts: string[] = [];

  const policyPath = join(configDir, 'review-policy.md');
  if (existsSync(policyPath)) {
    parts.push(readFileSync(policyPath, 'utf-8'));
  }

  const principlesPath = join(configDir, 'review-principles.md');
  if (existsSync(principlesPath)) {
    parts.push(readFileSync(principlesPath, 'utf-8'));
  }

  const exemplarsPath = join(configDir, 'review-exemplars.yaml');
  if (existsSync(exemplarsPath)) {
    parts.push(
      '## Review Exemplars (labeled examples)\n\n```yaml\n' +
        readFileSync(exemplarsPath, 'utf-8') +
        '\n```',
    );
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}
