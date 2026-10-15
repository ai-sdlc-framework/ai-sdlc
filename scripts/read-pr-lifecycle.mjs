#!/usr/bin/env node
/**
 * scripts/read-pr-lifecycle.mjs (AISDLC-879)
 *
 * Reads a `spec.<key>` value from `.ai-sdlc/pr-lifecycle.yaml` so workflows
 * never carry convention values (branch prefixes, ...) as literals.
 *
 * CLI: node scripts/read-pr-lifecycle.mjs <key> [--file <path>] [--array]
 *   prints one line per list item (or the scalar) on stdout; `--array` prints a JSON array.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// js-yaml is a root dep and a pipeline-cli dep; CI jobs that install only
// `@ai-sdlc/pipeline-cli...` have it under pipeline-cli, so resolve from there too.
const here = dirname(fileURLToPath(import.meta.url));
let yaml;
for (const base of [here, resolve(here, '..', 'pipeline-cli')]) {
  try {
    yaml = createRequire(resolve(base, 'noop.js'))('js-yaml');
    break;
  } catch {
    /* try next */
  }
}
if (!yaml) throw new Error('read-pr-lifecycle: js-yaml not resolvable');

const DEFAULT_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.ai-sdlc',
  'pr-lifecycle.yaml',
);

/** Returns the values of `spec.<key>` as an array of strings. */
export function readPrLifecycleValues(key, file = DEFAULT_FILE) {
  const doc = yaml.load(readFileSync(file, 'utf8'));
  const value = doc?.spec?.[key];
  if (value === undefined || value === null) {
    throw new Error(`pr-lifecycle: spec.${key} is not set in ${file}`);
  }
  return (Array.isArray(value) ? value : [value]).map(String);
}

const isMain = process.argv[1] != null && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  const key = args.find((a, i) => !a.startsWith('--') && (fileIdx < 0 || i !== fileIdx + 1));
  if (!key) {
    console.error('usage: read-pr-lifecycle.mjs <key> [--file <path>]');
    process.exit(2);
  }
  try {
    const values = readPrLifecycleValues(key, file);
    process.stdout.write(
      args.includes('--array') ? JSON.stringify(values) + '\n' : values.join('\n') + '\n',
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
