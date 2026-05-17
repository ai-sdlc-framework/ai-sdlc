/**
 * Custom error classes for the CompliancePosture loader (RFC-0022 §9 Phase 1).
 *
 * These errors signal load-time validation failures that the loader surface
 * propagates to callers so they can provide actionable operator messages.
 */

/**
 * Thrown when a declared regime is missing required attestation metadata.
 *
 * Per RFC-0022 §5: compliance regimes are legal claims; the framework MUST NOT
 * let an operator silently declare HIPAA coverage without recording who said so.
 * A CompliancePosture whose regimes lack `attestedBy` or `attestedAt` fails to
 * load with this error.
 */
export class MissingComplianceAttestation extends Error {
  readonly regimeId: string;
  readonly missingField: 'attestedBy' | 'attestedAt';

  constructor(regimeId: string, missingField: 'attestedBy' | 'attestedAt') {
    super(
      `CompliancePosture regime '${regimeId}' is missing required attestation field '${missingField}'. ` +
        `Compliance regimes are legal claims — the framework requires explicit operator/legal sign-off. ` +
        `Add '${missingField}' to the regime declaration in .ai-sdlc/compliance.yaml.`,
    );
    this.name = 'MissingComplianceAttestation';
    this.regimeId = regimeId;
    this.missingField = missingField;
  }
}

/**
 * Thrown when a `derivedGates` override is present without a corresponding
 * `_notes` entry (or the notes entry is empty).
 *
 * Per RFC-0022 §6 (OQ-2): every operator override on a derived gate carries an
 * `attestedNotes` entry; the framework refuses to load a posture with `derivedGates`
 * overrides whose notes are missing or empty. Forcing explicit rationale makes
 * overrides audit-traceable.
 */
export class MissingDerivedGateOverrideNotes extends Error {
  readonly gateField: string;

  constructor(gateField: string) {
    super(
      `CompliancePosture 'derivedGates.${gateField}' is overridden but 'derivedGates._notes.${gateField}' ` +
        `is missing or empty. All derived-gate overrides require a non-empty rationale in _notes ` +
        `for audit traceability (RFC-0022 §6 OQ-2). ` +
        `Add a non-empty notes entry: derivedGates._notes.${gateField}: "<rationale>".`,
    );
    this.name = 'MissingDerivedGateOverrideNotes';
    this.gateField = gateField;
  }
}

/**
 * Thrown when a regime `id` is declared but not present in the framework's
 * canonical regime registry (spec/compliance/regime-mappings.yaml).
 *
 * Phase 1 note: the regime-mappings.yaml file ships in Phase 2 (AISDLC-323).
 * In Phase 1, this error is reserved for future use when the composer validates
 * declared regime IDs against the mapping table. The loader does NOT throw this
 * error in Phase 1 — unknown regime IDs are loaded and passed through unchanged
 * (the composer in Phase 2 will validate them against the mapping).
 */
export class UnknownRegime extends Error {
  readonly regimeId: string;

  constructor(regimeId: string) {
    super(
      `CompliancePosture declares regime '${regimeId}' which is not in the framework's canonical ` +
        `regime registry. Known regimes are listed in spec/compliance/regime-mappings.yaml. ` +
        `If this is a custom/adopter-specific regime, it will not derive framework gate defaults ` +
        `automatically (the composer only handles known regimes).`,
    );
    this.name = 'UnknownRegime';
    this.regimeId = regimeId;
  }
}

/**
 * Thrown when .ai-sdlc/compliance.yaml exists but fails JSON Schema validation
 * against spec/schemas/compliance-posture.v1.schema.json.
 *
 * Distinct from MissingComplianceAttestation and MissingDerivedGateOverrideNotes
 * which are semantic validations layered on top of schema validation.
 */
export class CompliancePostureValidationError extends Error {
  readonly validationErrors: Array<{ path: string; message: string }>;

  constructor(validationErrors: Array<{ path: string; message: string }>) {
    const summary = validationErrors.map((e) => `${e.path}: ${e.message}`).join('; ');
    super(
      `CompliancePosture at .ai-sdlc/compliance.yaml failed schema validation: ${summary}. ` +
        `See spec/schemas/compliance-posture.v1.schema.json for the required shape.`,
    );
    this.name = 'CompliancePostureValidationError';
    this.validationErrors = validationErrors;
  }
}
