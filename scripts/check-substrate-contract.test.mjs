#!/usr/bin/env node
/**
 * check-substrate-contract.test.mjs — hermetic tests for the RFC-0028 Phase 2
 * CI integrity gate (type-registry assertions + structural drift detection).
 *
 * Run with: `node --test scripts/check-substrate-contract.test.mjs`
 *
 * Coverage:
 *   - Each assertion's PASS path (no failures emitted)
 *   - Each assertion's FAIL path (correct failure shape + message)
 *   - §4.2 concrete catch reproduction: phantom-Soul-DID registration
 *   - Cold-start: no contracts → gate is a no-op (exit 0)
 *   - CLI invocation (via spawnSync) for integration coverage
 *   - Bypass env vars (AI_SDLC_BYPASS_ALL_GATES, AI_SDLC_SKIP_SUBSTRATE_GATE)
 *   - Supporting-file parse errors surface as failures (not silent skips)
 *   - Contract load errors surface as failures
 *   - parseArgs() extracts all supported flags
 *   - runGate() cold-start + contract-with-errors path
 *
 * Why node:test: same rationale as `scripts/check-rfc-docs.test.mjs` —
 * the script lives at workspace root, has no package.json, and node:test
 * ships with Node >=22 which we already require.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverContractFiles,
  loadContract,
  loadTessellationConfig,
  loadMarkerRegistry,
  runAssertion1,
  runAssertion2,
  runAssertion3,
  runAssertion4,
  runAssertion5,
  runContractAssertions,
  runGate,
  parseArgs,
} from './check-substrate-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-substrate-contract.mjs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid SubstrateContract JSON (Phase 1 + Phase 2 fields).
 * @param {object} [overrides]
 */
function makeContract(overrides = {}) {
  return {
    apiVersion: 'ai-sdlc/v1alpha1',
    kind: 'SubstrateContract',
    metadata: { name: 'soul-a' },
    spec: {
      soulId: 'soul-a',
      fields: [
        {
          name: 'observerCooldownMs',
          namedConsumer: 'substrate/cadence.ts#getCooldown',
          defaultFallback: 'Falls back to platform default 300000ms',
          identityClass: 'evolving',
        },
      ],
      ...overrides,
    },
  };
}

function makeTessellation(souls = ['soul-a', 'soul-b', 'soul-c']) {
  return { souls };
}

function makeMarkerRegistry(markers = ['marker-alpha', 'marker-beta']) {
  return { markers };
}

/** Write JSON to a temp file and return the path. */
function writeTempJson(dir, filename, obj) {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

// ── Test harness ──────────────────────────────────────────────────────────────

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'substrate-test-'));
});
after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ── discoverContractFiles ─────────────────────────────────────────────────────

describe('discoverContractFiles', () => {
  it('returns empty array when directory does not exist', () => {
    const result = discoverContractFiles(join(tmpDir, 'nonexistent-dir'));
    assert.deepEqual(result, []);
  });

  it('returns empty array for an empty directory', () => {
    const emptyDir = join(tmpDir, 'empty-contracts');
    mkdirSync(emptyDir);
    const result = discoverContractFiles(emptyDir);
    assert.deepEqual(result, []);
  });

  it('discovers contract JSON files and extracts registry keys', () => {
    const dir = join(tmpDir, 'contracts-discover');
    mkdirSync(dir);
    writeTempJson(dir, 'soul-a.json', makeContract({ soulId: 'soul-a' }));
    writeTempJson(dir, 'soul-b.json', makeContract({ soulId: 'soul-b' }));
    const result = discoverContractFiles(dir);
    assert.equal(result.length, 2);
    const keys = result.map((r) => r.registryKey).sort();
    assert.deepEqual(keys, ['soul-a', 'soul-b']);
  });

  it('excludes tessellation.json and marker-registry.json from contract files', () => {
    const dir = join(tmpDir, 'contracts-supporting');
    mkdirSync(dir);
    writeTempJson(dir, 'soul-a.json', makeContract({ soulId: 'soul-a' }));
    writeTempJson(dir, 'tessellation.json', makeTessellation());
    writeTempJson(dir, 'marker-registry.json', makeMarkerRegistry());
    const result = discoverContractFiles(dir);
    assert.equal(result.length, 1);
    assert.equal(result[0].registryKey, 'soul-a');
  });

  it('ignores non-JSON files', () => {
    const dir = join(tmpDir, 'contracts-non-json');
    mkdirSync(dir);
    writeTempJson(dir, 'soul-a.json', makeContract({ soulId: 'soul-a' }));
    writeFileSync(join(dir, 'README.md'), '# ignore me');
    writeFileSync(join(dir, 'soul-b.ts'), 'export const x = 1;');
    const result = discoverContractFiles(dir);
    assert.equal(result.length, 1);
  });
});

// ── loadContract ──────────────────────────────────────────────────────────────

describe('loadContract', () => {
  it('loads a valid contract', () => {
    const p = writeTempJson(join(tmpDir), 'valid.json', makeContract());
    const { contract, error } = loadContract(p);
    assert.equal(error, null);
    assert.ok(contract);
    assert.equal(contract.spec.soulId, 'soul-a');
  });

  it('returns error for non-existent file', () => {
    const { contract, error } = loadContract(join(tmpDir, 'ghost.json'));
    assert.equal(contract, null);
    assert.ok(error);
    assert.match(error, /Cannot read file/);
  });

  it('returns error for invalid JSON', () => {
    const p = join(tmpDir, 'bad.json');
    writeFileSync(p, '{ not valid json ');
    const { contract, error } = loadContract(p);
    assert.equal(contract, null);
    assert.ok(error);
    assert.match(error, /JSON parse error/);
  });

  it('returns error when kind ≠ SubstrateContract', () => {
    const p = writeTempJson(join(tmpDir), 'wrong-kind.json', {
      ...makeContract(),
      kind: 'SomethingElse',
    });
    const { contract, error } = loadContract(p);
    assert.equal(contract, null);
    assert.match(error, /Expected kind/);
  });

  it('returns error when spec.soulId is missing', () => {
    const c = makeContract();
    delete c.spec.soulId;
    const p = writeTempJson(join(tmpDir), 'no-soul-id.json', c);
    const { contract, error } = loadContract(p);
    assert.equal(contract, null);
    assert.match(error, /soulId must be a non-empty string/);
  });

  it('returns error when spec.soulId is empty string', () => {
    const c = makeContract({ soulId: '' });
    const p = writeTempJson(join(tmpDir), 'empty-soul-id.json', c);
    const { contract, error } = loadContract(p);
    assert.equal(contract, null);
    assert.match(error, /soulId must be a non-empty string/);
  });
});

// ── loadTessellationConfig ────────────────────────────────────────────────────

describe('loadTessellationConfig', () => {
  it('returns null config and no error when file does not exist (graceful skip)', () => {
    const { config, error } = loadTessellationConfig(join(tmpDir, 'nonexistent-tess.json'));
    assert.equal(config, null);
    assert.equal(error, null);
  });

  it('loads flat { souls: [...] } format', () => {
    const p = writeTempJson(join(tmpDir), 'tess-flat.json', { souls: ['soul-a', 'soul-b'] });
    const { config, error } = loadTessellationConfig(p);
    assert.equal(error, null);
    assert.deepEqual(config, { souls: ['soul-a', 'soul-b'] });
  });

  it('loads structured { spec: { souls: [...] } } format', () => {
    const p = writeTempJson(join(tmpDir), 'tess-structured.json', {
      apiVersion: 'ai-sdlc/v1alpha1',
      kind: 'TessellationConfig',
      spec: { souls: ['soul-a', 'soul-b'] },
    });
    const { config, error } = loadTessellationConfig(p);
    assert.equal(error, null);
    assert.deepEqual(config?.souls, ['soul-a', 'soul-b']);
  });

  it('returns error when souls array is missing', () => {
    const p = writeTempJson(join(tmpDir), 'tess-no-souls.json', { foo: 'bar' });
    const { config, error } = loadTessellationConfig(p);
    assert.equal(config, null);
    assert.ok(error);
    assert.match(error, /souls.*array/i);
  });

  it('returns error for invalid JSON', () => {
    const p = join(tmpDir, 'tess-bad.json');
    writeFileSync(p, '{ invalid');
    const { config, error } = loadTessellationConfig(p);
    assert.equal(config, null);
    assert.ok(error);
    assert.match(error, /parse error/i);
  });
});

// ── loadMarkerRegistry ────────────────────────────────────────────────────────

describe('loadMarkerRegistry', () => {
  it('returns null registry and no error when file does not exist (graceful skip)', () => {
    const { registry, error } = loadMarkerRegistry(join(tmpDir, 'nonexistent-reg.json'));
    assert.equal(registry, null);
    assert.equal(error, null);
  });

  it('loads flat { markers: [...] } format', () => {
    const p = writeTempJson(join(tmpDir), 'reg-flat.json', { markers: ['m-a', 'm-b'] });
    const { registry, error } = loadMarkerRegistry(p);
    assert.equal(error, null);
    assert.deepEqual(registry, { markers: ['m-a', 'm-b'] });
  });

  it('loads structured { spec: { markers: [...] } } format', () => {
    const p = writeTempJson(join(tmpDir), 'reg-structured.json', {
      spec: { markers: ['m-a', 'm-b'] },
    });
    const { registry, error } = loadMarkerRegistry(p);
    assert.equal(error, null);
    assert.deepEqual(registry?.markers, ['m-a', 'm-b']);
  });

  it('returns error when markers array is missing', () => {
    const p = writeTempJson(join(tmpDir), 'reg-no-markers.json', { foo: 'bar' });
    const { registry, error } = loadMarkerRegistry(p);
    assert.equal(registry, null);
    assert.ok(error);
    assert.match(error, /markers.*array/i);
  });
});

// ── Assertion 1: Registry key matches soulId ─────────────────────────────────

describe('runAssertion1 — registry key matches soulId', () => {
  it('PASS: filename matches spec.soulId', () => {
    const c = makeContract({ soulId: 'soul-alpha' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-alpha.json', c));
    const result = runAssertion1(contract, 'soul-alpha');
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 1);
  });

  it('FAIL: filename ≠ spec.soulId (mis-registration drift)', () => {
    const c = makeContract({ soulId: 'soul-alpha' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-alpha.json', c));
    const result = runAssertion1(contract, 'soul-beta'); // wrong registry key
    assert.equal(result.passed, false);
    assert.equal(result.assertionId, 1);
    assert.match(result.message, /mis-registration drift/i);
    assert.match(result.message, /soul-beta/);
    assert.match(result.message, /soul-alpha/);
    assert.equal(result.field, 'spec.soulId');
    assert.ok(result.decisionSummary?.includes('Assertion 1'));
  });

  it('FAIL: decisionSummary includes RFC-0028 §4 vocabulary', () => {
    const c = makeContract({ soulId: 'correct-id' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'correct-id.json', c));
    const result = runAssertion1(contract, 'wrong-key');
    assert.match(result.decisionSummary ?? '', /substrate-structural-drift-detected/i);
    assert.match(result.decisionSummary ?? '', /mis-registration/i);
  });
});

// ── Assertion 2: soulId ∈ runtime soul-membership set ────────────────────────

describe('runAssertion2 — soulId ∈ soul-membership set (§4.2 concrete catch)', () => {
  it('PASS: soulId is in the tessellation souls[]', () => {
    const c = makeContract({ soulId: 'soul-a' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-a-a2.json', c));
    const tessellation = { souls: ['soul-a', 'soul-b'] };
    const result = runAssertion2(contract, tessellation);
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 2);
  });

  it('FAIL: soulId NOT in tessellation souls[] — §4.2 phantom-Soul DID concrete catch', () => {
    const c = makeContract({ soulId: 'soul-phantom' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-phantom.json', c));
    const tessellation = { souls: ['soul-a', 'soul-b', 'soul-c'] }; // soul-phantom missing
    const result = runAssertion2(contract, tessellation);
    assert.equal(result.passed, false);
    assert.equal(result.assertionId, 2);
    assert.match(result.message, /phantom-Soul DID/i);
    assert.match(result.message, /§4\.2/i);
    assert.match(result.message, /soul-phantom/);
    assert.equal(result.field, 'spec.soulId');
  });

  it('PASS (skipped): no tessellation config present — assertion 2 deferred', () => {
    const c = makeContract({ soulId: 'soul-a' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-a-notess.json', c));
    const result = runAssertion2(contract, null);
    assert.equal(result.passed, true);
    assert.match(result.message, /skipped/i);
  });

  it('FAIL: decisionSummary references phantom-Soul DID and §4.2', () => {
    const c = makeContract({ soulId: 'missing-soul' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'missing-soul.json', c));
    const result = runAssertion2(contract, { souls: ['soul-a'] });
    assert.match(result.decisionSummary ?? '', /phantom/i);
    assert.match(result.decisionSummary ?? '', /§4\.2/);
    assert.match(result.decisionSummary ?? '', /substrate-structural-drift-detected/i);
  });
});

// ── Assertion 3: Eρ₅ compliance locks INVIOLABLE ─────────────────────────────

describe('runAssertion3 — Eρ₅ compliance locks on vulnerable souls', () => {
  it('PASS (skipped): no compliance sub-contract declared', () => {
    const c = makeContract();
    delete c.spec.compliance;
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-compliance.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 3);
    assert.match(result.message, /skipped|not applicable/i);
  });

  it('PASS (skipped): compliance declared but vulnerableAudience is false', () => {
    const c = makeContract({
      compliance: { vulnerableAudience: false },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-non-vulnerable.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, true);
  });

  it('PASS: vulnerable soul with requiresVulnerableAudienceLockout=true', () => {
    const c = makeContract({
      compliance: {
        vulnerableAudience: true,
        locks: { requiresVulnerableAudienceLockout: true },
      },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-locked.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 3);
  });

  it('FAIL: vulnerable soul missing requiresVulnerableAudienceLockout', () => {
    const c = makeContract({
      compliance: {
        vulnerableAudience: true,
        locks: {}, // lock NOT set
      },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-missing-lock.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, false);
    assert.equal(result.assertionId, 3);
    assert.match(result.message, /compliance lock missing/i);
    assert.equal(result.field, 'spec.compliance.locks.requiresVulnerableAudienceLockout');
  });

  it('FAIL: vulnerable soul with requiresVulnerableAudienceLockout=false', () => {
    const c = makeContract({
      compliance: {
        vulnerableAudience: true,
        locks: { requiresVulnerableAudienceLockout: false }, // explicitly false
      },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-disabled-lock.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, false);
    assert.match(result.message, /compliance lock disabled/i);
    assert.match(result.message, /must be true/i);
  });

  it('FAIL: vulnerable soul with locks absent entirely', () => {
    const c = makeContract({
      compliance: { vulnerableAudience: true },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-locks.json', c));
    const result = runAssertion3(contract);
    assert.equal(result.passed, false);
    assert.match(result.message, /absent/i);
    assert.match(result.decisionSummary ?? '', /Eρ₅|Assertion 3/);
  });
});

// ── Assertion 4: Director agent ∈ council membership ─────────────────────────

describe('runAssertion4 — director agent in council membership', () => {
  it('PASS (skipped): no council sub-contract', () => {
    const c = makeContract();
    delete c.spec.council;
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-council.json', c));
    const result = runAssertion4(contract);
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 4);
    assert.match(result.message, /skipped/i);
  });

  it('PASS (skipped): council declared but no director', () => {
    const c = makeContract({
      council: { agentIds: ['agent-1', 'agent-2'] },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-director.json', c));
    const result = runAssertion4(contract);
    assert.equal(result.passed, true);
  });

  it('PASS: director is in agentIds', () => {
    const c = makeContract({
      council: { director: 'agent-1', agentIds: ['agent-1', 'agent-2', 'agent-3'] },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-director-in.json', c));
    const result = runAssertion4(contract);
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 4);
    assert.match(result.message, /agent-1/);
  });

  it('FAIL: director NOT in agentIds (cross-soul authority leak)', () => {
    const c = makeContract({
      council: { director: 'rogue-director', agentIds: ['agent-1', 'agent-2'] },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-rogue.json', c));
    const result = runAssertion4(contract);
    assert.equal(result.passed, false);
    assert.equal(result.assertionId, 4);
    assert.match(result.message, /cross-soul authority leak/i);
    assert.match(result.message, /rogue-director/);
    assert.equal(result.field, 'spec.council.director');
  });

  it('FAIL: director declared but agentIds is not an array', () => {
    const c = makeContract({
      council: { director: 'agent-1', agentIds: 'not-an-array' },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-bad-agents.json', c));
    const result = runAssertion4(contract);
    assert.equal(result.passed, false);
    assert.match(result.message, /council misconfiguration/i);
  });

  it('FAIL: decisionSummary references cross-soul authority leak', () => {
    const c = makeContract({
      council: { director: 'x', agentIds: ['a', 'b'] },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-leak.json', c));
    const result = runAssertion4(contract);
    assert.match(result.decisionSummary ?? '', /cross-soul authority leak/i);
    assert.match(result.decisionSummary ?? '', /substrate-structural-drift-detected/i);
  });
});

// ── Assertion 5: Substrate marker keys ∈ SSOT marker registry ────────────────

describe('runAssertion5 — substrate marker keys in SSOT registry', () => {
  it('PASS (skipped): no markerKeys in contract', () => {
    const c = makeContract();
    delete c.spec.markerKeys;
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-markers.json', c));
    const result = runAssertion5(contract, { markers: ['m-a', 'm-b'] });
    assert.equal(result.passed, true);
    assert.equal(result.assertionId, 5);
    assert.match(result.message, /skipped/i);
  });

  it('PASS (skipped): markerKeys is empty array', () => {
    const c = makeContract({ markerKeys: [] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-empty-markers.json', c));
    const result = runAssertion5(contract, { markers: ['m-a'] });
    assert.equal(result.passed, true);
    assert.match(result.message, /skipped/i);
  });

  it('PASS (skipped): no marker registry present', () => {
    const c = makeContract({ markerKeys: ['m-a', 'm-b'] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-no-reg.json', c));
    const result = runAssertion5(contract, null);
    assert.equal(result.passed, true);
    assert.match(result.message, /skipped/i);
  });

  it('PASS: all marker keys registered in SSOT', () => {
    const c = makeContract({ markerKeys: ['m-a', 'm-b'] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-markers-ok.json', c));
    const result = runAssertion5(contract, { markers: ['m-a', 'm-b', 'm-c'] });
    assert.equal(result.passed, true);
    assert.match(result.message, /All 2 marker key/);
  });

  it('FAIL: unknown marker keys (substrate contamination)', () => {
    const c = makeContract({ markerKeys: ['m-registered', 'm-unregistered'] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-contaminated.json', c));
    const result = runAssertion5(contract, { markers: ['m-registered'] });
    assert.equal(result.passed, false);
    assert.equal(result.assertionId, 5);
    assert.match(result.message, /substrate contamination/i);
    assert.match(result.message, /m-unregistered/);
    assert.equal(result.field, 'spec.markerKeys');
  });

  it('FAIL: decisionSummary references substrate contamination', () => {
    const c = makeContract({ markerKeys: ['bad-key'] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-bad-key.json', c));
    const result = runAssertion5(contract, { markers: ['good-key'] });
    assert.match(result.decisionSummary ?? '', /substrate contamination/i);
    assert.match(result.decisionSummary ?? '', /substrate-structural-drift-detected/i);
  });

  it('FAIL: multiple unknown keys — all reported in message', () => {
    const c = makeContract({ markerKeys: ['known', 'unknown-1', 'unknown-2'] });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'soul-multi-unknown.json', c));
    const result = runAssertion5(contract, { markers: ['known'] });
    assert.equal(result.passed, false);
    assert.match(result.message, /unknown-1/);
    assert.match(result.message, /unknown-2/);
  });
});

// ── runContractAssertions ─────────────────────────────────────────────────────

describe('runContractAssertions — runs all 5 in sequence', () => {
  it('returns 5 AssertionResults for a clean contract', () => {
    const c = makeContract({ soulId: 'clean-soul' });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'clean-soul.json', c));
    const tessellation = { souls: ['clean-soul'] };
    const results = runContractAssertions(contract, 'clean-soul', tessellation, null);
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.passed));
  });

  it('returns failures for each broken assertion', () => {
    const c = makeContract({
      soulId: 'bad-soul',
      council: { director: 'not-in-council', agentIds: ['agent-a'] },
    });
    const { contract } = loadContract(writeTempJson(join(tmpDir), 'bad-soul.json', c));
    const tessellation = { souls: ['other-soul'] }; // bad-soul missing → Assertion 2 fails
    const results = runContractAssertions(contract, 'bad-soul', tessellation, null);
    const failures = results.filter((r) => !r.passed);
    assert.ok(failures.length >= 2); // Assertion 2 + Assertion 4 should fail
    const assertionIds = failures.map((f) => f.assertionId);
    assert.ok(assertionIds.includes(2));
    assert.ok(assertionIds.includes(4));
  });
});

// ── runGate ───────────────────────────────────────────────────────────────────

describe('runGate — full gate orchestration', () => {
  it('cold-start: no contracts dir → no-op (passed=true, coldStart=true)', () => {
    const result = runGate({ repoRoot: join(tmpDir, 'fresh-adopter-' + Date.now()) });
    assert.equal(result.coldStart, true);
    assert.equal(result.passed, true);
    assert.equal(result.contractsFound, 0);
    assert.deepEqual(result.failures, []);
  });

  it('cold-start: contracts dir exists but is empty → no-op', () => {
    const emptyRoot = join(tmpDir, 'empty-adopter-' + Date.now());
    mkdirSync(join(emptyRoot, 'substrate-contracts'), { recursive: true });
    const result = runGate({ repoRoot: emptyRoot });
    assert.equal(result.coldStart, true);
    assert.equal(result.passed, true);
    assert.equal(result.contractsFound, 0);
  });

  it('passes when all contracts are clean', () => {
    const root = join(tmpDir, 'clean-root-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeTempJson(contractsDir, 'soul-a.json', makeContract({ soulId: 'soul-a' }));
    writeTempJson(contractsDir, 'soul-b.json', makeContract({ soulId: 'soul-b' }));
    writeTempJson(contractsDir, 'tessellation.json', { souls: ['soul-a', 'soul-b'] });
    const result = runGate({ repoRoot: root });
    assert.equal(result.coldStart, false);
    assert.equal(result.passed, true);
    assert.equal(result.contractsFound, 2);
    assert.deepEqual(result.failures, []);
  });

  it('fails when one contract has a bad soulId (Assertion 1)', () => {
    const root = join(tmpDir, 'a1-fail-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    // File named wrong-key.json but soulId=right-id → Assertion 1 fails
    writeTempJson(contractsDir, 'wrong-key.json', makeContract({ soulId: 'right-id' }));
    writeTempJson(contractsDir, 'tessellation.json', { souls: ['right-id'] });
    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, false);
    const a1Failures = result.failures.filter((f) => f.assertionId === 1);
    assert.ok(a1Failures.length > 0);
  });

  it('§4.2 phantom-Soul reproduction: soulId not in tessellation.souls[]', () => {
    const root = join(tmpDir, 'phantom-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    // The §4.2 failure mode: soul-phantom has a contract but is missing from souls[]
    writeTempJson(contractsDir, 'soul-phantom.json', makeContract({ soulId: 'soul-phantom' }));
    writeTempJson(contractsDir, 'tessellation.json', {
      souls: ['soul-a', 'soul-b', 'soul-c'], // soul-phantom intentionally missing
    });
    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, false);
    const a2Failure = result.failures.find(
      (f) => f.assertionId === 2 && f.soulId === 'soul-phantom',
    );
    assert.ok(a2Failure, 'Assertion 2 failure for soul-phantom not found');
    assert.match(a2Failure.message, /phantom-Soul DID/i);
    assert.match(a2Failure.message, /§4\.2/i);
  });

  it('fails when tessellation.json has invalid JSON', () => {
    const root = join(tmpDir, 'tess-invalid-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeTempJson(contractsDir, 'soul-a.json', makeContract({ soulId: 'soul-a' }));
    writeFileSync(join(contractsDir, 'tessellation.json'), '{ not valid }');
    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, false);
    const configError = result.failures.find((f) => f.field === 'tessellation.json');
    assert.ok(configError);
  });

  it('fails when a contract file has invalid JSON', () => {
    const root = join(tmpDir, 'contract-invalid-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeFileSync(join(contractsDir, 'bad-contract.json'), '{ not valid }');
    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, false);
    assert.ok(result.failures.some((f) => /Contract load error/.test(f.message)));
  });

  it('uses --contracts-dir override when provided', () => {
    const customDir = join(tmpDir, 'custom-contracts-' + Date.now());
    mkdirSync(customDir);
    writeTempJson(customDir, 'soul-x.json', makeContract({ soulId: 'soul-x' }));
    const result = runGate({ contractsDir: customDir });
    assert.equal(result.coldStart, false);
    assert.equal(result.contractsFound, 1);
    // Assertion 2 skipped (no tessellation) — should pass overall
    assert.equal(result.passed, true);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('returns default repoRoot when no args given', () => {
    const { repoRoot, contractsDir, tessellationPath, markerRegistryPath } = parseArgs([]);
    assert.ok(repoRoot.length > 0);
    assert.equal(contractsDir, undefined);
    assert.equal(tessellationPath, undefined);
    assert.equal(markerRegistryPath, undefined);
  });

  it('parses --contracts-dir', () => {
    const { contractsDir } = parseArgs(['--contracts-dir', '/some/dir']);
    assert.match(contractsDir ?? '', /some\/dir/);
  });

  it('parses --tessellation', () => {
    const { tessellationPath } = parseArgs(['--tessellation', '/some/tessellation.json']);
    assert.match(tessellationPath ?? '', /tessellation\.json/);
  });

  it('parses --marker-registry', () => {
    const { markerRegistryPath } = parseArgs(['--marker-registry', '/some/registry.json']);
    assert.match(markerRegistryPath ?? '', /registry\.json/);
  });

  it('parses --repo-root', () => {
    const { repoRoot } = parseArgs(['--repo-root', '/custom/root']);
    assert.equal(repoRoot, '/custom/root');
  });

  it('parses all flags together', () => {
    const result = parseArgs([
      '--repo-root',
      '/root',
      '--contracts-dir',
      '/root/contracts',
      '--tessellation',
      '/root/tess.json',
      '--marker-registry',
      '/root/reg.json',
    ]);
    assert.equal(result.repoRoot, '/root');
    assert.match(result.contractsDir ?? '', /contracts/);
    assert.match(result.tessellationPath ?? '', /tess\.json/);
    assert.match(result.markerRegistryPath ?? '', /reg\.json/);
  });
});

// ── CLI invocation via spawnSync ──────────────────────────────────────────────

describe('CLI invocation', () => {
  it('exits 0 (cold-start) when no contracts directory exists', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--repo-root', join(tmpDir, 'cold-start-cli-' + Date.now())],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /cold-start|no-op|no substrate contracts/i);
  });

  it('exits 0 when all contracts pass', () => {
    const root = join(tmpDir, 'cli-pass-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeTempJson(contractsDir, 'soul-ok.json', makeContract({ soulId: 'soul-ok' }));
    writeTempJson(contractsDir, 'tessellation.json', { souls: ['soul-ok'] });

    const result = spawnSync(process.execPath, [SCRIPT, '--repo-root', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, AI_SDLC_SKIP_DECISION_EMIT: '1' },
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /All assertions passed|passed/i);
  });

  it('exits 1 when a contract fails an assertion', () => {
    const root = join(tmpDir, 'cli-fail-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    // Phantom soul: file named 'ghost.json' with soulId 'ghost' but not in tessellation
    writeTempJson(contractsDir, 'ghost.json', makeContract({ soulId: 'ghost' }));
    writeTempJson(contractsDir, 'tessellation.json', { souls: ['soul-a'] });

    const result = spawnSync(process.execPath, [SCRIPT, '--repo-root', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, AI_SDLC_SKIP_DECISION_EMIT: '1' },
    });
    assert.equal(
      result.status,
      1,
      `expected exit 1 but got ${result.status}. stdout: ${result.stdout}`,
    );
    assert.match(result.stderr, /assertion.*fail|phantom|drift/i);
  });

  it('exits 0 when AI_SDLC_BYPASS_ALL_GATES=1 (even with failing contracts)', () => {
    const root = join(tmpDir, 'bypass-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeTempJson(contractsDir, 'broken.json', makeContract({ soulId: 'different-id' }));

    const result = spawnSync(process.execPath, [SCRIPT, '--repo-root', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, AI_SDLC_BYPASS_ALL_GATES: '1' },
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /bypass/i);
  });

  it('exits 0 when AI_SDLC_SKIP_SUBSTRATE_GATE=1', () => {
    const root = join(tmpDir, 'skip-gate-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');
    writeTempJson(contractsDir, 'broken.json', makeContract({ soulId: 'different-id' }));

    const result = spawnSync(process.execPath, [SCRIPT, '--repo-root', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, AI_SDLC_SKIP_SUBSTRATE_GATE: '1' },
    });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /skip/i);
  });
});

// ── §4.2 concrete catch integration test ─────────────────────────────────────

describe('§4.2 concrete catch: phantom-Soul-DID registration reproduction', () => {
  /**
   * Reproduces the exact failure mode from RFC-0028 §4.2:
   *
   * "For the full duration of v3.2's deployment, one of the platform's six
   * Soul DIDs had its membership enforcement silently disabled: the Soul DID's
   * identifier was missing from the runtime soul-membership set, so the
   * platform's `assertAgentInSoul()`-equivalent check returned
   * undefined-as-passing for every agent declared to belong to it. None of the
   * existing §7.2 rules caught it."
   *
   * This test proves Assertion 2 would have caught it at CI time.
   */
  it('reproduces the §4.2 reference platform failure: 6 souls, 1 missing from membership set', () => {
    const root = join(tmpDir, 'sec42-repro-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');

    // 6 Soul DIDs with contracts
    const allSouls = [
      'soul-consumer',
      'soul-professional',
      'soul-vulnerable',
      'soul-enterprise',
      'soul-dev',
      'soul-phantom',
    ];
    for (const soulId of allSouls) {
      writeTempJson(contractsDir, `${soulId}.json`, makeContract({ soulId }));
    }

    // Tessellation config has only 5 of the 6 souls — soul-phantom is missing
    writeTempJson(contractsDir, 'tessellation.json', {
      souls: allSouls.filter((s) => s !== 'soul-phantom'),
    });

    const result = runGate({ repoRoot: root });

    // The gate must detect the phantom-Soul failure
    assert.equal(result.passed, false, 'Gate should detect the phantom Soul DID');
    assert.equal(result.contractsFound, 6);

    const phantomFailure = result.failures.find(
      (f) => f.assertionId === 2 && f.soulId === 'soul-phantom',
    );
    assert.ok(phantomFailure, 'Should find Assertion-2 failure for soul-phantom');
    assert.match(phantomFailure.message, /phantom-Soul DID/i);
    assert.match(phantomFailure.message, /§4\.2/i);

    // The other 5 souls should pass Assertion 2
    const assertion2Results = result.failures.filter(
      (f) => f.assertionId === 2 && f.soulId !== 'soul-phantom',
    );
    assert.equal(assertion2Results.length, 0, 'Only soul-phantom should fail Assertion 2');
  });
});

// ── All 5 assertions composition ──────────────────────────────────────────────

describe('all 5 assertions — composition and interaction', () => {
  it('a fully-specified valid contract passes all 5 assertions', () => {
    const root = join(tmpDir, 'full-contract-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');

    writeTempJson(contractsDir, 'soul-full.json', {
      apiVersion: 'ai-sdlc/v1alpha1',
      kind: 'SubstrateContract',
      metadata: { name: 'soul-full' },
      spec: {
        soulId: 'soul-full',
        council: {
          director: 'agent-lead',
          agentIds: ['agent-lead', 'agent-backup', 'agent-support'],
        },
        compliance: {
          vulnerableAudience: true,
          locks: { requiresVulnerableAudienceLockout: true },
        },
        markerKeys: ['marker-alpha', 'marker-beta'],
        fields: [
          {
            name: 'observerCooldownMs',
            namedConsumer: 'substrate/cadence.ts#getCooldown',
            defaultFallback: 'falls back to 300000ms',
            identityClass: 'evolving',
          },
        ],
      },
    });
    writeTempJson(contractsDir, 'tessellation.json', {
      souls: ['soul-full', 'soul-other'],
    });
    writeTempJson(contractsDir, 'marker-registry.json', {
      markers: ['marker-alpha', 'marker-beta', 'marker-gamma'],
    });

    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, true, `Failures: ${JSON.stringify(result.failures)}`);
    assert.equal(result.failures.length, 0);
  });

  it('each assertion failure is independent — all caught even when multiple fail', () => {
    const root = join(tmpDir, 'multi-fail-' + Date.now());
    mkdirSync(join(root, 'substrate-contracts'), { recursive: true });
    const contractsDir = join(root, 'substrate-contracts');

    // This contract has problems on 4 of 5 assertions:
    // Assertion 1: filename 'wrong-key.json' ≠ soulId 'right-id'  → FAIL
    // Assertion 2: soulId 'right-id' not in tessellation souls[]   → FAIL
    // Assertion 3: vulnerableAudience=true but lock missing         → FAIL
    // Assertion 4: director 'ghost' not in agentIds                → FAIL
    // Assertion 5: no markerKeys → SKIP (pass)
    writeTempJson(contractsDir, 'wrong-key.json', {
      apiVersion: 'ai-sdlc/v1alpha1',
      kind: 'SubstrateContract',
      metadata: { name: 'wrong-key' },
      spec: {
        soulId: 'right-id',
        council: { director: 'ghost', agentIds: ['agent-a'] },
        compliance: { vulnerableAudience: true, locks: {} },
      },
    });
    writeTempJson(contractsDir, 'tessellation.json', { souls: ['other-soul'] });

    const result = runGate({ repoRoot: root });
    assert.equal(result.passed, false);
    const assertionIds = result.failures.map((f) => f.assertionId).sort();
    assert.ok(assertionIds.includes(1), 'Assertion 1 must fail');
    assert.ok(assertionIds.includes(2), 'Assertion 2 must fail');
    assert.ok(assertionIds.includes(3), 'Assertion 3 must fail');
    assert.ok(assertionIds.includes(4), 'Assertion 4 must fail');
  });
});
