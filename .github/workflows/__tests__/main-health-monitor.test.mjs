/**
 * AISDLC-768: main-health monitor must page on a red main.
 *
 * It never filed an issue because `--label "ci,main-red"` named labels that
 * did not exist. Every `--label` value the workflow passes must be created by
 * the workflow (`gh label create`) or listed in a checked-in manifest.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(__dirname, '..', 'main-health-monitor.yml');
const MANIFEST = resolve(__dirname, '..', 'label-manifest.json');

/** Labels referenced via `--label "a,b"` (comma lists split). */
export function referencedLabels(text) {
  const out = new Set();
  for (const m of text.matchAll(/--label[ =]+["']?([^"'\s\\]+)["']?/g)) {
    for (const l of m[1].split(',')) if (l.trim()) out.add(l.trim());
  }
  return out;
}

/** Labels created via `gh label create "name"`. */
export function createdLabels(text) {
  const out = new Set();
  for (const m of text.matchAll(/gh label create\s+["']?([^"'\s\\]+)["']?/g)) out.add(m[1]);
  return out;
}

export function unprovisionedLabels(text, manifest = []) {
  const created = createdLabels(text);
  const listed = new Set(manifest);
  return [...referencedLabels(text)].filter((l) => !created.has(l) && !listed.has(l));
}

describe('main-health-monitor workflow', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];

  it('references at least one label (guards the parser)', () => {
    assert.ok(referencedLabels(text).size > 0);
  });

  it('every --label is created by the workflow or listed in the manifest', () => {
    assert.deepEqual(unprovisionedLabels(text, manifest), []);
  });

  it('negative: fails when a label is referenced but neither created nor listed', () => {
    const synthetic = 'gh issue create --label "ci,ghost-label"\ngh label create "ci"';
    assert.deepEqual(unprovisionedLabels(synthetic, []), ['ghost-label']);
    assert.deepEqual(unprovisionedLabels(synthetic, ['ghost-label']), []);
  });

  it('runs daily on a schedule as well as on push to main', () => {
    assert.match(text, /^\s*schedule:\s*\n\s*- cron: '0 6 \* \* \*'/m);
    assert.match(text, /push:\s*\n\s*branches: \[main\]/);
  });

  it('degrades gracefully on schedule events (no head_commit dependency)', () => {
    assert.doesNotMatch(text, /github\.event\.head_commit\.message/);
    assert.match(text, /git log -1 --format=%s/);
  });

  it('a failed issue step fails loudly with the reason in the summary', () => {
    assert.match(text, /::error::main-health: could not file/);
    assert.match(text, /GITHUB_STEP_SUMMARY/);
    assert.match(text, /issue create[\s\S]*retrying without labels/);
  });
});
