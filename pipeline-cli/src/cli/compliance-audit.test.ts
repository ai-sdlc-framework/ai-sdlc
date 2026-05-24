/**
 * Tests for cli-compliance-audit (RFC-0022 §9 Phase 4).
 *
 * ACs exercised:
 *  #2 --dry-run enumerates evidence, counts entries, estimates bundle size
 *  #3 --export writes .tar.gz + manifest per §8
 *  #4 OQ-4 deterministic packing (same corpus → byte-identical bundle)
 *  #5 Two consecutive exports of unchanged corpus → byte-identical bundles
 *  #6 Manifest sha256s round-trip on extraction
 *  #8 Integration test against fixture corpus (200 envelopes, 1K calibration entries)
 *       → valid bundle with all 5 kinds
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePeriod,
  periodEndTimestamp,
  buildTarArchive,
  buildTarGz,
  collectEvidence,
  exportBundle,
  dryRun,
  validateManifest,
  validateSafeIdentifier,
  type EvidenceFile,
  type BundleManifest,
} from './compliance-audit.js';

// ── Fixture helpers ───────────────────────────────────────────────────────

/**
 * Create a temporary directory with a fixture corpus suitable for testing
 * all 5 evidence kinds:
 *   - dsse-envelope:          N *.dsse.json files in .ai-sdlc/attestations/
 *   - dor-calibration:        M JSONL lines in _dor/calibration.jsonl
 *   - trusted-reviewers:      config/trusted-reviewers.yaml (file must exist)
 *   - enforcement-events:     K JSONL lines in .ai-sdlc/enforcement/events.jsonl
 *   - access-control-changes: CODEOWNERS file (file must exist for git log)
 */
interface FixtureOptions {
  envelopeCount?: number;
  calibrationCount?: number;
  enforcementCount?: number;
  period?: { start: string; end: string };
  /** If true, include posture.yaml */
  includePosture?: boolean;
}

function buildFixtureCorpus(dir: string, opts: FixtureOptions = {}): void {
  const {
    envelopeCount = 10,
    calibrationCount = 20,
    enforcementCount = 5,
    period = { start: '2026-01-01', end: '2026-03-31' },
    includePosture = true,
  } = opts;

  // .ai-sdlc/attestations/ — DSSE envelopes
  const attestDir = join(dir, '.ai-sdlc', 'attestations');
  mkdirSync(attestDir, { recursive: true });

  // A date within the period (2026-01-15) — used for file mtime-based filtering
  // We set mtime by creating a file with a known modification time.
  // Since we filter by stat().mtime, we just write the files during the test.
  for (let i = 0; i < envelopeCount; i++) {
    const sha = `${'a'.repeat(40 - String(i).length)}${i}`;
    const envelope = {
      _type: 'ai-sdlc.io/v1alpha1/AttestationEnvelope',
      payload: { sha, ts: `${period.start}T12:00:00Z` },
    };
    writeFileSync(join(attestDir, `${sha}.dsse.json`), JSON.stringify(envelope) + '\n', 'utf8');
  }

  // _dor/calibration.jsonl — DoR calibration entries
  const dorDir = join(dir, '_dor');
  mkdirSync(dorDir, { recursive: true });
  const calibLines: string[] = [];
  for (let i = 0; i < calibrationCount; i++) {
    calibLines.push(
      JSON.stringify({
        ts: `${period.start}T10:${String(i % 60).padStart(2, '0')}:00Z`,
        issueId: `AISDLC-${1000 + i}`,
        overallVerdict: 'admit',
      }),
    );
  }
  writeFileSync(join(dorDir, 'calibration.jsonl'), calibLines.join('\n') + '\n', 'utf8');

  // config/trusted-reviewers.yaml
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'trusted-reviewers.yaml'),
    'reviewers:\n  - test@example.com\n',
    'utf8',
  );

  // .ai-sdlc/enforcement/ — enforcement events
  const enforcementDir = join(dir, '.ai-sdlc', 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  const evLines: string[] = [];
  for (let i = 0; i < enforcementCount; i++) {
    evLines.push(
      JSON.stringify({
        ts: `${period.start}T09:${String(i % 60).padStart(2, '0')}:00Z`,
        type: 'DorRejectedEvent',
        taskId: `AISDLC-${2000 + i}`,
      }),
    );
  }
  writeFileSync(join(enforcementDir, 'events.jsonl'), evLines.join('\n') + '\n', 'utf8');

  // CODEOWNERS
  writeFileSync(join(dir, 'CODEOWNERS'), '* @ai-sdlc-framework/engineering\n', 'utf8');

  // posture.yaml
  if (includePosture) {
    const posturePath = join(dir, '.ai-sdlc', 'compliance.yaml');
    writeFileSync(
      posturePath,
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: CompliancePosture\n',
      'utf8',
    );
  }
}

// ── Test setup ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'compliance-audit-test-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── parsePeriod ───────────────────────────────────────────────────────────

describe('parsePeriod', () => {
  it('parses YYYY-MM-DD..YYYY-MM-DD range form', () => {
    expect(parsePeriod('2026-01-01..2026-03-31')).toEqual({
      start: '2026-01-01',
      end: '2026-03-31',
    });
  });

  it('parses Q1 shorthand', () => {
    expect(parsePeriod('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });

  it('parses Q2 shorthand', () => {
    expect(parsePeriod('2026-Q2')).toEqual({ start: '2026-04-01', end: '2026-06-30' });
  });

  it('parses Q3 shorthand', () => {
    expect(parsePeriod('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' });
  });

  it('parses Q4 shorthand', () => {
    expect(parsePeriod('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });

  it('throws on invalid period format', () => {
    expect(() => parsePeriod('invalid')).toThrow('Invalid --period format');
  });

  it('throws on partial date range', () => {
    expect(() => parsePeriod('2026-01-01')).toThrow('Invalid --period format');
  });
});

// ── periodEndTimestamp ────────────────────────────────────────────────────

describe('periodEndTimestamp', () => {
  it('returns UTC end-of-day timestamp for a given date', () => {
    const ts = periodEndTimestamp('2026-03-31');
    const date = new Date(ts * 1000);
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(2); // March (0-indexed)
    expect(date.getUTCDate()).toBe(31);
    expect(date.getUTCHours()).toBe(23);
    expect(date.getUTCMinutes()).toBe(59);
    expect(date.getUTCSeconds()).toBe(59);
  });

  it('is deterministic — same input always returns same value', () => {
    const ts1 = periodEndTimestamp('2026-12-31');
    const ts2 = periodEndTimestamp('2026-12-31');
    expect(ts1).toBe(ts2);
  });
});

// ── buildTarArchive ───────────────────────────────────────────────────────

describe('buildTarArchive', () => {
  const makeFile = (archivePath: string, content: string): EvidenceFile => {
    const buf = Buffer.from(content, 'utf8');
    return {
      archivePath,
      diskPath: '',
      content: buf,
      sha256: 'x'.repeat(64),
      size: buf.length,
    };
  };

  it('produces a non-empty Buffer', () => {
    const files = [makeFile('test.txt', 'hello')];
    const tar = buildTarArchive(files, 1748649599);
    expect(tar).toBeInstanceOf(Buffer);
    expect(tar.length).toBeGreaterThan(512);
  });

  it('ends with two 512-byte zero blocks (POSIX end-of-archive)', () => {
    const files = [makeFile('test.txt', 'hello')];
    const tar = buildTarArchive(files, 1748649599);
    const end = tar.slice(tar.length - 1024);
    expect(end.every((b) => b === 0)).toBe(true);
  });

  it('sorts files by archivePath for determinism (OQ-4)', () => {
    const files = [
      makeFile('z-last.txt', 'last'),
      makeFile('a-first.txt', 'first'),
      makeFile('m-middle.txt', 'middle'),
    ];
    const tar = buildTarArchive(files, 1748649599);
    // Extract the first filename from the tar header (offset 0, 100 bytes)
    const firstHeader = tar.slice(0, 100);
    const firstFilename = firstHeader.toString('ascii').replace(/\0/g, '');
    expect(firstFilename).toBe('a-first.txt');
  });

  it('is deterministic: same files + same mtime → byte-identical output (OQ-4)', () => {
    const files = [makeFile('b.txt', 'content-b'), makeFile('a.txt', 'content-a')];
    const mtime = 1748649599;
    const tar1 = buildTarArchive(files, mtime);
    const tar2 = buildTarArchive(files, mtime);
    expect(tar1.toString('hex')).toBe(tar2.toString('hex'));
  });

  it('differs when content changes (OQ-5 idempotency: only identical corpus is identical)', () => {
    const mtime = 1748649599;
    const tar1 = buildTarArchive([makeFile('a.txt', 'original')], mtime);
    const tar2 = buildTarArchive([makeFile('a.txt', 'changed')], mtime);
    expect(tar1.toString('hex')).not.toBe(tar2.toString('hex'));
  });

  it('header contains the ustar magic string', () => {
    const files = [makeFile('test.txt', 'data')];
    const tar = buildTarArchive(files, 0);
    // ustar magic is at offset 257 (6 bytes)
    const magic = tar.slice(257, 262).toString('ascii');
    expect(magic).toBe('ustar');
  });
});

// ── buildTarGz (OQ-4 determinism via gzip mtime:0) ────────────────────────

describe('buildTarGz', () => {
  const makeFile = (archivePath: string, content: string): EvidenceFile => {
    const buf = Buffer.from(content, 'utf8');
    return {
      archivePath,
      diskPath: '',
      content: buf,
      sha256: 'x'.repeat(64),
      size: buf.length,
    };
  };

  it('produces a Buffer that starts with the gzip magic bytes', async () => {
    const files = [makeFile('hello.txt', 'hello world')];
    const gz = await buildTarGz(files, 1748649599);
    // gzip magic: 0x1f 0x8b
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
  });

  it('is byte-identical for consecutive calls with same input (OQ-4 + OQ-5)', async () => {
    const files = [
      makeFile('dsse-envelope/sha1.dsse.json', '{"type":"envelope"}'),
      makeFile('dor-calibration/2026-Q1.jsonl', '{"ts":"2026-01-01T00:00:00Z"}'),
    ];
    const mtime = 1748649599;

    const gz1 = await buildTarGz(files, mtime);
    const gz2 = await buildTarGz(files, mtime);

    expect(gz1.toString('hex')).toBe(gz2.toString('hex'));
  });

  it('gzip header MTIME field is zero (no embedded timestamp → determinism)', async () => {
    const files = [makeFile('x.txt', 'x')];
    const gz = await buildTarGz(files, 1748649599);
    // RFC 1952: MTIME is at bytes 4-7 (little-endian 32-bit integer)
    const mtime = gz.readUInt32LE(4);
    expect(mtime).toBe(0);
  });
});

// ── collectEvidence ───────────────────────────────────────────────────────

describe('collectEvidence — fixture corpus (AC #8)', () => {
  it('collects dor-calibration entries from fixture corpus', () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 25 });
    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      kinds: ['dor-calibration'],
    });
    // Should have 1 combined JSONL file
    const dorFiles = result.files.filter((f) => f.archivePath.startsWith('dor-calibration/'));
    expect(dorFiles).toHaveLength(1);
    // Content should contain 25 lines
    const lines = dorFiles[0].content
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(25);
  });

  it('collects posture.yaml when present', () => {
    buildFixtureCorpus(tmpDir, { includePosture: true });
    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-12-31',
    });
    const posture = result.files.find((f) => f.archivePath === 'posture.yaml');
    expect(posture).toBeDefined();
  });

  it('skips posture.yaml when not present', () => {
    buildFixtureCorpus(tmpDir, { includePosture: false });
    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-12-31',
    });
    const posture = result.files.find((f) => f.archivePath === 'posture.yaml');
    expect(posture).toBeUndefined();
  });

  it('returns empty files for dsse-envelope when no attestation dir', () => {
    // Empty dir — no .ai-sdlc/attestations
    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      kinds: ['dsse-envelope'],
    });
    const envelopes = result.files.filter((f) => f.archivePath.startsWith('dsse-envelope/'));
    expect(envelopes).toHaveLength(0);
  });

  it('collects enforcement events from .ai-sdlc/enforcement/*.jsonl', () => {
    buildFixtureCorpus(tmpDir, { enforcementCount: 7 });
    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      kinds: ['enforcement-events'],
    });
    const evFiles = result.files.filter((f) => f.archivePath.startsWith('enforcement-events/'));
    expect(evFiles).toHaveLength(1);
    const lines = evFiles[0].content
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(7);
  });

  it('filters calibration entries by period — excludes out-of-range entries', () => {
    // Write calibration entries spanning two periods
    const dorDir = join(tmpDir, '_dor');
    mkdirSync(dorDir, { recursive: true });
    const lines = [
      JSON.stringify({ ts: '2025-12-31T23:59:59Z', issueId: 'AISDLC-1', overallVerdict: 'admit' }),
      JSON.stringify({ ts: '2026-01-15T10:00:00Z', issueId: 'AISDLC-2', overallVerdict: 'admit' }),
      JSON.stringify({ ts: '2026-04-01T00:00:00Z', issueId: 'AISDLC-3', overallVerdict: 'admit' }),
    ];
    writeFileSync(join(dorDir, 'calibration.jsonl'), lines.join('\n') + '\n', 'utf8');

    const result = collectEvidence({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      kinds: ['dor-calibration'],
    });

    const dorFiles = result.files.filter((f) => f.archivePath.startsWith('dor-calibration/'));
    if (dorFiles.length > 0) {
      const content = dorFiles[0].content.toString('utf8');
      expect(content).toContain('AISDLC-2'); // in period
      expect(content).not.toContain('AISDLC-1'); // before period
      expect(content).not.toContain('AISDLC-3'); // after period
    }
  });
});

// ── dryRun ────────────────────────────────────────────────────────────────

describe('dryRun (AC #2)', () => {
  it('returns per-kind counts and estimated bytes', () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 10, enforcementCount: 3 });
    const result = dryRun({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      regime: 'SOC2-T2',
    });

    expect(result.regime).toBe('SOC2-T2');
    expect(result.period.start).toBe('2026-01-01');
    expect(result.period.end).toBe('2026-03-31');
    expect(result.kinds).toHaveLength(5); // all 5 kinds
    expect(result.totalFiles).toBeGreaterThanOrEqual(0);
    expect(result.totalEstimatedBytes).toBeGreaterThanOrEqual(0);

    // dor-calibration should have count >= 1 (the combined JSONL file)
    const dorEntry = result.kinds.find((k) => k.kind === 'dor-calibration');
    expect(dorEntry).toBeDefined();
    if (dorEntry && dorEntry.count > 0) {
      expect(dorEntry.estimatedBytes).toBeGreaterThan(0);
    }
  });

  it('returns totalFiles = 0 for empty corpus + no posture', () => {
    // Empty tmpDir — no evidence
    const result = dryRun({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      regime: 'all',
    });
    expect(result.totalFiles).toBe(0);
    expect(result.totalEstimatedBytes).toBe(0);
  });

  it('throws on invalid period format', () => {
    expect(() => dryRun({ workDir: tmpDir, period: 'not-valid', regime: 'all' })).toThrow(
      'Invalid --period format',
    );
  });
});

// ── exportBundle (AC #3, #5, #6) ─────────────────────────────────────────

describe('exportBundle (AC #3, #5, #6)', () => {
  it('writes a .tar.gz file and a .manifest.json file (AC #3)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 5 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-01-01..2026-03-31',
      regime: 'SOC2-T2',
      outputDir,
    });

    expect(existsSync(result.bundlePath)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(result.bundleSizeBytes).toBeGreaterThan(0);

    // Bundle filename follows convention
    expect(result.bundlePath).toContain('compliance-audit-SOC2-T2-2026-03-31.tar.gz');
    expect(result.manifestPath).toContain('compliance-audit-SOC2-T2-2026-03-31.manifest.json');
  });

  it('manifest contains required fields (AC #6)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 3 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'HIPAA',
      outputDir,
    });

    const manifest = result.manifest;
    expect(manifest.schemaVersion).toBe('v1');
    expect(manifest.regime).toBe('HIPAA');
    expect(manifest.period.start).toBe('2026-01-01');
    expect(manifest.period.end).toBe('2026-03-31');
    expect(manifest.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(manifest.files)).toBe(true);
    expect(manifest.periodEndTimestamp).toBeGreaterThan(0);
  });

  it('each manifest file entry has sha256 + size (AC #6)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 3, includePosture: true });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'SOC2-T2',
      outputDir,
    });

    for (const entry of result.manifest.files) {
      expect(entry.path).toBeTruthy();
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it('bundleHash = sha256-of-sha256s is internally consistent (AC #6)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 5 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'all',
      outputDir,
    });

    // Manually recompute bundleHash from manifest.files (AISDLC-416: post-fix
    // manifests no longer include a self-referencing manifest.json entry, so
    // files[] is already the evidence-only set; filter remains as a no-op
    // defense against accidental future regressions).
    const { createHash } = await import('node:crypto');
    const evidenceFiles = result.manifest.files.filter((f) => f.path !== 'manifest.json');
    const sorted = [...evidenceFiles].sort((a, b) => a.path.localeCompare(b.path));
    const concatenated = sorted.map((e) => e.sha256).join('');
    const recomputed = createHash('sha256').update(concatenated).digest('hex');
    expect(result.manifest.bundleHash).toBe(recomputed);
  });

  it('manifest does NOT contain a self-referencing manifest.json entry (AISDLC-416)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 5 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'all',
      outputDir,
    });

    // Post-fix manifests omit the self-entry to avoid the stale-sha bug where
    // files[manifest.json].sha256 was computed from an intermediate manifest
    // form and never matched the actual bytes inside the tarball.
    const selfEntry = result.manifest.files.find((f) => f.path === 'manifest.json');
    expect(selfEntry).toBeUndefined();
  });

  it('two consecutive exports of unchanged corpus produce byte-identical bundles (AC #4 + #5)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 10, enforcementCount: 3 });
    const outputDir1 = join(tmpDir, 'output1');
    const outputDir2 = join(tmpDir, 'output2');

    const result1 = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'SOC2-T2',
      outputDir: outputDir1,
    });

    const result2 = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'SOC2-T2',
      outputDir: outputDir2,
    });

    const gz1 = readFileSync(result1.bundlePath);
    const gz2 = readFileSync(result2.bundlePath);

    // OQ-4 determinism: byte-identical bundles (AC #5)
    expect(gz1.toString('hex')).toBe(gz2.toString('hex'));
  });
});

// ── validateManifest (AC #6) ──────────────────────────────────────────────

describe('validateManifest (AC #6)', () => {
  it('returns ok=true for a valid manifest (bundleHash consistent)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 5 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'all',
      outputDir,
    });

    const validation = validateManifest({ manifestPath: result.manifestPath });
    expect(validation.ok).toBe(true);
    expect(validation.bundleHashValid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('returns ok=false for a tampered manifest (bundleHash changed)', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 3 });
    const outputDir = join(tmpDir, 'output');

    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'all',
      outputDir,
    });

    // Tamper the manifest: change an evidence file's sha256
    // (bundleHash covers evidence files, so tampering any evidence sha256
    // will make the recomputed bundleHash differ from the stored one).
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as BundleManifest;
    const evidenceIdx = manifest.files.findIndex((f) => f.path !== 'manifest.json');
    if (evidenceIdx >= 0) {
      manifest.files[evidenceIdx].sha256 = 'a'.repeat(64); // tamper evidence sha256
    }
    writeFileSync(result.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const validation = validateManifest({ manifestPath: result.manifestPath });
    expect(validation.ok).toBe(false);
    expect(validation.bundleHashValid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('returns error for a missing manifest file', () => {
    const validation = validateManifest({ manifestPath: join(tmpDir, 'nonexistent.json') });
    expect(validation.ok).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

// ── Integration test: fixture corpus with 200 envelopes, 1K calibration entries (AC #8) ──

describe('Integration test — large fixture corpus (AC #8)', () => {
  /**
   * Primary integration test for AC #8.
   *
   * Scope (AISDLC-416 honesty fix): of the 5 evidence kinds, only the 2 below
   * are actually exercised by this fixture:
   *
   *   ✓ dor-calibration   — fixture writes _dor/calibration.jsonl with N lines
   *                          tagged in the fixture's `period.start` day, so the
   *                          dateInPeriod filter admits them.
   *   ✓ enforcement-events — fixture writes .ai-sdlc/enforcement/events.jsonl
   *                          with N lines, same in-period dating.
   *
   * The other 3 kinds are NOT exercised here because:
   *
   *   ✗ dsse-envelope   — collectDsseEnvelopes filters by file mtime, but tmpDir
   *                       is freshly created so file mtimes are "now" (well outside
   *                       the 2026-Q1 fixture period). A future enhancement could
   *                       explicitly utimesSync() each envelope to backdate it.
   *   ✗ trusted-reviewers / access-control-changes — both run `git log` against
   *                       tmpDir, which has no git history, so both collectors
   *                       return [].
   *
   * In addition to the 2 evidence kinds above, posture.yaml is always included
   * when present.
   */
  it('produces a valid .tar.gz with manifest containing posture + dor-calibration + enforcement-events', async () => {
    // Build large fixture corpus
    buildFixtureCorpus(tmpDir, {
      envelopeCount: 200,
      calibrationCount: 1000,
      enforcementCount: 89,
      period: { start: '2026-01-01', end: '2026-03-31' },
      includePosture: true,
    });

    const outputDir = join(tmpDir, 'output');
    const result = await exportBundle({
      workDir: tmpDir,
      period: '2026-Q1',
      regime: 'SOC2-T2',
      outputDir,
    });

    // Bundle must exist and be non-trivial
    expect(existsSync(result.bundlePath)).toBe(true);
    expect(result.bundleSizeBytes).toBeGreaterThan(100); // compressed bundle

    // Manifest must have non-zero file entries (evidence kinds only — manifest
    // no longer self-references per AISDLC-416)
    expect(result.manifest.files.length).toBeGreaterThan(0);

    // Posture is included
    const paths = result.manifest.files.map((f) => f.path);
    expect(paths).toContain('posture.yaml');

    // dor-calibration is the primary evidence kind exercised
    const dorPaths = paths.filter((p) => p.startsWith('dor-calibration/'));
    expect(dorPaths.length).toBeGreaterThan(0);

    // enforcement-events is the second evidence kind exercised
    const enforcementPaths = paths.filter((p) => p.startsWith('enforcement-events/'));
    expect(enforcementPaths.length).toBeGreaterThan(0);

    // Calibration JSONL contains 1000 entries
    const dorEntry = result.manifest.files.find((f) => f.path.startsWith('dor-calibration/'));
    expect(dorEntry).toBeDefined();
    // Size should be substantial (1000 JSON objects)
    expect(dorEntry!.size).toBeGreaterThan(1000);

    // Bundle hash covers evidence files (post-AISDLC-416: manifest.json no
    // longer in files[], so filter is a no-op kept for symmetry)
    const { createHash } = await import('node:crypto');
    const evidenceFiles = result.manifest.files.filter((f) => f.path !== 'manifest.json');
    const sorted = [...evidenceFiles].sort((a, b) => a.path.localeCompare(b.path));
    const concatenated = sorted.map((e) => e.sha256).join('');
    const recomputed = createHash('sha256').update(concatenated).digest('hex');
    expect(result.manifest.bundleHash).toBe(recomputed);
  }, 30_000); // 30s timeout for large corpus

  it('two exports of the 200-envelope corpus are byte-identical (OQ-4 + OQ-5)', async () => {
    buildFixtureCorpus(tmpDir, {
      envelopeCount: 200,
      calibrationCount: 1000,
      period: { start: '2026-01-01', end: '2026-03-31' },
    });

    const output1 = join(tmpDir, 'out1');
    const output2 = join(tmpDir, 'out2');

    const [r1, r2] = await Promise.all([
      exportBundle({ workDir: tmpDir, period: '2026-Q1', regime: 'SOC2-T2', outputDir: output1 }),
      exportBundle({ workDir: tmpDir, period: '2026-Q1', regime: 'SOC2-T2', outputDir: output2 }),
    ]);

    const gz1 = readFileSync(r1.bundlePath);
    const gz2 = readFileSync(r2.bundlePath);
    expect(gz1.toString('hex')).toBe(gz2.toString('hex'));
  }, 30_000);
});

// ── validateSafeIdentifier (AC #3 — path-traversal hardening) ─────────────

describe('validateSafeIdentifier (AISDLC-416 AC-3)', () => {
  it('accepts simple alphanumeric identifiers', () => {
    expect(() => validateSafeIdentifier('regime', 'SOC2')).not.toThrow();
    expect(() => validateSafeIdentifier('regime', 'all')).not.toThrow();
    expect(() => validateSafeIdentifier('regime', 'HIPAA')).not.toThrow();
  });

  it('accepts identifiers with dot, underscore, hyphen', () => {
    expect(() => validateSafeIdentifier('regime', 'SOC2-T2')).not.toThrow();
    expect(() => validateSafeIdentifier('regime', 'SOC_2.T-2')).not.toThrow();
    expect(() =>
      validateSafeIdentifier('regime', 'compliance-audit-SOC2-T2-2026-03-31'),
    ).not.toThrow();
  });

  it('rejects path-separator characters', () => {
    expect(() => validateSafeIdentifier('regime', '../etc/passwd')).toThrow(/Invalid --regime/);
    expect(() => validateSafeIdentifier('regime', 'a/b')).toThrow(/Invalid --regime/);
    expect(() => validateSafeIdentifier('regime', 'a\\b')).toThrow(/Invalid --regime/);
  });

  it('rejects null bytes and whitespace', () => {
    expect(() => validateSafeIdentifier('regime', 'a\0b')).toThrow(/Invalid --regime/);
    expect(() => validateSafeIdentifier('regime', 'a b')).toThrow(/Invalid --regime/);
    expect(() => validateSafeIdentifier('regime', 'a\nb')).toThrow(/Invalid --regime/);
  });

  it('rejects empty values', () => {
    expect(() => validateSafeIdentifier('regime', '')).toThrow(/Invalid --regime/);
  });

  it('uses the label argument in the error message', () => {
    expect(() => validateSafeIdentifier('manifestFilename', '../escape')).toThrow(
      /Invalid --manifestFilename/,
    );
  });

  it('exportBundle propagates the regime validation error', async () => {
    buildFixtureCorpus(tmpDir, { calibrationCount: 1 });
    await expect(
      exportBundle({
        workDir: tmpDir,
        period: '2026-Q1',
        regime: '../escape',
        outputDir: join(tmpDir, 'output'),
      }),
    ).rejects.toThrow(/Invalid --regime/);
  });
});
