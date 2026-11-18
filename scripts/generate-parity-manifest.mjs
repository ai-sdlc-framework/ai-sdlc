#!/usr/bin/env node
/**
 * Generates conformance/parity/manifest.json (AISDLC-1305): the named surface
 * of the TypeScript reference that the Python and Go SDKs are checked against.
 *
 * Usage: node scripts/generate-parity-manifest.mjs [--root <dir>]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = 'conformance/parity/manifest.json';

const SOURCES = {
  types: 'reference/src/core/types.ts',
  metrics: 'reference/src/metrics/types.ts',
  conventions: 'reference/src/telemetry/semantic-conventions.ts',
  mappings: 'reference/src/compliance/mappings.ts',
};

function block(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`parity: ${label}: marker "${startMarker}" not found`);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`parity: ${label}: end "${endMarker}" not found`);
  return text.slice(start, end);
}

function collect(text, re, label) {
  const out = [...text.matchAll(re)].map((m) => m[1]);
  if (out.length === 0) throw new Error(`parity: ${label}: no names found`);
  return [...new Set(out)].sort();
}

export function buildManifest(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const types = read(SOURCES.types);
  const metrics = read(SOURCES.metrics);
  const conv = read(SOURCES.conventions);
  const maps = read(SOURCES.mappings);
  const constValues = (name) =>
    collect(block(conv, `export const ${name} = {`, '} as const;', name), /:\s*'([^']+)'/g, name);
  return {
    resourceKinds: collect(
      block(types, 'export type ResourceKind =', ';', 'ResourceKind'),
      /'([^']+)'/g,
      'ResourceKind',
    ),
    standardMetrics: collect(
      block(metrics, 'export const STANDARD_METRICS', '\n]', 'STANDARD_METRICS'),
      /\bname:\s*'([^']+)'/g,
      'STANDARD_METRICS',
    ),
    spanNames: constValues('SPAN_NAMES'),
    metricNames: constValues('METRIC_NAMES'),
    attributeKeys: constValues('ATTRIBUTE_KEYS'),
    complianceControls: collect(
      block(maps, 'export const AI_SDLC_CONTROLS', '\n]', 'AI_SDLC_CONTROLS'),
      /\bid:\s*'([^']+)'/g,
      'AI_SDLC_CONTROLS',
    ),
    regulatoryFrameworks: collect(
      block(maps, 'export type RegulatoryFramework =', ';', 'RegulatoryFramework'),
      /'([^']+)'/g,
      'RegulatoryFramework',
    ),
  };
}

export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function main() {
  const i = process.argv.indexOf('--root');
  const root =
    i > 0 ? resolve(process.argv[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, MANIFEST_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeManifest(buildManifest(root)));
  console.log(`wrote ${MANIFEST_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
