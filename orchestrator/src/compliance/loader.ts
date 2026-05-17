/**
 * CompliancePosture loader (RFC-0022 §9 Phase 1).
 *
 * Reads `.ai-sdlc/compliance.yaml`, validates against
 * `spec/schemas/compliance-posture.v1.schema.json`, enforces semantic rules
 * (OQ-2 override-notes, OQ-6 list return type), and returns the parsed posture.
 *
 * Key design decisions:
 *  - Returns CompliancePosture[] (single-element list in v1) per OQ-6 so v2
 *    multi-tenant composition is additive — not a breaking API change.
 *  - Missing manifest → BASELINE_POSTURE returned (no error; AC #6).
 *  - Regime missing attestedBy / attestedAt → MissingComplianceAttestation thrown.
 *  - DerivedGates override without _notes entry → MissingDerivedGateOverrideNotes thrown.
 *  - Schema invalid → CompliancePostureValidationError thrown.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateResource } from '@ai-sdlc/reference';
import type { CompliancePosture, PartialDerivedGatesOverrides } from './types.js';
import { BASELINE_POSTURE } from './types.js';
import {
  CompliancePostureValidationError,
  MissingComplianceAttestation,
  MissingDerivedGateOverrideNotes,
} from './errors.js';

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Default path within the project root for the compliance manifest.
 * Overridable by passing `manifestPath` to `loadCompliancePosture`.
 */
export const DEFAULT_COMPLIANCE_MANIFEST_PATH = '.ai-sdlc/compliance.yaml';

/**
 * Gate fields that are present in DerivedGates (excluding _notes itself).
 * Used to enumerate override fields for OQ-2 validation.
 */
const DERIVED_GATE_FIELDS = [
  'databaseBranchPool',
  'secretScanStrictness',
  'attestationRequired',
  'auditRetentionDays',
  'reviewerAuthorityModel',
] as const satisfies ReadonlyArray<keyof Omit<PartialDerivedGatesOverrides, '_notes'>>;

// ── Loader ───────────────────────────────────────────────────────────────

/**
 * Options for `loadCompliancePosture`.
 */
export interface LoadCompliancePostureOptions {
  /**
   * Absolute path to the directory containing `.ai-sdlc/compliance.yaml`.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;

  /**
   * Override the manifest file path (relative to `projectRoot`).
   * Defaults to `.ai-sdlc/compliance.yaml`.
   */
  manifestPath?: string;
}

/**
 * Load and validate the project's CompliancePosture from disk.
 *
 * Returns a single-element `CompliancePosture[]` per OQ-6 (v2 forward-compat:
 * v2 multi-tenant will return multiple elements; the single-element v1 shape
 * is already a list so callers compose against `posture[0].spec.derivedGates`
 * today and multi-posture composition in v2 is purely additive).
 *
 * Semantics:
 *  - Missing manifest → `[BASELINE_POSTURE]` (AC #6: existing projects with
 *    no compliance.yaml get the "(none declared)" baseline; no gate changes).
 *  - Valid manifest → `[parsed_posture]`.
 *  - Invalid manifest → throws one of the compliance error classes.
 */
export function loadCompliancePosture(
  options: LoadCompliancePostureOptions = {},
): CompliancePosture[] {
  const projectRoot = options.projectRoot ?? process.cwd();
  const relPath = options.manifestPath ?? DEFAULT_COMPLIANCE_MANIFEST_PATH;
  const manifestPath = resolve(projectRoot, relPath);

  // AC #6: missing manifest → baseline posture (no error)
  if (!existsSync(manifestPath)) {
    return [BASELINE_POSTURE];
  }

  // Parse YAML
  let raw: unknown;
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    raw = parseYaml(content);
  } catch (err) {
    throw new CompliancePostureValidationError([
      { path: '/', message: `Failed to parse YAML: ${(err as Error).message}` },
    ]);
  }

  // JSON Schema validation via reference package
  // validateResource infers kind from the document and validates against the registered schema.
  // CompliancePosture is in SCHEMA_FILES so it will NOT be skipped.
  const result = validateResource(raw);
  if (result.skipped) {
    // This should not happen since CompliancePosture is a registered kind —
    // guard defensively in case the manifest has an unexpected kind field.
    throw new CompliancePostureValidationError([
      {
        path: '/kind',
        message: `Expected kind 'CompliancePosture' but got kind '${(raw as { kind?: unknown })?.kind}'`,
      },
    ]);
  }
  if (!result.valid) {
    throw new CompliancePostureValidationError(
      (result.errors ?? []).map((e) => ({ path: e.path, message: e.message })),
    );
  }

  const posture = result.data as unknown as CompliancePosture;

  // Semantic validation #1 — regime attestation (OQ-2 / AC #5)
  for (const regime of posture.spec.regimes) {
    if (!regime.attestedBy || regime.attestedBy.trim() === '') {
      throw new MissingComplianceAttestation(regime.id, 'attestedBy');
    }
    if (!regime.attestedAt || regime.attestedAt.trim() === '') {
      throw new MissingComplianceAttestation(regime.id, 'attestedAt');
    }
  }

  // Semantic validation #2 — derivedGates override notes (OQ-2 / AC #5)
  if (posture.spec.derivedGates) {
    validateDerivedGatesOverrideNotes(posture.spec.derivedGates);
  }

  return [posture];
}

/**
 * Validate that every overridden derived gate field has a corresponding
 * non-empty `_notes` entry. Throws `MissingDerivedGateOverrideNotes` on first
 * violation (fail-fast — single validation error at a time for clear messaging).
 */
function validateDerivedGatesOverrideNotes(overrides: PartialDerivedGatesOverrides): void {
  const notes = overrides._notes ?? {};

  for (const field of DERIVED_GATE_FIELDS) {
    // Field has been overridden if the key exists (even if value is undefined)
    if (!(field in overrides)) {
      continue;
    }
    // The field is present — check for a non-empty _notes entry
    const note = notes[field];
    if (note === undefined || note.trim() === '') {
      throw new MissingDerivedGateOverrideNotes(field);
    }
  }
}
