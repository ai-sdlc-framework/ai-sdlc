/**
 * Hermetic regression tests for validate-schemas robustness.
 *
 * Covers AISDLC-494 acceptance criteria:
 *   AC #4: $id uniqueness assertion — duplicate $id across schema files fails the build.
 *   AC #5: idempotent-registration regression — registering schemas twice in one process
 *          does NOT throw (double-registration safety).
 *
 * These tests exercise the AJV registration pattern used in validate-schemas.ts
 * without running the CLI script itself, so they run hermetically inside vitest.
 */

import { describe, it, expect } from 'vitest';
import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { SCHEMAS } from './generated-schemas.js';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

type AjvInstance = InstanceType<typeof Ajv2020>;

function makeAjv(): AjvInstance {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

// ── AC #4: $id uniqueness ──────────────────────────────────────────────────────

describe('AC#4: $id uniqueness across schema files', () => {
  it('all schemas in SCHEMAS have unique $id values', () => {
    const seenIds = new Map<string, string>();
    const duplicates: Array<{ id: string; files: [string, string] }> = [];

    for (const [filename, schema] of Object.entries(SCHEMAS)) {
      const s = schema as { $id?: string };
      if (s.$id) {
        const prior = seenIds.get(s.$id);
        if (prior) {
          duplicates.push({ id: s.$id, files: [prior, filename] });
        } else {
          seenIds.set(s.$id, filename);
        }
      }
    }

    expect(duplicates).toHaveLength(0);
  });

  it('detects a duplicate $id when two schemas share the same id (mock)', () => {
    const ajv = makeAjv();

    const schemaA = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/duplicate-id-test.schema.json',
      type: 'object',
      properties: { a: { type: 'string' } },
    };
    const schemaB = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/duplicate-id-test.schema.json', // same $id
      type: 'object',
      properties: { b: { type: 'number' } },
    };

    // Simulate the uniqueness check from validate-schemas.ts:
    // collecting all $ids from a set of schemas surfaces the duplicate.
    const seenIds = new Map<string, string>();
    const schemas = [
      ['schema-a.json', schemaA],
      ['schema-b.json', schemaB],
    ] as const;

    const duplicates: string[] = [];
    for (const [filename, schema] of schemas) {
      if (schema.$id) {
        const prior = seenIds.get(schema.$id);
        if (prior) {
          duplicates.push(schema.$id);
        } else {
          seenIds.set(schema.$id, filename);
        }
      }
    }

    expect(duplicates).toContain('https://ai-sdlc.io/schemas/test/duplicate-id-test.schema.json');

    // The AJV idempotency guard means only the first schema is registered;
    // the check above (not AJV itself) is responsible for surfacing the error.
    ajv.addSchema(schemaA);
    // Second addSchema with same $id would throw without the guard — the guard
    // in validate-schemas.ts prevents it; here we confirm AJV throws without guard.
    expect(() => ajv.addSchema(schemaB)).toThrow();
  });
});

// ── AC #5: idempotent registration regression ──────────────────────────────────

describe('AC#5: idempotent-registration fix — double-registration does NOT throw', () => {
  it('registering all production schemas twice in one process does not throw', () => {
    const ajv = makeAjv();

    // First pass — register all schemas
    expect(() => {
      for (const schema of Object.values(SCHEMAS)) {
        const s = schema as { $id?: string };
        if (!ajv.getSchema(s.$id ?? '')) {
          ajv.addSchema(schema);
        }
      }
    }).not.toThrow();

    // Second pass — simulate a second call to getAjv() / validate in the same process.
    // Without the idempotency guard (ajv.getSchema(id) check), this would throw
    // "schema with key or id ... already exists".
    expect(() => {
      for (const schema of Object.values(SCHEMAS)) {
        const s = schema as { $id?: string };
        // This is the guard from validate-schemas.ts:
        if (!ajv.getSchema(s.$id ?? '')) {
          ajv.addSchema(schema);
        }
      }
    }).not.toThrow();
  });

  it('double-registration WITHOUT the guard throws (confirming guard is load-bearing)', () => {
    const ajv = makeAjv();
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/idempotency-guard-test.schema.json',
      type: 'object',
    };

    ajv.addSchema(schema);
    // Without the guard, adding the same schema again throws.
    expect(() => ajv.addSchema(schema)).toThrow();
  });

  it('double-registration WITH the guard does not throw (the fix)', () => {
    const ajv = makeAjv();
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://ai-sdlc.io/schemas/test/idempotency-guard-test-safe.schema.json',
      type: 'object',
    };

    function safeAddSchema(s: { $id?: string }) {
      if (!ajv.getSchema(s.$id ?? '')) {
        ajv.addSchema(s);
      }
    }

    expect(() => {
      safeAddSchema(schema);
      safeAddSchema(schema); // second call is a no-op, not a throw
    }).not.toThrow();
  });
});
