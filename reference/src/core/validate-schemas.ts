#!/usr/bin/env tsx
/**
 * CLI script to validate that all JSON schemas are well-formed.
 * Usage: tsx src/core/validate-schemas.ts
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '../../../spec/schemas');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const files = readdirSync(SCHEMA_DIR).filter((f: string) => f.endsWith('.schema.json'));
let hasErrors = false;

// Load common schema first so $ref resolution works
const commonPath = resolve(SCHEMA_DIR, 'common.schema.json');
const commonSchema = JSON.parse(readFileSync(commonPath, 'utf-8'));
ajv.addSchema(commonSchema);

for (const file of files) {
  if (file === 'common.schema.json') continue;

  const schemaPath = resolve(SCHEMA_DIR, file);
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    ajv.compile(schema);
    console.log(`  ${file}`);
  } catch (err) {
    hasErrors = true;
    console.error(`  ${file}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
  }
}

if (hasErrors) {
  console.error('\nSchema validation failed.');
  process.exit(1);
} else {
  console.log('\nAll schemas valid.');
}
