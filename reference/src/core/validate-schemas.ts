#!/usr/bin/env tsx
/**
 * CLI script to validate that all JSON schemas are well-formed.
 * Usage: tsx src/core/validate-schemas.ts
 *
 * Core logic is exported as pure functions so hermetic tests can exercise
 * every branch without spawning a child process.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

export type AjvInstance = InstanceType<typeof Ajv2020>;
export type SchemaObject = { $id?: string; [key: string]: unknown };

/** Creates a configured AJV instance used by both CLI and tests. */
export function makeAjvInstance(): AjvInstance {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Pre-pass: assert $id uniqueness across all provided schema entries.
 *
 * Two committed files sharing a $id would cause the idempotency guard in
 * Pass 1 to silently skip the second file's well-formedness check, allowing
 * a colliding schema to evade validation entirely.
 *
 * Returns a list of duplicate-$id error messages (empty = clean).
 */
export function checkDuplicateIds(
  schemas: ReadonlyArray<{ filename: string; schema: SchemaObject }>,
): string[] {
  const seenIds = new Map<string, string>(); // $id → filename
  const errors: string[] = [];
  for (const { filename, schema } of schemas) {
    if (schema.$id) {
      const prior = seenIds.get(schema.$id);
      if (prior) {
        errors.push(
          `  [duplicate-$id] "${schema.$id}" appears in both "${prior}" and "${filename}"`,
        );
      } else {
        seenIds.set(schema.$id, filename);
      }
    }
  }
  return errors;
}

/**
 * Pass 1 + Pass 2: register and compile all schemas.
 *
 * Returns a list of compilation error objects (empty = clean).
 */
export function validateSchemaFiles(
  ajv: AjvInstance,
  schemas: ReadonlyArray<{ filename: string; schema: SchemaObject }>,
): { file: string; error: string }[] {
  // Pass 1: register all schemas so cross-schema $ref resolution works.
  for (const { filename, schema } of schemas) {
    // addSchema is idempotent when the $id is already registered; skip silently.
    if (!ajv.getSchema(schema.$id ?? filename)) {
      ajv.addSchema(schema);
    }
  }

  // Pass 2: compile every schema (validates internal consistency + $ref targets).
  // Use getSchema() to retrieve the already-registered validator rather than
  // calling compile() again — compile() re-adds the schema by $id and throws
  // "already exists" when the schema was registered in Pass 1.
  // Invoking the returned validator triggers lazy compilation and surfaces any
  // $ref-resolution or structural errors identical to ajv.compile().
  const errors: { file: string; error: string }[] = [];
  for (const { filename, schema } of schemas) {
    try {
      const id = schema.$id ?? filename;
      const validate = ajv.getSchema(id) ?? ajv.compile(schema);
      // Intentionally validate against an empty object to trigger lazy compilation
      // and surface any $ref-resolution or structural errors. The validation result
      // is intentionally ignored here — the goal is compilation/$ref-resolution
      // exceptions only, not instance validation.
      validate({});
    } catch (err) {
      errors.push({
        file: filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return errors;
}

/**
 * Core validation runner shared by the CLI entry point and tests.
 *
 * Accepts pre-loaded schema entries to avoid I/O in tests.
 * Returns `true` when validation is clean, `false` when errors were found.
 * All output is routed through the `log` / `logError` callbacks so tests can
 * capture output without touching stdout/stderr.
 */
export function runValidation(
  schemaEntries: ReadonlyArray<{ filename: string; schema: SchemaObject }>,
  options: {
    log?: (msg: string) => void;
    logError?: (msg: string) => void;
  } = {},
): boolean {
  const log = options.log ?? ((msg) => console.log(msg));
  const logError = options.logError ?? ((msg) => console.error(msg));

  let hasErrors = false;

  const dupErrors = checkDuplicateIds(schemaEntries);
  for (const msg of dupErrors) {
    logError(msg);
    hasErrors = true;
  }

  const ajv = makeAjvInstance();
  const compileErrors = validateSchemaFiles(ajv, schemaEntries);
  for (const { file, error } of compileErrors) {
    hasErrors = true;
    logError(`  ${file}`);
    logError(`    ${error}`);
  }

  // Log successful files
  for (const { filename } of schemaEntries) {
    const hadError = compileErrors.some((e) => e.file === filename);
    if (!hadError) {
      log(`  ${filename}`);
    }
  }

  if (hasErrors) {
    logError('\nSchema validation failed.');
  } else {
    log('\nAll schemas valid.');
  }

  return !hasErrors;
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '../../../spec/schemas');

const fileNames = readdirSync(SCHEMA_DIR).filter((f: string) => f.endsWith('.schema.json'));
const schemaEntries = fileNames.map((filename) => {
  const schemaPath = resolve(SCHEMA_DIR, filename);
  return { filename, schema: JSON.parse(readFileSync(schemaPath, 'utf-8')) as SchemaObject };
});

const ok = runValidation(schemaEntries);
if (!ok) {
  process.exit(1);
}
