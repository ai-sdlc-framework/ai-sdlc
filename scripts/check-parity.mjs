#!/usr/bin/env node
/**
 * pnpm parity:check (AISDLC-1305).
 *  1. conformance/parity/manifest.json must equal what the reference generates.
 *  2. conformance/parity/exemptions.json may only shrink against the base ref.
 *
 * Usage: node scripts/check-parity.mjs [--root <dir>] [--base-ref <ref>]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, serializeManifest, MANIFEST_PATH } from './generate-parity-manifest.mjs';

export const EXEMPTIONS_PATH = 'conformance/parity/exemptions.json';

/** Flatten `{ python: { section: [names] } }` to `python/section/name` keys. */
export function flattenExemptions(ex) {
  const out = new Set();
  for (const [sdk, sections] of Object.entries(ex ?? {}))
    for (const [section, names] of Object.entries(sections))
      for (const name of names) out.add(`${sdk}/${section}/${name}`);
  return out;
}

/**
 * @param {string} root repo root
 * @param {object|null} baseExemptions parsed exemptions at the base ref, or null when unavailable
 * @returns {string[]} problems
 */
export function checkParity(root, baseExemptions) {
  const problems = [];
  const manifestFile = join(root, MANIFEST_PATH);
  const expected = serializeManifest(buildManifest(root));
  if (!existsSync(manifestFile) || readFileSync(manifestFile, 'utf8') !== expected) {
    problems.push(
      `${MANIFEST_PATH} is out of date with the reference; run: node scripts/generate-parity-manifest.mjs`,
    );
  }
  if (baseExemptions) {
    const exFile = join(root, EXEMPTIONS_PATH);
    const current = flattenExemptions(
      existsSync(exFile) ? JSON.parse(readFileSync(exFile, 'utf8')) : {},
    );
    const base = flattenExemptions(baseExemptions);
    for (const key of current)
      if (!base.has(key))
        problems.push(`${EXEMPTIONS_PATH} gained "${key}"; the exemption list can only shrink`);
  }
  return problems;
}

function baseExemptionsFromGit(root, ref) {
  const refs = ref ? [ref] : ['origin/main', 'main'];
  for (const r of refs) {
    try {
      const text = execFileSync('git', ['show', `${r}:${EXEMPTIONS_PATH}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      return JSON.parse(text);
    } catch {
      // ref missing or file absent at that ref: try the next
    }
  }
  return null;
}

function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const root = arg('--root')
    ? resolve(arg('--root'))
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const base = baseExemptionsFromGit(root, arg('--base-ref'));
  if (!base)
    console.log('parity: no base exemptions found (first introduction); growth check skipped');
  const problems = checkParity(root, base);
  for (const p of problems) console.error(`parity: ${p}`);
  if (problems.length) process.exit(1);
  console.log('parity: manifest current, exemptions did not grow');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
