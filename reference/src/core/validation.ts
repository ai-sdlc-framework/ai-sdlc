/**
 * Schema validation using ajv against AI-SDLC JSON Schema definitions.
 * Uses ajv/dist/2020 for JSON Schema draft 2020-12 support.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { commonSchema, SCHEMAS } from './generated-schemas.js';
import type { ResourceKind, AnyResource } from './types.js';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

export interface ValidationResult<T = AnyResource> {
  valid: boolean;
  data?: T;
  errors?: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

const SCHEMA_FILES: Record<ResourceKind, string> = {
  Pipeline: 'pipeline.schema.json',
  AgentRole: 'agent-role.schema.json',
  QualityGate: 'quality-gate.schema.json',
  AutonomyPolicy: 'autonomy-policy.schema.json',
  AdapterBinding: 'adapter-binding.schema.json',
};

type AjvInstance = InstanceType<typeof Ajv2020>;
type ValidatorFn = ReturnType<AjvInstance['compile']>;

let ajvInstance: AjvInstance | null = null;
const validators = new Map<ResourceKind, ValidatorFn>();

function getAjv(): AjvInstance {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({
      allErrors: true,
      strict: false,
    });
    addFormats(ajvInstance);

    // Load common schema from inline generated module
    ajvInstance.addSchema(commonSchema);
  }
  return ajvInstance;
}

function getValidator(kind: ResourceKind): ValidatorFn {
  let validator = validators.get(kind);
  if (!validator) {
    const schemaFile = SCHEMA_FILES[kind];
    if (!schemaFile) {
      throw new Error(`Unknown resource kind: ${kind}`);
    }
    const schema = SCHEMAS[schemaFile];
    if (!schema) {
      throw new Error(`Schema not found for: ${schemaFile}`);
    }
    validator = getAjv().compile(schema);
    validators.set(kind, validator);
  }
  return validator;
}

/**
 * Collapse noisy AJV errors — especially oneOf branch failures — into
 * a concise list.  AJV reports individual branch errors (schemaPath
 * contains `/oneOf/0/`, `/oneOf/1/`, …) AND a summary `keyword:
 * 'oneOf'` error.  We keep the summary and drop the per-branch noise.
 */
export function formatValidationErrors(
  rawErrors: Array<{
    instancePath: string;
    message?: string;
    keyword: string;
    params?: Record<string, unknown>;
    schemaPath: string;
  }>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const err of rawErrors) {
    // Skip individual oneOf branch failures — they have schemaPath containing "/oneOf/"
    if (err.schemaPath.includes('/oneOf/') && err.keyword !== 'oneOf') {
      continue;
    }

    // For the summary "oneOf" error itself, provide a clearer message
    if (err.keyword === 'oneOf') {
      errors.push({
        path: err.instancePath || '/',
        message:
          'Value must match exactly one of the allowed variants (check the schema for valid shapes)',
        keyword: 'oneOf',
      });
      continue;
    }

    // Similarly collapse anyOf branch noise
    if (err.schemaPath.includes('/anyOf/') && err.keyword !== 'anyOf') {
      continue;
    }
    if (err.keyword === 'anyOf') {
      errors.push({
        path: err.instancePath || '/',
        message: 'Value must match at least one of the allowed variants',
        keyword: 'anyOf',
      });
      continue;
    }

    errors.push({
      path: err.instancePath || '/',
      message: err.message ?? 'Unknown validation error',
      keyword: err.keyword,
    });
  }

  return errors;
}

/**
 * Validate a resource document against its JSON Schema.
 */
export function validate<T extends AnyResource = AnyResource>(
  kind: ResourceKind,
  data: unknown,
): ValidationResult<T> {
  const validator = getValidator(kind);
  const valid = validator(data);

  if (valid) {
    return { valid: true, data: data as T };
  }

  const errors = formatValidationErrors(validator.errors ?? []);

  return { valid: false, errors };
}

/**
 * Validate a resource, inferring the kind from the document's `kind` field.
 */
export function validateResource(data: unknown): ValidationResult {
  if (typeof data !== 'object' || data === null || !('kind' in data)) {
    return {
      valid: false,
      errors: [{ path: '/', message: 'Missing "kind" field', keyword: 'required' }],
    };
  }

  const kind = (data as { kind: string }).kind as ResourceKind;
  if (!(kind in SCHEMA_FILES)) {
    return {
      valid: false,
      errors: [{ path: '/kind', message: `Unknown resource kind: ${kind}`, keyword: 'enum' }],
    };
  }

  return validate(kind, data);
}
