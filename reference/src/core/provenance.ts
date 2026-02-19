/**
 * Provenance tracking from PRD Section 14.3.
 *
 * 6 required fields: model, tool, promptHash, timestamp,
 * humanReviewer, reviewDecision.
 *
 * Optional cost field added by RFC-0004 for cost attribution.
 *
 * Provenance is stored as metadata.annotations using
 * `ai-sdlc.io/provenance-*` keys for round-trip serialization.
 */

import type { CostReceipt } from './types.js';

export type ReviewDecision = 'approved' | 'rejected' | 'pending' | 'not-required';

export interface ProvenanceRecord {
  model: string;
  tool: string;
  promptHash: string;
  timestamp: string;
  humanReviewer?: string;
  reviewDecision: ReviewDecision;
  cost?: CostReceipt;
}

export const PROVENANCE_ANNOTATION_PREFIX = 'ai-sdlc.io/provenance-';

const _PROVENANCE_FIELDS = [
  'model',
  'tool',
  'promptHash',
  'timestamp',
  'humanReviewer',
  'reviewDecision',
] as const;

/**
 * Create a provenance record with defaults for optional fields.
 */
export function createProvenance(
  partial: Omit<ProvenanceRecord, 'timestamp' | 'reviewDecision'> & {
    timestamp?: string;
    reviewDecision?: ReviewDecision;
  },
): ProvenanceRecord {
  return {
    model: partial.model,
    tool: partial.tool,
    promptHash: partial.promptHash,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    humanReviewer: partial.humanReviewer,
    reviewDecision: partial.reviewDecision ?? 'pending',
    cost: partial.cost,
  };
}

/**
 * Serialize a provenance record to annotation key-value pairs.
 */
export function provenanceToAnnotations(provenance: ProvenanceRecord): Record<string, string> {
  const annotations: Record<string, string> = {};
  annotations[`${PROVENANCE_ANNOTATION_PREFIX}model`] = provenance.model;
  annotations[`${PROVENANCE_ANNOTATION_PREFIX}tool`] = provenance.tool;
  annotations[`${PROVENANCE_ANNOTATION_PREFIX}promptHash`] = provenance.promptHash;
  annotations[`${PROVENANCE_ANNOTATION_PREFIX}timestamp`] = provenance.timestamp;
  annotations[`${PROVENANCE_ANNOTATION_PREFIX}reviewDecision`] = provenance.reviewDecision;
  if (provenance.humanReviewer) {
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}humanReviewer`] = provenance.humanReviewer;
  }
  if (provenance.cost) {
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-total`] = String(provenance.cost.totalCost);
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-currency`] = provenance.cost.currency;
    if (provenance.cost.execution) {
      annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-input-tokens`] = String(provenance.cost.execution.inputTokens);
      annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-output-tokens`] = String(provenance.cost.execution.outputTokens);
      if (provenance.cost.execution.cacheReadTokens != null) {
        annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-cache-read-tokens`] = String(provenance.cost.execution.cacheReadTokens);
      }
    }
  }
  return annotations;
}

/**
 * Deserialize a provenance record from annotation key-value pairs.
 * Returns undefined if required fields are missing.
 */
export function provenanceFromAnnotations(
  annotations: Record<string, string>,
): ProvenanceRecord | undefined {
  const get = (field: string): string | undefined =>
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}${field}`];

  const model = get('model');
  const tool = get('tool');
  const promptHash = get('promptHash');
  const timestamp = get('timestamp');
  const reviewDecision = get('reviewDecision') as ReviewDecision | undefined;

  if (!model || !tool || !promptHash || !timestamp || !reviewDecision) {
    return undefined;
  }

  // Deserialize cost receipt if present
  let cost: CostReceipt | undefined;
  const costTotal = get('cost-total');
  if (costTotal) {
    const inputTokens = get('cost-input-tokens');
    const outputTokens = get('cost-output-tokens');
    const cacheReadTokens = get('cost-cache-read-tokens');
    cost = {
      totalCost: parseFloat(costTotal),
      currency: get('cost-currency') ?? 'USD',
      breakdown: { tokenCost: parseFloat(costTotal) },
      execution: inputTokens ? {
        inputTokens: parseInt(inputTokens, 10),
        outputTokens: parseInt(outputTokens ?? '0', 10),
        cacheReadTokens: cacheReadTokens ? parseInt(cacheReadTokens, 10) : undefined,
      } : undefined,
    };
  }

  return {
    model,
    tool,
    promptHash,
    timestamp,
    humanReviewer: get('humanReviewer'),
    reviewDecision,
    cost,
  };
}

/**
 * Validate that a provenance record has all required fields.
 */
export function validateProvenance(provenance: Partial<ProvenanceRecord>): {
  valid: boolean;
  missing: string[];
} {
  const required: (keyof ProvenanceRecord)[] = [
    'model',
    'tool',
    'promptHash',
    'timestamp',
    'reviewDecision',
  ];
  const missing = required.filter((f) => !provenance[f]);
  return { valid: missing.length === 0, missing };
}
