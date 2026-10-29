import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVendorDefaultViolations } from './check-substrate-contract.mjs';

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-defaults-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('findVendorDefaultViolations (AISDLC-540)', () => {
  it('flags a hardwired harness default in core source', () => {
    const root = repoWith({ 'pipeline-cli/src/a.ts': "const x = { harness: 'claude-code' };\n" });
    try {
      const v = findVendorDefaultViolations(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].file, 'pipeline-cli/src/a.ts');
      assert.equal(v[0].line, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a ?? default', () => {
    const root = repoWith({ 'orchestrator/src/b.ts': "const t = opts.tool ?? 'claude-code';\n" });
    try {
      assert.equal(findVendorDefaultViolations(root).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows the seam, adapters, type unions, comments and tests', () => {
    const root = repoWith({
      'pipeline-cli/src/harness-defaults.ts':
        "export const D = 'claude-code' as const; // harness: 'claude-code'\n",
      'pipeline-cli/src/usage/ingest-claude.ts': "const h = { harness: 'claude-code' };\n",
      'pipeline-cli/src/t.ts':
        "type H = { harness: 'claude-code' | 'codex' };\n// harness: 'claude-code'\n",
      'pipeline-cli/src/a.test.ts': "const x = { harness: 'claude-code' };\n",
    });
    try {
      assert.deepEqual(findVendorDefaultViolations(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes on the real repository', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    assert.deepEqual(findVendorDefaultViolations(repoRoot), []);
  });
});
