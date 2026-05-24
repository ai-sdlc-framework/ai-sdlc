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
  /**
   * Soul DID URIs this work targeted, per RFC-0009 §8.3. Closes the
   * per-soul Cκ calibration loop: outcomes can be attributed to the
   * correct soul's calibration cells. Omission = platform-wide (no
   * specific souls targeted; existing behavior preserved).
   */
  targetedSouls?: string[];
  /**
   * True when the work is substrate-scoped (cross-soul / platform
   * substrate work) rather than targeting one or more specific souls.
   * May coexist with `targetedSouls` when substrate work transitively
   * affects specific downstream souls (mixed-scope).
   */
  substrateScoped?: boolean;
  /**
   * URI of the parent Tessellated DID this provenance record belongs to
   * (e.g., `did:platform-x:platform`). Provides cross-reference up the
   * fractal hierarchy for cross-soul provenance audits (RFC-0009 §7.2
   * detection rule #3, §8.3).
   */
  tessellatedSoulRef?: string;
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
    targetedSouls: partial.targetedSouls,
    substrateScoped: partial.substrateScoped,
    tessellatedSoulRef: partial.tessellatedSoulRef,
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
      annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-input-tokens`] = String(
        provenance.cost.execution.inputTokens,
      );
      annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-output-tokens`] = String(
        provenance.cost.execution.outputTokens,
      );
      if (provenance.cost.execution.cacheReadTokens != null) {
        annotations[`${PROVENANCE_ANNOTATION_PREFIX}cost-cache-read-tokens`] = String(
          provenance.cost.execution.cacheReadTokens,
        );
      }
    }
  }
  // RFC-0009 §8.3 soul-scoping fields. Annotation values are strings, so
  // array + boolean fields are encoded as JSON for round-trip safety.
  if (provenance.targetedSouls && provenance.targetedSouls.length > 0) {
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}targetedSouls`] = JSON.stringify(
      provenance.targetedSouls,
    );
  }
  if (provenance.substrateScoped != null) {
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}substrateScoped`] = String(
      provenance.substrateScoped,
    );
  }
  if (provenance.tessellatedSoulRef) {
    annotations[`${PROVENANCE_ANNOTATION_PREFIX}tessellatedSoulRef`] =
      provenance.tessellatedSoulRef;
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
      execution: inputTokens
        ? {
            inputTokens: parseInt(inputTokens, 10),
            outputTokens: parseInt(outputTokens ?? '0', 10),
            cacheReadTokens: cacheReadTokens ? parseInt(cacheReadTokens, 10) : undefined,
          }
        : undefined,
    };
  }

  // RFC-0009 §8.3 soul-scoping fields. Parse defensively — malformed
  // JSON for `targetedSouls` is treated as absent rather than throwing.
  let targetedSouls: string[] | undefined;
  const targetedSoulsRaw = get('targetedSouls');
  if (targetedSoulsRaw) {
    try {
      const parsed = JSON.parse(targetedSoulsRaw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        targetedSouls = parsed;
      }
    } catch {
      // ignore malformed annotation; treat as absent
    }
  }

  let substrateScoped: boolean | undefined;
  const substrateScopedRaw = get('substrateScoped');
  if (substrateScopedRaw === 'true') {
    substrateScoped = true;
  } else if (substrateScopedRaw === 'false') {
    substrateScoped = false;
  }

  const tessellatedSoulRef = get('tessellatedSoulRef');

  return {
    model,
    tool,
    promptHash,
    timestamp,
    humanReviewer: get('humanReviewer'),
    reviewDecision,
    cost,
    targetedSouls,
    substrateScoped,
    tessellatedSoulRef,
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
