/**
 * Hermetic regression tests for validate-schemas robustness.
 *
 * Covers AISDLC-494 acceptance criteria:
 *   AC #4: $id uniqueness assertion — duplicate $id across schema files fails the build.
 *   AC #5: idempotent-registration regression — registering schemas twice in one process
 *          does NOT throw (double-registration safety).
 *
 * These tests import the exported functions from validate-schemas.ts directly
 * so that every branch in the source file receives coverage.
 */

import { describe, it, expect, vi } from 'vitest';
import { SCHEMAS } from './generated-schemas.js';
import {
  makeAjvInstance,
  checkDuplicateIds,
  validateSchemaFiles,
  runValidation,
  type SchemaObject,
} from './validate-schemas.js';

// ── AC #4: $id uniqueness via checkDuplicateIds() ─────────────────────────────

describe('AC#4: $id uniqueness — checkDuplicateIds()', () => {
  it('returns empty array when all schemas have unique $id values', () => {
    const entries = Object.entries(SCHEMAS).map(([filename, schema]) => ({
      filename,
      schema: schema as SchemaObject,
    }));
    const errors = checkDuplicateIds(entries);
    expect(errors).toHaveLength(0);
  });

  it('returns an error message when two schemas share the same $id', () => {
    const schemaA: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/dup-check-a.schema.json',
      type: 'object',
    };
    const schemaB: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/dup-check-a.schema.json', // same $id
      type: 'object',
    };

    const errors = checkDuplicateIds([
      { filename: 'schema-a.json', schema: schemaA },
      { filename: 'schema-b.json', schema: schemaB },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[duplicate-$id]');
    expect(errors[0]).toContain('https://ai-sdlc.io/schemas/test/dup-check-a.schema.json');
    expect(errors[0]).toContain('"schema-a.json"');
    expect(errors[0]).toContain('"schema-b.json"');
  });

  it('handles schemas without a $id gracefully (no false positives)', () => {
    const schemaA: SchemaObject = { type: 'object' }; // no $id
    const schemaB: SchemaObject = { type: 'string' }; // no $id

    const errors = checkDuplicateIds([
      { filename: 'no-id-a.json', schema: schemaA },
      { filename: 'no-id-b.json', schema: schemaB },
    ]);

    expect(errors).toHaveLength(0);
  });
});

// ── AC #5: idempotent registration via validateSchemaFiles() ──────────────────

describe('AC#5: validateSchemaFiles() — Pass 1 + Pass 2', () => {
  it('returns empty errors array for valid schemas', () => {
    const ajv = makeAjvInstance();
    const entries = Object.entries(SCHEMAS).map(([filename, schema]) => ({
      filename,
      schema: schema as SchemaObject,
    }));

    const errors = validateSchemaFiles(ajv, entries);
    expect(errors).toHaveLength(0);
  });

  it('returns an error when a schema has an invalid $ref', () => {
    const ajv = makeAjvInstance();
    const badSchema: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/bad-ref.schema.json',
      type: 'object',
      properties: {
        target: { $ref: 'https://ai-sdlc.io/schemas/test/does-not-exist.schema.json' },
      },
    };

    const errors = validateSchemaFiles(ajv, [
      { filename: 'bad-ref.schema.json', schema: badSchema },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe('bad-ref.schema.json');
    expect(errors[0].error).toBeTruthy();
  });

  it('does not throw when called twice with the same schemas (idempotent guard)', () => {
    const ajv = makeAjvInstance();
    const entries = Object.entries(SCHEMAS).map(([filename, schema]) => ({
      filename,
      schema: schema as SchemaObject,
    }));

    // First call registers all schemas
    expect(() => validateSchemaFiles(ajv, entries)).not.toThrow();
    // Second call on the SAME AJV instance must not throw due to the idempotency guard
    expect(() => validateSchemaFiles(ajv, entries)).not.toThrow();
  });

  it('falls back to ajv.compile() for schemas not yet registered (no $id)', () => {
    const ajv = makeAjvInstance();
    // A schema without $id is keyed by filename in the guard check
    const noIdSchema: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string' } },
    };

    const errors = validateSchemaFiles(ajv, [
      { filename: 'no-id-schema.schema.json', schema: noIdSchema },
    ]);

    expect(errors).toHaveLength(0);
  });
});

// ── runValidation() — clean + error paths ─────────────────────────────────────

describe('runValidation()', () => {
  it('returns true and logs success when all schemas are valid', () => {
    const entries = Object.entries(SCHEMAS).map(([filename, schema]) => ({
      filename,
      schema: schema as SchemaObject,
    }));
    const log = vi.fn();
    const logError = vi.fn();

    const ok = runValidation(entries, { log, logError });

    expect(ok).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    // Final "All schemas valid." line
    expect(log).toHaveBeenCalledWith(expect.stringContaining('All schemas valid'));
  });

  it('returns false and logs errors when a schema has a duplicate $id', () => {
    const schemaA: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/run-dup.schema.json',
      type: 'object',
    };
    const schemaB: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/run-dup.schema.json', // duplicate
      type: 'object',
    };

    const log = vi.fn();
    const logError = vi.fn();

    const ok = runValidation(
      [
        { filename: 'schema-a.json', schema: schemaA },
        { filename: 'schema-b.json', schema: schemaB },
      ],
      { log, logError },
    );

    expect(ok).toBe(false);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('[duplicate-$id]'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Schema validation failed'));
  });

  it('returns false and logs errors when a schema has an invalid $ref', () => {
    const badSchema: SchemaObject = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/run-bad-ref.schema.json',
      type: 'object',
      properties: {
        target: { $ref: 'https://ai-sdlc.io/schemas/test/nonexistent.schema.json' },
      },
    };

    const log = vi.fn();
    const logError = vi.fn();

    const ok = runValidation([{ filename: 'bad-ref.schema.json', schema: badSchema }], {
      log,
      logError,
    });

    expect(ok).toBe(false);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('bad-ref.schema.json'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Schema validation failed'));
  });

  it('uses console.log / console.error when no callbacks provided (defaults)', () => {
    // Exercise the default callback path by passing no options
    const entries = Object.entries(SCHEMAS).map(([filename, schema]) => ({
      filename,
      schema: schema as SchemaObject,
    }));

    // This exercises the default `log` and `logError` lambdas in runValidation()
    expect(() => runValidation(entries)).not.toThrow();
  });
});

// ── makeAjvInstance() ─────────────────────────────────────────────────────────

describe('makeAjvInstance()', () => {
  it('returns an AJV instance that can compile a simple schema', () => {
    const ajv = makeAjvInstance();
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { x: { type: 'number' } },
    };
    expect(() => ajv.compile(schema)).not.toThrow();
  });

  it('returns an AJV instance that validates string formats (ajv-formats loaded)', () => {
    const ajv = makeAjvInstance();
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
      format: 'email',
    };
    const validate = ajv.compile(schema);
    expect(validate('not-an-email')).toBe(false);
    expect(validate('user@example.com')).toBe(true);
  });
});
