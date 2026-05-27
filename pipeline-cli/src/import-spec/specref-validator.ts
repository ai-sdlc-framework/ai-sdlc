/**
 * `specRef` field validation for backlog task frontmatter.
 *
 * RFC-0036 Phase 3 (AISDLC-444). Provides:
 *
 *  1. **JSON Schema validation** — `validateSpecRef(value)` validates an
 *     arbitrary frontmatter `specRef:` value against the
 *     `spec/schemas/backlog-task.v1.schema.json` specRef sub-schema using
 *     Ajv2020. Accepts present+valid, accepts absent/undefined; rejects
 *     malformed values.
 *
 *  2. **Drift gate file-existence check** — `checkSpecRefArtifactExists(specRef, opts)`
 *     checks whether `specRef.artifactPath` exists on disk relative to the
 *     project root. Emits an info-level warning when the file is missing;
 *     never throws. The check is advisory (not a hard block) per the AC3
 *     contract: "info-level on missing".
 *
 * Both utilities are pure / side-effect-free except for the filesystem read
 * in (2). Tests can inject a fake `existsFn` for (2) to avoid touching disk.
 *
 * @module import-spec/specref-validator
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

// ── Schema sub-fragment (inlined to avoid a readFileSync at import time) ─────
//
// This is the `specRef` portion of `spec/schemas/backlog-task.v1.schema.json`.
// Inlining it removes a fs dependency at module-load time and lets the
// validator be imported in tests without touching the real spec/ dir.
//
// When the JSON schema file changes, keep this in sync.

const SPECREF_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ai-sdlc.io/schemas/v1alpha1/specref.inline.schema.json',
  description:
    'Inline specRef sub-schema extracted from backlog-task.v1.schema.json for lightweight validation.',
  type: 'object',
  required: ['source'],
  properties: {
    source: {
      type: 'string',
      enum: ['spec-kit', 'adopter-rfc', 'linear', 'notion', 'inline', 'other'],
    },
    featureId: { type: 'string', minLength: 1 },
    taskId: { type: 'string', minLength: 1 },
    artifactPath: { type: 'string', minLength: 1 },
    contractsPath: { type: 'string', minLength: 1 },
    importedAt: { type: 'string' },
  },
  additionalProperties: false,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * TypeScript type for a valid `specRef` frontmatter object. Mirrors the
 * JSON Schema shape in `backlog-task.v1.schema.json`.
 */
export interface SpecRefValue {
  source: 'spec-kit' | 'adopter-rfc' | 'linear' | 'notion' | 'inline' | 'other';
  featureId?: string;
  taskId?: string;
  artifactPath?: string;
  contractsPath?: string;
  importedAt?: string;
}

/** Result of a `validateSpecRef` call. */
export interface SpecRefValidationResult {
  /** `true` when `specRef` is absent (undefined/null) or a valid object. */
  valid: boolean;
  /** Human-readable errors when `valid` is `false`. */
  errors: string[];
}

/** Result of a `checkSpecRefArtifactExists` call. */
export interface SpecRefArtifactCheckResult {
  /** `true` when `artifactPath` is absent or the file exists on disk. */
  found: boolean;
  /**
   * When `found` is `false` — the resolved path that was checked.
   * Callers can include this in their info-level log message.
   */
  resolvedPath?: string;
  /** Info-level advisory message (set whenever the file is missing). */
  infoMessage?: string;
}

// ── Ajv singleton ─────────────────────────────────────────────────────────────

// Lazy-initialised; avoids compiling the schema on every import for callers
// that never call validateSpecRef.
let _validator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (_validator === null) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    _validator = ajv.compile(SPECREF_SCHEMA);
  }
  return _validator;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a frontmatter `specRef` value.
 *
 * - `undefined` / `null` → **valid** (field is optional; native tasks omit it)
 * - A valid {@link SpecRefValue} object → **valid**
 * - Anything else → **invalid** with error messages
 *
 * Does NOT perform the file-existence check; see {@link checkSpecRefArtifactExists}.
 */
export function validateSpecRef(specRef: unknown): SpecRefValidationResult {
  if (specRef === undefined || specRef === null) {
    return { valid: true, errors: [] };
  }

  const validate = getValidator();
  const ok = validate(specRef);
  if (ok) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors ?? []).map((e) => {
    const path = e.instancePath || '(root)';
    return `specRef${path}: ${e.message ?? 'unknown error'}`;
  });

  return { valid: false, errors };
}

/**
 * Options for {@link checkSpecRefArtifactExists}.
 */
export interface ArtifactCheckOpts {
  /**
   * Project root used to resolve a relative `artifactPath`. When
   * `artifactPath` is already absolute it is used as-is. Defaults to
   * `process.cwd()`.
   */
  workDir?: string;
  /**
   * Injectable filesystem existence predicate. Defaults to `existsSync`.
   * Injected by tests to avoid touching the real filesystem.
   */
  existsFn?: (path: string) => boolean;
}

/**
 * Check whether `specRef.artifactPath` exists on disk.
 *
 * Per AC3 the check is **info-level only** — the return type carries an
 * advisory `infoMessage` but the result never causes a hard failure.
 * Callers decide how to surface the message (console.info, drift-gate
 * output, etc.).
 *
 * When `specRef` is `undefined`/`null` or has no `artifactPath`, the
 * check is a no-op and returns `{ found: true }`.
 */
export function checkSpecRefArtifactExists(
  specRef: SpecRefValue | undefined | null,
  opts: ArtifactCheckOpts = {},
): SpecRefArtifactCheckResult {
  if (!specRef?.artifactPath) {
    return { found: true };
  }

  const workDir = opts.workDir ?? process.cwd();
  const existsFn = opts.existsFn ?? existsSync;
  const artifactPath = specRef.artifactPath;

  const resolvedPath = isAbsolute(artifactPath)
    ? normalize(artifactPath)
    : normalize(join(workDir, artifactPath));

  if (existsFn(resolvedPath)) {
    return { found: true, resolvedPath };
  }

  return {
    found: false,
    resolvedPath,
    infoMessage:
      `[specref-validator] info: specRef.artifactPath not found on disk: ${resolvedPath}` +
      ` (task was imported from '${artifactPath}' — upstream spec may have moved or been deleted)`,
  };
}
