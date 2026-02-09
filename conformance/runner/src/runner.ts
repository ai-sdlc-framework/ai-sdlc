/**
 * Conformance test runner.
 *
 * Recursively finds YAML fixtures and validates them against
 * AI-SDLC JSON Schemas via the reference implementation.
 * Also runs behavioral test fixtures.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateResource, type ValidationResult } from '@ai-sdlc/reference';
import { isBehavioralFixture, runBehavioralTestAsync } from './behavioral.js';
import type { BehavioralResult } from './behavioral.js';

/** Conformance level classification per PRD §18.2. */
export type ConformanceLevel = 'core' | 'adapter' | 'full';

/** Per-level tally of conformance results. */
export interface ConformanceLevelReport {
  core: { total: number; passed: number; failed: number };
  adapter: { total: number; passed: number; failed: number };
  full: { total: number; passed: number; failed: number };
}

export interface FixtureResult {
  file: string;
  expectedValid: boolean;
  actualValid: boolean;
  passed: boolean;
  errors?: ValidationResult['errors'];
  conformanceLevel?: ConformanceLevel;
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
  conformanceLevels?: ConformanceLevelReport;
}

/**
 * Classify a fixture file path into a conformance level.
 * - pipeline/, quality-gate/ → 'core'
 * - adapter/, agent-role/ → 'adapter'
 * - autonomy-policy/ → 'full'
 */
export function classifyFixtureLevel(filePath: string, baseDir: string): ConformanceLevel {
  const rel = relative(baseDir, filePath);
  const topDir = rel.split('/')[0];
  switch (topDir) {
    case 'pipeline':
    case 'quality-gate':
      return 'core';
    case 'adapter':
    case 'agent-role':
      return 'adapter';
    case 'autonomy-policy':
      return 'full';
    default:
      return 'core';
  }
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
export async function runConformanceTests(fixturesDir?: string): Promise<RunnerReport> {
  const dir = fixturesDir ?? resolve(import.meta.dirname, '../../tests/v1alpha1');
  const files = findYamlFiles(dir);

  const schemaResults: FixtureResult[] = [];
  const behavioralResults: BehavioralResult[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const doc = parseYaml(content);

    if (isBehavioralFixture(doc)) {
      behavioralResults.push(await runBehavioralTestAsync(doc, file));
      continue;
    }

    const expectedValid = expectedValidity(file);
    const validation = validateResource(doc);
    const conformanceLevel = classifyFixtureLevel(file, dir);

    schemaResults.push({
      file,
      expectedValid,
      actualValid: validation.valid,
      passed: validation.valid === expectedValid,
      errors: validation.valid ? undefined : validation.errors,
      conformanceLevel,
    });
  }

  const schemaPassed = schemaResults.filter((r) => r.passed).length;
  const behavioralPassed = behavioralResults.filter((r) => r.passed).length;

  // Compute per-level tallies
  const conformanceLevels: ConformanceLevelReport = {
    core: { total: 0, passed: 0, failed: 0 },
    adapter: { total: 0, passed: 0, failed: 0 },
    full: { total: 0, passed: 0, failed: 0 },
  };
  for (const r of schemaResults) {
    const level = r.conformanceLevel ?? 'core';
    conformanceLevels[level].total++;
    if (r.passed) conformanceLevels[level].passed++;
    else conformanceLevels[level].failed++;
  }

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
    conformanceLevels,
  };
}
