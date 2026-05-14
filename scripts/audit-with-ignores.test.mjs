/**
 * Tests for `scripts/audit-with-ignores.mjs` — AISDLC-264.
 *
 * Hermetic: all tests use injected inputs (mocked auditJson, ignores, logPath).
 * No real pnpm audit invocation. Tests cover:
 *   - Advisory filtering by severity
 *   - Suppression of advisories by active ignore entries
 *   - Expiry enforcement (expired entries do NOT suppress)
 *   - Blocking when no matching active ignore exists
 *   - Audit log append (file is created and appended)
 *   - Log directory auto-creation
 *   - isActive helper
 *   - partitionIgnores helper
 *   - extractAdvisories (both pnpm JSON shapes)
 *
 * Run with: node --test scripts/audit-with-ignores.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isActive,
  AuditGateError,
  validateIgnores,
  partitionIgnores,
  extractAdvisories,
  appendAuditLog,
  runAuditGate,
} from './audit-with-ignores.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE = '2099-12-31T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const NOW = new Date('2026-05-13T12:00:00Z');

/**
 * Minimal pnpm audit JSON — Shape A (legacy `advisories` key).
 * @param {Array<{id, severity, cves?, ghsas?, module_name?, title?}>} advisoryList
 * @returns {object}
 */
function makeAuditJsonA(advisoryList) {
  const advisories = {};
  for (const adv of advisoryList) {
    advisories[adv.id] = {
      id: adv.id,
      title: adv.title ?? `Advisory ${adv.id}`,
      severity: adv.severity,
      cves: adv.cves ?? [],
      ghsas: adv.ghsas ?? [],
      module_name: adv.module_name ?? 'some-package',
    };
  }
  return { advisories };
}

/**
 * Minimal pnpm audit JSON — Shape B (newer `vulnerabilities` key).
 * @param {Array<{name, severity, via?}>} vulnList
 * @returns {object}
 */
function makeAuditJsonB(vulnList) {
  const vulnerabilities = {};
  for (const v of vulnList) {
    vulnerabilities[v.name] = {
      severity: v.severity,
      via: v.via ?? [],
    };
  }
  return { vulnerabilities };
}

// ---------------------------------------------------------------------------
// isActive
// ---------------------------------------------------------------------------

describe('isActive()', () => {
  it('returns true when expiresAt is in the future', () => {
    assert.equal(isActive({ expiresAt: FUTURE }, NOW), true);
  });

  it('returns false when expiresAt is in the past', () => {
    assert.equal(isActive({ expiresAt: PAST }, NOW), false);
  });

  it('returns false when expiresAt equals now (expired at the boundary)', () => {
    assert.equal(isActive({ expiresAt: NOW.toISOString() }, NOW), false);
  });
});

// ---------------------------------------------------------------------------
// AISDLC-264 PR #473 review fixes #2 + #4: validateIgnores
// ---------------------------------------------------------------------------

describe('validateIgnores() — AISDLC-264 PR #473 hardening', () => {
  const VALID_ENTRY = {
    cveId: 'CVE-2024-12345',
    justification: 'transitive dep, no fix yet, monitoring upstream',
    expiresAt: FUTURE,
  };

  it('accepts a valid array of canonical entries', () => {
    assert.doesNotThrow(() => validateIgnores([VALID_ENTRY]));
  });
  it('accepts empty array', () => {
    assert.doesNotThrow(() => validateIgnores([]));
  });
  it('rejects non-array top-level (PR #473 fix #4)', () => {
    assert.throws(() => validateIgnores({}), AuditGateError);
    assert.throws(() => validateIgnores('string'), AuditGateError);
    assert.throws(() => validateIgnores(null), AuditGateError);
  });
  it('rejects "UNKNOWN" sentinel cveId (PR #473 fix #2 — primary attack)', () => {
    assert.throws(
      () => validateIgnores([{ ...VALID_ENTRY, cveId: 'UNKNOWN' }]),
      /invalid cveId.*UNKNOWN.*reserved/,
    );
  });
  it('accepts uppercase GHSA — case-insensitive (normalised to lowercase at lookup)', () => {
    // PR #473 review fix #3: regex is case-insensitive; partitionIgnores +
    // extractAdvisories lowercase to canonical so case mismatch can't break
    // suppression. Operators can write either case.
    assert.doesNotThrow(() =>
      validateIgnores([{ ...VALID_ENTRY, cveId: 'GHSA-ABCD-EFGH-IJKL' }]),
    );
  });
  it('rejects malformed CVE format', () => {
    assert.throws(
      () => validateIgnores([{ ...VALID_ENTRY, cveId: 'CVE-bad' }]),
      /invalid cveId/,
    );
  });
  it('accepts canonical lowercase GHSA', () => {
    assert.doesNotThrow(() =>
      validateIgnores([{ ...VALID_ENTRY, cveId: 'ghsa-abcd-efgh-ijkl' }]),
    );
  });
  it('rejects entry with short justification', () => {
    assert.throws(
      () => validateIgnores([{ ...VALID_ENTRY, justification: 'too short' }]),
      /justification/,
    );
  });
  it('rejects entry missing cveId', () => {
    assert.throws(
      () => validateIgnores([{ justification: 'long enough text here', expiresAt: FUTURE }]),
      /invalid cveId/,
    );
  });
  it('rejects entry with unparseable expiresAt', () => {
    assert.throws(
      () => validateIgnores([{ ...VALID_ENTRY, expiresAt: 'never' }]),
      /expiresAt/,
    );
  });
});

// ---------------------------------------------------------------------------
// partitionIgnores
// ---------------------------------------------------------------------------

describe('partitionIgnores()', () => {
  it('separates active and expired entries', () => {
    const ignores = [
      { cveId: 'CVE-2024-00001', justification: 'A', expiresAt: FUTURE },
      { cveId: 'CVE-2024-00002', justification: 'B', expiresAt: PAST },
      { cveId: 'GHSA-xxxx-yyyy-zzzz', justification: 'C', expiresAt: FUTURE },
    ];
    const { active, expired } = partitionIgnores(ignores, NOW);
    assert.equal(active.size, 2);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].cveId, 'CVE-2024-00002');
    // AISDLC-264 PR #473 review fix #3: keys are lowercased at storage so
    // case-mismatch between operator-written cveId and runtime-extracted ID
    // can't break suppression. See partitionIgnores for the rationale.
    assert.ok(active.has('cve-2024-00001'));
    assert.ok(active.has('ghsa-xxxx-yyyy-zzzz'));
  });

  it('returns empty active map and empty expired array when ignores list is empty', () => {
    const { active, expired } = partitionIgnores([], NOW);
    assert.equal(active.size, 0);
    assert.equal(expired.length, 0);
  });

  it('returns all-expired when everything is past', () => {
    const ignores = [
      { cveId: 'CVE-2024-00001', justification: 'A', expiresAt: PAST },
      { cveId: 'CVE-2024-00002', justification: 'B', expiresAt: PAST },
    ];
    const { active, expired } = partitionIgnores(ignores, NOW);
    assert.equal(active.size, 0);
    assert.equal(expired.length, 2);
  });
});

// ---------------------------------------------------------------------------
// extractAdvisories
// ---------------------------------------------------------------------------

describe('extractAdvisories() — Shape A (advisories key)', () => {
  it('returns empty array when no advisories', () => {
    const json = makeAuditJsonA([]);
    assert.deepEqual(extractAdvisories(json, 'high'), []);
  });

  it('includes advisories at or above minSeverity', () => {
    const json = makeAuditJsonA([
      { id: 1001, severity: 'critical', ghsas: ['GHSA-1111-2222-3333'] },
      { id: 1002, severity: 'high', cves: ['CVE-2024-00001'] },
      { id: 1003, severity: 'moderate' },
    ]);
    const results = extractAdvisories(json, 'high');
    assert.equal(results.length, 2);
  });

  it('excludes advisories below minSeverity', () => {
    const json = makeAuditJsonA([
      { id: 2001, severity: 'low' },
      { id: 2002, severity: 'info' },
    ]);
    assert.deepEqual(extractAdvisories(json, 'high'), []);
  });

  it('populates ids from ghsas and cves arrays', () => {
    const json = makeAuditJsonA([
      {
        id: 3001,
        severity: 'high',
        ghsas: ['GHSA-aaaa-bbbb-cccc'],
        cves: ['CVE-2024-99999'],
        module_name: 'vulnerable-pkg',
        title: 'Remote code execution',
      },
    ]);
    const [adv] = extractAdvisories(json, 'high');
    // AISDLC-264 PR #473 review fix #3: IDs are lowercased so they match
    // the lowercased active map keys.
    assert.ok(adv.ids.includes('ghsa-aaaa-bbbb-cccc'));
    assert.ok(adv.ids.includes('cve-2024-99999'));
    assert.equal(adv.affectedPackage, 'vulnerable-pkg');
    assert.equal(adv.title, 'Remote code execution');
  });

  it('falls back to advisory id string when no ghsas/cves', () => {
    const json = makeAuditJsonA([{ id: 4001, severity: 'high' }]);
    const [adv] = extractAdvisories(json, 'high');
    assert.ok(adv.ids.length > 0);
  });
});

describe('extractAdvisories() — Shape B (vulnerabilities key)', () => {
  it('extracts high+ advisories with GHSA from via url', () => {
    const json = makeAuditJsonB([
      {
        name: 'evil-dep',
        severity: 'high',
        via: [
          {
            url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
            title: 'Prototype pollution',
          },
        ],
      },
    ]);
    const results = extractAdvisories(json, 'high');
    assert.equal(results.length, 1);
    assert.ok(results[0].ids.includes('ghsa-xxxx-yyyy-zzzz'));
    assert.equal(results[0].affectedPackage, 'evil-dep');
  });

  it('filters out low severity in Shape B', () => {
    const json = makeAuditJsonB([
      {
        name: 'low-risk',
        severity: 'low',
        via: [{ url: 'https://github.com/advisories/GHSA-low1-low2-low3', title: 'Low risk' }],
      },
    ]);
    assert.deepEqual(extractAdvisories(json, 'high'), []);
  });

  it('handles transitive chain nodes (string via entries) without crashing', () => {
    const json = makeAuditJsonB([
      {
        name: 'transitive-dep',
        severity: 'high',
        via: ['direct-dep'], // string, not object
      },
    ]);
    // Should not throw; returns at least one entry.
    const results = extractAdvisories(json, 'high');
    assert.equal(results.length, 1);
    assert.ok(results[0].ids.includes('UNKNOWN'));
  });

  // AISDLC-264 PR #473 review fix #1 (CRITICAL): unrecognised shape used to
  // return empty (gate passed silently). Now throws AuditGateError → main
  // script catches + exits 2 (fail-closed).
  it('AISDLC-264 PR #473 fix #1: throws AuditGateError on unknown JSON shape', () => {
    assert.throws(
      () => extractAdvisories({ something: 'unexpected' }, 'high'),
      /unrecognised pnpm audit JSON shape/,
    );
  });
});

// ---------------------------------------------------------------------------
// appendAuditLog
// ---------------------------------------------------------------------------

describe('appendAuditLog()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-audit-log-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the directory and writes a JSON line', () => {
    const logPath = join(tmpDir, 'nested', 'dir', 'audit.jsonl');
    appendAuditLog(logPath, { foo: 'bar', num: 42 });
    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, 'utf-8');
    const line = JSON.parse(content.trim());
    assert.equal(line.foo, 'bar');
    assert.equal(line.num, 42);
  });

  it('appends multiple entries on successive calls', () => {
    const logPath = join(tmpDir, 'audit.jsonl');
    appendAuditLog(logPath, { run: 1 });
    appendAuditLog(logPath, { run: 2 });
    const content = readFileSync(logPath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].run, 1);
    assert.equal(lines[1].run, 2);
  });
});

// ---------------------------------------------------------------------------
// runAuditGate — integration-style
// ---------------------------------------------------------------------------

describe('runAuditGate()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-audit-gate-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 when there are no advisories', () => {
    const { exitCode, blockers } = runAuditGate({
      auditJson: makeAuditJsonA([]),
      ignores: [],
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 0);
    assert.equal(blockers.length, 0);
  });

  it('exits 1 when there are blocking advisories and no ignores', () => {
    const json = makeAuditJsonA([{ id: 1, severity: 'high', cves: ['CVE-2024-00001'] }]);
    const { exitCode, blockers } = runAuditGate({
      auditJson: json,
      ignores: [],
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 1);
    assert.equal(blockers.length, 1);
  });

  it('suppresses a blocking advisory when an active ignore entry matches', () => {
    const json = makeAuditJsonA([{ id: 1, severity: 'high', cves: ['CVE-2024-00001'] }]);
    const ignores = [
      {
        cveId: 'CVE-2024-00001',
        justification: 'No fix available, sandboxed environment.',
        expiresAt: FUTURE,
      },
    ];
    const { exitCode, blockers, suppressed } = runAuditGate({
      auditJson: json,
      ignores,
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 0);
    assert.equal(blockers.length, 0);
    assert.equal(suppressed.length, 1);
  });

  it('does NOT suppress an advisory when the ignore entry has expired', () => {
    const json = makeAuditJsonA([{ id: 1, severity: 'high', cves: ['CVE-2024-00001'] }]);
    const ignores = [
      {
        cveId: 'CVE-2024-00001',
        justification: 'Previously exempted.',
        expiresAt: PAST,
      },
    ];
    const { exitCode, blockers, expiredIgnores } = runAuditGate({
      auditJson: json,
      ignores,
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 1);
    assert.equal(blockers.length, 1);
    assert.equal(expiredIgnores.length, 1);
    assert.equal(expiredIgnores[0].cveId, 'CVE-2024-00001');
  });

  it('fails the gate when expired ignores exist even with no new advisories', () => {
    const ignores = [
      {
        cveId: 'CVE-2024-99999',
        justification: 'Old exemption that expired.',
        expiresAt: PAST,
      },
    ];
    const { exitCode, expiredIgnores } = runAuditGate({
      auditJson: makeAuditJsonA([]),
      ignores,
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 1, 'expired ignore alone should fail the gate');
    assert.equal(expiredIgnores.length, 1);
  });

  it('matches via GHSA id (advisory has GHSA, ignore entry uses same GHSA)', () => {
    const json = makeAuditJsonA([{ id: 2, severity: 'critical', ghsas: ['GHSA-aaaa-bbbb-cccc'] }]);
    const ignores = [
      {
        cveId: 'GHSA-aaaa-bbbb-cccc',
        justification: 'Mitigated by upstream advisory fix.',
        expiresAt: FUTURE,
      },
    ];
    const { exitCode, blockers, suppressed } = runAuditGate({
      auditJson: json,
      ignores,
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 0);
    assert.equal(blockers.length, 0);
    assert.equal(suppressed.length, 1);
  });

  it('writes an audit log entry on each run', () => {
    const logPath = join(tmpDir, '_audit', 'audit.jsonl');
    const json = makeAuditJsonA([{ id: 3, severity: 'high', cves: ['CVE-2024-00002'] }]);
    const ignores = [
      {
        cveId: 'CVE-2024-00002',
        justification: 'Protected by WAF; no fix available.',
        expiresAt: FUTURE,
      },
    ];
    runAuditGate({ auditJson: json, ignores, minSeverity: 'high', logPath, now: NOW });

    assert.ok(existsSync(logPath), 'audit.jsonl should be created');
    const content = readFileSync(logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.advisoriesFound, 1);
    assert.equal(entry.suppressed, 1);
    assert.equal(entry.blockers, 0);
    assert.equal(entry.minSeverity, 'high');
  });

  it('appends audit log entries across multiple runs', () => {
    const logPath = join(tmpDir, '_audit', 'audit.jsonl');
    const json = makeAuditJsonA([]);
    runAuditGate({ auditJson: json, ignores: [], minSeverity: 'high', logPath, now: NOW });
    runAuditGate({ auditJson: json, ignores: [], minSeverity: 'high', logPath, now: NOW });
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  it('dry-run returns exitCode 0 even when blockers exist', () => {
    const json = makeAuditJsonA([{ id: 4, severity: 'high', cves: ['CVE-2024-00003'] }]);
    const { exitCode, blockers } = runAuditGate({
      auditJson: json,
      ignores: [],
      minSeverity: 'high',
      logPath: null,
      now: NOW,
      dryRun: true,
    });
    assert.equal(exitCode, 0);
    assert.equal(blockers.length, 1);
  });

  it('passes when advisory is below minSeverity', () => {
    const json = makeAuditJsonA([{ id: 5, severity: 'moderate', cves: ['CVE-2024-00004'] }]);
    const { exitCode, blockers } = runAuditGate({
      auditJson: json,
      ignores: [],
      minSeverity: 'high',
      logPath: null,
      now: NOW,
    });
    assert.equal(exitCode, 0);
    assert.equal(blockers.length, 0);
  });

  it('records expiredIgnores detail in the audit log', () => {
    const logPath = join(tmpDir, '_audit', 'audit.jsonl');
    const ignores = [
      { cveId: 'CVE-2024-99998', justification: 'Was exempted before.', expiresAt: PAST },
    ];
    runAuditGate({
      auditJson: makeAuditJsonA([]),
      ignores,
      minSeverity: 'high',
      logPath,
      now: NOW,
    });
    const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(entry.expiredIgnores, 1);
    assert.equal(entry.details.expiredIgnores[0].cveId, 'CVE-2024-99998');
  });
});
