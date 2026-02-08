/**
 * Provenance tracking from PRD Section 14.3.
 *
 * 6 required fields: model, tool, promptHash, timestamp,
 * humanReviewer, reviewDecision.
 *
 * Provenance is stored as metadata.annotations using
 * `ai-sdlc.io/provenance-*` keys for round-trip serialization.
 */

export type ReviewDecision = 'approved' | 'rejected' | 'pending' | 'not-required';

export interface ProvenanceRecord {
  model: string;
  tool: string;
  promptHash: string;
  timestamp: string;
  humanReviewer?: string;
  reviewDecision: ReviewDecision;
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

  return {
    model,
    tool,
    promptHash,
    timestamp,
    humanReviewer: get('humanReviewer'),
    reviewDecision,
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
