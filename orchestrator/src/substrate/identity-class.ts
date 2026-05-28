/**
 * Canonical `identityClass` taxonomy for Substrate Contract fields.
 *
 * Phase 1 of RFC-0028 §7.1 v0.2 resolution. Defines the framework-level
 * taxonomy `core | evolving` together with bucket assignments, a novel-field
 * default helper (conservative `core`), and the type-level tightening-only
 * primitives used by Substrate Contract authors.
 *
 * Harmonizes with the already-shipped `'core' | 'evolving'` discriminant in
 * `orchestrator/src/sa-scoring/layer1-deterministic.ts` — see
 * {@link auditLayer1DeterministicClassifications} for the cross-check and
 * {@link IdentityClassDiscrepancy} for the discrepancy shape filed against the
 * Decision Catalog.
 *
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md §6, §7.1
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Canonical taxonomy enum ──────────────────────────────────────────

/**
 * The canonical two-bucket taxonomy. Soul-DID-level identity vs operational
 * tuning surface. Wider RFC-0028 §7.1 rationale: `core` changes are Soul
 * pivots (full re-scoring fires); `evolving` changes are normal evolution
 * (admission-queue re-scoring only).
 */
export type IdentityClass = 'core' | 'evolving';

/** Runtime-enumerable list of every taxonomy bucket. */
export const IDENTITY_CLASSES: readonly IdentityClass[] = ['core', 'evolving'] as const;

// ── Bucket assignments (canonical taxonomy, RFC-0028 §7.1) ───────────

/**
 * Substrate Contract field names that are CANONICAL `core` per RFC-0028 §7.1.
 *
 * Child Soul DIDs CANNOT loosen any value declared on these fields. A pivot
 * rescoring fires whenever any of these fields change.
 */
export const CORE_BUCKET = {
  /** Categorical compliance locks — `boolean` locks typed as `true` literal when locked. */
  categoricalComplianceLocks: [
    'requiresTenantPhysicalIsolation',
    'requiresVulnerableAudienceLockout',
  ],
  /** Compliance regime declarations — categorical, tightening-only. */
  complianceRegimeDeclarations: ['HIPAA', 'PCI-DSS', 'SOC2', 'FedRAMP', 'GDPR'],
  /** Director / orchestrator agent identifier — changing the director IS a Soul-level event. */
  directorIdentifiers: ['director', 'orchestratorAgentId'],
  /** §6 tightening-only `complianceFloor: inherit` lock. */
  complianceFloorLock: ['complianceFloor'],
} as const;

/**
 * Substrate Contract field names that are CANONICAL `evolving` per RFC-0028 §7.1.
 *
 * Free movement within tightening-only bounds (a `cadence` may shorten but
 * not lengthen past the parent; a similarity threshold may tighten but not
 * loosen). Admission-queue rescoring only — no Soul pivot.
 */
export const EVOLVING_BUCKET = {
  /** Operational cadence — observer cooldown / cadence minimum interval. */
  operationalCadence: ['observerCooldownMs', 'cadenceMinIntervalDays'],
  /** Scoring tuning weights — bid diversity weight, recency half-life. */
  scoringTuningWeights: ['bidDiversityWeight', 'recencyHalfLife'],
  /** Similarity thresholds — `clustering.similarityThreshold`. */
  similarityThresholds: ['clustering.similarityThreshold'],
  /** Quota quantities — `tenantQuotaShare`. */
  quotaQuantities: ['tenantQuotaShare'],
} as const;

/**
 * Reverse-lookup table: field name → canonical `IdentityClass`.
 * Built from {@link CORE_BUCKET} + {@link EVOLVING_BUCKET}. Fields not listed
 * here are NOVEL and resolve via {@link defaultIdentityClassForNovelField}.
 */
export const CANONICAL_FIELD_CLASSIFICATIONS: Readonly<Record<string, IdentityClass>> =
  Object.freeze({
    ...Object.fromEntries(
      Object.values(CORE_BUCKET)
        .flat()
        .map((name) => [name, 'core' as const]),
    ),
    ...Object.fromEntries(
      Object.values(EVOLVING_BUCKET)
        .flat()
        .map((name) => [name, 'evolving' as const]),
    ),
  });

// ── Novel-field default ──────────────────────────────────────────────

/** Optional warning hook invoked when {@link defaultIdentityClassForNovelField} fires. */
export type NovelFieldWarningHook = (fieldName: string, defaultedTo: IdentityClass) => void;

/**
 * Resolve the canonical `IdentityClass` for a Substrate Contract field.
 *
 * - Listed in {@link CANONICAL_FIELD_CLASSIFICATIONS} → returns that bucket.
 * - Otherwise NOVEL → returns `'core'` (per RFC-0028 §7.1 v0.2 conservative
 *   default; promotion to `evolving` needs an RFC amendment with Design +
 *   Engineering sign-off — burden-of-proof is "argue why operational").
 *
 * When defaulting fires AND a `warn` hook is supplied, the hook is invoked
 * synchronously so contract authors get a visible signal that a field has
 * not yet been classified canonically.
 */
export function defaultIdentityClassForNovelField(
  fieldName: string,
  options: { warn?: NovelFieldWarningHook } = {},
): IdentityClass {
  // Use Object.prototype.hasOwnProperty.call to prevent prototype-pollution
  // lookups — without this guard a field named `toString` or `constructor`
  // would resolve to inherited Object prototype values (a function typed as
  // IdentityClass) instead of defaulting to 'core'.
  const canonical = Object.prototype.hasOwnProperty.call(CANONICAL_FIELD_CLASSIFICATIONS, fieldName)
    ? CANONICAL_FIELD_CLASSIFICATIONS[fieldName]
    : undefined;
  if (canonical !== undefined) return canonical;
  const defaulted: IdentityClass = 'core';
  options.warn?.(fieldName, defaulted);
  return defaulted;
}

// ── Tightening-only enforcement primitives (type system) ─────────────

/**
 * A boolean compliance lock that is LOCKED. Typed as the `true` literal so
 * any attempt to assign `false` (loosening) fails at compile time.
 *
 * @example
 * ```ts
 * const lock: LockedBoolean = true; // ok
 * const lock: LockedBoolean = false; // type error
 * ```
 */
export type LockedBoolean = true;

/**
 * A numeric cap that may only DECREASE. The discriminant `kind` field
 * narrows the union; consumers may attempt to inherit + tighten by passing a
 * smaller `max` value. The child-tightens-parent constraint is enforced via
 * the {@link assertTightenedCap} helper at authoring time.
 *
 * Implementation note: TypeScript's structural type system cannot enforce
 * "must be ≤ parent" at the type-level for arbitrary numeric values (that
 * requires dependent types). The bounded discriminated union ensures
 * authors must DECLARE intent (`tightened` vs `inherited`); the assertion
 * helper catches loosening at runtime/authoring time.
 */
export type BoundedNumericCap =
  | { kind: 'inherited'; max: number }
  | { kind: 'tightened'; max: number; previousMax: number };

/** Run-time assertion that a {@link BoundedNumericCap} tightening is valid. */
export function assertTightenedCap(cap: BoundedNumericCap): void {
  if (cap.kind === 'tightened' && cap.max > cap.previousMax) {
    throw new IdentityClassError(
      `Tightening-only violation: max=${cap.max} > previousMax=${cap.previousMax}`,
    );
  }
}

/**
 * Categorical inheritance via TypeScript template-literal types. The child
 * Soul DID's value MUST be a string that is provably a subset of the parent
 * (encoded as a literal-string union). At the type system level, any value
 * outside that union fails compile-time inference.
 *
 * @example
 * ```ts
 * type ParentRegime = 'HIPAA' | 'PCI-DSS' | 'SOC2' | 'FedRAMP' | 'GDPR';
 * type ChildRegime = TightenedCategorical<ParentRegime, 'HIPAA' | 'SOC2'>;
 * // ChildRegime = 'HIPAA' | 'SOC2' — strictly tightened subset
 * ```
 */
export type TightenedCategorical<Parent extends string, Child extends Parent> = Child;

// ── Audit: shipped-code classifications cross-check ──────────────────

/**
 * A single shipped-code identityClass usage that disagrees with the
 * canonical taxonomy. Surfaced via {@link auditLayer1DeterministicClassifications}.
 */
export interface IdentityClassDiscrepancy {
  /** Source file (repo-relative path). */
  file: string;
  /** Symbol or call-site label (e.g. function or interface name + line context). */
  symbol: string;
  /** Field / discriminant the classification applies to. */
  field: string;
  /** Value observed in the shipped code. */
  observed: IdentityClass;
  /** Value the canonical taxonomy prescribes. */
  canonical: IdentityClass;
  /** Operator-facing rationale describing why this is flagged. */
  rationale: string;
}

/**
 * Audit the shipped `orchestrator/src/sa-scoring/layer1-deterministic.ts`
 * (and its compiler `did-compiler.ts`) identityClass classifications against
 * the canonical RFC-0028 §7.1 taxonomy.
 *
 * RFC-0028 §7.1 canonical taxonomy classifies *Substrate Contract* fields.
 * `layer1-deterministic.ts` applies the same `'core' | 'evolving'`
 * discriminant to *DID scoring entries* (scope-gate terms, constraint rules,
 * anti-patterns, measurable signals). The discriminant is reused across two
 * layers; the taxonomy was only formally defined for the substrate layer.
 *
 * The defensible cross-layer discrepancy is the **default fallback**: the
 * shipped `ic()` helper in `did-compiler.ts` returns `'evolving'` for fields
 * with no explicit classification, but the canonical taxonomy says novel
 * fields default to `'core'`. This is filed as a Decision rather than
 * inline-resolved because the DID-scoring domain may legitimately prefer
 * a different default than the substrate-contract domain — operator
 * routing required.
 *
 * Returns the list of discrepancies (may be empty). Callers are responsible
 * for piping each into `cli-decisions add --scope ... --option ...`.
 */
export function auditLayer1DeterministicClassifications(
  options: { readFile?: (path: string) => string } = {},
): IdentityClassDiscrepancy[] {
  const readFile = options.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));

  // Resolve sibling paths relative to THIS module's location, not cwd —
  // tests run from the package dir, dogfood callers run from the repo root;
  // both must find the shipped source files.
  const here = dirname(fileURLToPath(import.meta.url));
  const saScoringDir = join(here, '..', 'sa-scoring');

  const filesToAudit: Array<{ file: string; absolutePath: string }> = [
    {
      file: 'orchestrator/src/sa-scoring/did-compiler.ts',
      absolutePath: join(saScoringDir, 'did-compiler.ts'),
    },
    {
      file: 'orchestrator/src/sa-scoring/layer1-deterministic.ts',
      absolutePath: join(saScoringDir, 'layer1-deterministic.ts'),
    },
  ];

  const discrepancies: IdentityClassDiscrepancy[] = [];

  for (const { file, absolutePath } of filesToAudit) {
    let source: string;
    try {
      source = readFile(absolutePath);
    } catch {
      // File missing from the working tree — skip, do not throw. The audit
      // is best-effort; absent source is itself surfaced via the empty result
      // and the test suite ensures the canonical path exists.
      continue;
    }

    const lines = source.split('\n');
    lines.forEach((line, idx) => {
      const lineNumber = idx + 1;

      // Pattern 1: `?? 'evolving'` or `?? "evolving"` — explicit default
      // fallback to evolving. Canonical taxonomy says novel fields default
      // to core, so any such fallback IS a discrepancy.
      const defaultMatch = /\?\?\s*['"](evolving|core)['"]/.exec(line);
      if (defaultMatch) {
        const observed = defaultMatch[1] as IdentityClass;
        if (observed !== 'core') {
          discrepancies.push({
            file,
            symbol: `line ${lineNumber} default fallback`,
            field: 'identityClass (novel default)',
            observed,
            canonical: 'core',
            rationale:
              `${file}:${lineNumber} defaults missing identityClass to '${observed}' via \`?? '${observed}'\`. ` +
              `Canonical RFC-0028 §7.1 taxonomy specifies novel fields default to 'core' (conservative; ` +
              `promotion to evolving requires RFC amendment). The DID-scoring domain may legitimately ` +
              `defend a different default — operator decision required to (a) align to canonical 'core', ` +
              `(b) carve a documented cross-layer exemption, or (c) revise the canonical taxonomy.`,
          });
        }
      }

      // Pattern 2 (explicit `identityClass: 'evolving'` literal flagging)
      // was REMOVED — it produced false positives for legitimate
      // canonical-evolving fields (`observerCooldownMs`,
      // `cadenceMinIntervalDays`, `clustering.similarityThreshold`,
      // `tenantQuotaShare`) which correctly assign `identityClass:
      // 'evolving'`. Cross-referencing the receiving field name from a
      // raw text scan is too error-prone for an audit signal that flows
      // into the Decision Catalog. Pattern 1 (`?? 'evolving'`
      // default-fallback) is field-agnostic-safe and is the sole
      // discrepancy class this scanner emits.
    });
  }

  return discrepancies;
}

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown by {@link assertTightenedCap} when a child loosens a numeric cap. */
export class IdentityClassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityClassError';
  }
}
