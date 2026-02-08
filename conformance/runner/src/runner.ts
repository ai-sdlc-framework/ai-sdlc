/**
 * Conformance test runner.
 *
 * Recursively finds YAML fixtures and validates them against
 * AI-SDLC JSON Schemas via the reference implementation.
 * Also runs behavioral test fixtures.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateResource, type ValidationResult } from '@ai-sdlc/reference';
import { isBehavioralFixture, runBehavioralTest } from './behavioral.js';
import type { BehavioralResult } from './behavioral.js';

export interface FixtureResult {
  file: string;
  expectedValid: boolean;
  actualValid: boolean;
  passed: boolean;
  errors?: ValidationResult['errors'];
}

export interface RunnerReport {
  total: number;
  passed: number;
  failed: number;
  results: FixtureResult[];
  behavioral?: {
    total: number;
    passed: number;
    failed: number;
    results: BehavioralResult[];
  };
}

/**
 * Determine expected validity from filename convention.
 * - `valid-*` → expected to be valid
 * - `invalid-*` → expected to be invalid
 */
export function expectedValidity(filename: string): boolean {
  const base = basename(filename, '.yaml');
  if (base.startsWith('valid-')) return true;
  if (base.startsWith('invalid-')) return false;
  throw new Error(`Cannot determine expected validity from filename: ${filename}`);
}

function findYamlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findYamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * Run conformance tests against all YAML fixtures in a directory.
 */
export function runConformanceTests(fixturesDir?: string): RunnerReport {
  const dir = fixturesDir ?? resolve(import.meta.dirname, '../../tests/v1alpha1');
  const files = findYamlFiles(dir);

  const schemaResults: FixtureResult[] = [];
  const behavioralResults: BehavioralResult[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const doc = parseYaml(content);

    if (isBehavioralFixture(doc)) {
      behavioralResults.push(runBehavioralTest(doc, file));
      continue;
    }

    const expectedValid = expectedValidity(file);
    const validation = validateResource(doc);

    schemaResults.push({
      file,
      expectedValid,
      actualValid: validation.valid,
      passed: validation.valid === expectedValid,
      errors: validation.valid ? undefined : validation.errors,
    });
  }

  const schemaPassed = schemaResults.filter((r) => r.passed).length;
  const behavioralPassed = behavioralResults.filter((r) => r.passed).length;

  return {
    total: schemaResults.length + behavioralResults.length,
    passed: schemaPassed + behavioralPassed,
    failed: schemaResults.length - schemaPassed + behavioralResults.length - behavioralPassed,
    results: schemaResults,
    behavioral: {
      total: behavioralResults.length,
      passed: behavioralPassed,
      failed: behavioralResults.length - behavioralPassed,
      results: behavioralResults,
    },
  };
}
