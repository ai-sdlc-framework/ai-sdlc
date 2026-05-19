/**
 * `init` scaffolding for RFC-0009 §5.1 required-with-defaults pattern.
 *
 * The `triad` object is required on every DID (single-product, Tessellated,
 * and Soul). `initDid` scaffolds a default `triad` block when absent:
 *
 *   - `design.authority`, `engineering.authority`, `product.authority` all
 *     default to `${operator}` (operator wears all three pillars).
 *   - If explicit role overrides are passed in `options.roles`, those
 *     override the operator default for the matching pillar.
 *
 * This is a pure transformation — it does not mutate the input document.
 * Consumers pass the original DID and receive a new DID with the triad
 * scaffolded. Existing `triad` blocks are preserved unchanged (idempotent
 * on repeated init runs).
 *
 * @see RFC-0009 §5.1 — "init scaffolding behavior (single-product DIDs)"
 * @see RFC-0009 §9 — "Migration Path (step 1)"
 */

import type { DesignIntentDocument, Triad } from './types.js';

// ── Options ───────────────────────────────────────────────────────────

export interface RoleOverrides {
  /**
   * Principal for the design vertex. Defaults to `operator` when absent.
   * Maps to `roles.yaml`'s design authority field if present.
   */
  design?: string;
  /**
   * Principal for the engineering vertex. Defaults to `operator` when absent.
   * Maps to `roles.yaml`'s engineering authority field if present.
   */
  engineering?: string;
  /**
   * Principal for the product vertex. Defaults to `operator` when absent.
   * Maps to `roles.yaml`'s product authority field if present.
   */
  product?: string;
}

export interface InitDidOptions {
  /**
   * The operator principal. Used as the default `authority` for all three
   * triad vertices when explicit role overrides are not provided.
   * Defaults to the literal placeholder `'${operator}'` if not supplied —
   * this is intentional: adopters replace it with their actual operator
   * identifier during migration.
   */
  operator?: string;
  /**
   * Explicit role overrides per pillar. When provided, these override the
   * operator default for the matching vertex. Mirrors the project's
   * `roles.yaml` (or equivalent) role declaration.
   */
  roles?: RoleOverrides;
}

// ── Default triad scaffolding ─────────────────────────────────────────

const DEFAULT_OPERATOR_PLACEHOLDER = '${operator}';

/**
 * Build the default triad scaffold for a single-product DID init.
 * All three vertices default to `operator` authority unless `roles` overrides
 * a specific vertex.
 */
export function buildDefaultTriad(options: InitDidOptions = {}): Triad {
  const operator = options.operator ?? DEFAULT_OPERATOR_PLACEHOLDER;
  const roles = options.roles ?? {};

  return {
    design: {
      authority: roles.design ?? operator,
    },
    engineering: {
      authority: roles.engineering ?? operator,
    },
    product: {
      authority: roles.product ?? operator,
    },
  };
}

// ── Main scaffolding function ─────────────────────────────────────────

/**
 * Scaffold or complete the `triad` block on a DesignIntentDocument.
 *
 * Behavior:
 * - If `doc.spec.triad` is already present, returns the document unchanged
 *   (idempotent — safe to re-run on already-migrated DIDs).
 * - If `doc.spec.triad` is absent, adds a default triad block per the
 *   RFC-0009 §5.1 required-with-defaults pattern and returns the new doc.
 *
 * The returned document is a shallow-cloned copy — the input is not mutated.
 *
 * @example
 * // Single-product adopter migration (operator wears all three pillars)
 * const migratedDid = initDid(existingDid, { operator: 'dominique' });
 *
 * @example
 * // Explicit role override when project has distinct pillar authorities
 * const migratedDid = initDid(existingDid, {
 *   operator: 'dominique',
 *   roles: {
 *     design: 'morgan',   // Design Authority
 *     product: 'alex',    // Product Authority
 *   },
 * });
 */
export function initDid(
  doc: DesignIntentDocument,
  options: InitDidOptions = {},
): DesignIntentDocument {
  // Idempotent: preserve existing triad blocks.
  if (doc.spec.triad) {
    return doc;
  }

  return {
    ...doc,
    spec: {
      ...doc.spec,
      triad: buildDefaultTriad(options),
    },
  };
}

/**
 * Scaffold triad blocks on a batch of DIDs.
 * Convenience wrapper over `initDid` for migration scripts that process
 * an entire project's DID set in one pass.
 *
 * @example
 * const migratedDids = initDids(allDids, { operator: 'dominique' });
 */
export function initDids(
  docs: DesignIntentDocument[],
  options: InitDidOptions = {},
): DesignIntentDocument[] {
  return docs.map((doc) => initDid(doc, options));
}
