/**
 * Provenance tracking module — creates, validates, and serializes
 * provenance records for AI-generated changes (PRD Section 14.3).
 */

import {
  createProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  validateProvenance,
  PROVENANCE_ANNOTATION_PREFIX,
  type ProvenanceRecord,
  type ReviewDecision,
} from '@ai-sdlc/reference';
import { createHash } from 'node:crypto';

/**
 * Create a provenance record for a pipeline execution.
 */
export function createPipelineProvenance(opts: {
  model?: string;
  tool?: string;
  promptText?: string;
  humanReviewer?: string;
}): ProvenanceRecord {
  const promptHash = opts.promptText
    ? createHash('sha256').update(opts.promptText).digest('hex').slice(0, 16)
    : 'no-prompt';

  return createProvenance({
    model: opts.model ?? 'claude-opus-4-6',
    tool: opts.tool ?? 'claude-code',
    promptHash,
    humanReviewer: opts.humanReviewer,
  });
}

/**
 * Generate a provenance block for inclusion in PR descriptions.
 */
export function attachProvenanceToPR(provenance: ProvenanceRecord): string {
  const annotations = provenanceToAnnotations(provenance);
  const lines = [
    '## Provenance',
    '',
    `- **Model**: ${provenance.model}`,
    `- **Tool**: ${provenance.tool}`,
    `- **Prompt Hash**: \`${provenance.promptHash}\``,
    `- **Timestamp**: ${provenance.timestamp}`,
    `- **Review Status**: ${provenance.reviewDecision}`,
  ];

  if (provenance.humanReviewer) {
    lines.push(`- **Reviewer**: ${provenance.humanReviewer}`);
  }

  lines.push('', '<!-- provenance-annotations');
  for (const [key, value] of Object.entries(annotations)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('-->');

  return lines.join('\n');
}

/**
 * Validate a provenance record for completeness.
 */
export function validatePipelineProvenance(provenance: Partial<ProvenanceRecord>): {
  valid: boolean;
  missing: string[];
} {
  return validateProvenance(provenance);
}

export { provenanceToAnnotations, provenanceFromAnnotations, PROVENANCE_ANNOTATION_PREFIX };
export type { ProvenanceRecord, ReviewDecision };
