/**
 * Schema validation using ajv against AI-SDLC JSON Schema definitions.
 * Uses ajv/dist/2020 for JSON Schema draft 2020-12 support.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceKind, AnyResource } from './types.js';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '../../../spec/schemas');

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

    // Load common schema first
    const commonSchema = JSON.parse(
      readFileSync(resolve(SCHEMA_DIR, 'common.schema.json'), 'utf-8'),
    );
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
    const schema = JSON.parse(
      readFileSync(resolve(SCHEMA_DIR, schemaFile), 'utf-8'),
    );
    validator = getAjv().compile(schema);
    validators.set(kind, validator);
  }
  return validator;
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

  const errors: ValidationError[] = (validator.errors ?? []).map((err: { instancePath: string; message?: string; keyword: string }) => ({
    path: err.instancePath || '/',
    message: err.message ?? 'Unknown validation error',
    keyword: err.keyword,
  }));

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
