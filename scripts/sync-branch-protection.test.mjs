/**
 * AISDLC-1097: the strict (up-to-date) value in sync-branch-protection.sh and in
 * docs/operations/merge-without-queue.md must be the same.
 * Run with: node --test scripts/sync-branch-protection.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(resolve(root, 'scripts/sync-branch-protection.sh'), 'utf8');
const doc = readFileSync(resolve(root, 'docs/operations/merge-without-queue.md'), 'utf8');

test('script and doc state the same strict value', () => {
  const scriptValue = script.match(/^STRICT=(true|false)\b/m)?.[1];
  assert.ok(scriptValue, 'STRICT=<bool> not found in sync-branch-protection.sh');
  const docValues = new Set([...doc.matchAll(/`strict[=:] ?(true|false)`/g)].map((m) => m[1]));
  assert.ok(docValues.size > 0, 'no `strict=<bool>` statement found in the doc');
  assert.deepEqual([...docValues], [scriptValue]);
});
