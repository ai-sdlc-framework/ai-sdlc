/**
 * Unit tests for the CompliancePosture loader (RFC-0022 §9 Phase 1).
 *
 * Test matrix (AC #8):
 *  1. Schema validation — valid manifest validates and returns posture
 *  2. Schema validation — invalid manifest throws CompliancePostureValidationError
 *  3. Missing-attestation rejection — regime without attestedBy throws
 *  4. Missing-attestation rejection — regime without attestedAt throws
 *  5. Missing-override-notes rejection — derivedGates override without _notes throws
 *  6. Default-baseline returned when manifest is missing (AC #6)
 *  7. Loader returns CompliancePosture[] (single-element list in v1) per OQ-6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCompliancePosture } from './loader.js';
import {
  MissingComplianceAttestation,
  MissingDerivedGateOverrideNotes,
  CompliancePostureValidationError,
} from './errors.js';
import { BASELINE_POSTURE } from './types.js';

// ── Test fixtures ────────────────────────────────────────────────────────

const VALID_MANIFEST = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes:
    - id: SOC2-T2
      attestedBy: testuser@example.com
      attestedAt: "2026-05-16"
      attestedNotes: "Annual SOC2 audit program"
  auditExports:
    - kind: dsse-envelope
      format: json
      retentionPolicy:
        days: 365
        tier: hot
`.trim();

const VALID_MANIFEST_NO_REGIMES = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project-unregulated
spec:
  regimes: []
  auditExports: []
`.trim();

const VALID_MANIFEST_WITH_OVERRIDES = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project-with-overrides
spec:
  regimes:
    - id: SOC2-T2
      attestedBy: testuser@example.com
      attestedAt: "2026-05-16"
  derivedGates:
    databaseBranchPool: shared-with-rls
    _notes:
      databaseBranchPool: "Our auditor accepts shared-with-rls with quarterly policy review evidence (case #ABC-123)"
  auditExports: []
`.trim();

const MANIFEST_MISSING_ATTESTED_BY = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes:
    - id: HIPAA
      attestedAt: "2026-05-16"
  auditExports: []
`.trim();

const MANIFEST_MISSING_ATTESTED_AT = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes:
    - id: HIPAA
      attestedBy: testuser@example.com
  auditExports: []
`.trim();

const MANIFEST_OVERRIDE_WITHOUT_NOTES = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes:
    - id: SOC2-T2
      attestedBy: testuser@example.com
      attestedAt: "2026-05-16"
  derivedGates:
    databaseBranchPool: shared-with-rls
  auditExports: []
`.trim();

const MANIFEST_OVERRIDE_EMPTY_NOTES = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes:
    - id: SOC2-T2
      attestedBy: testuser@example.com
      attestedAt: "2026-05-16"
  derivedGates:
    databaseBranchPool: shared-with-rls
    _notes:
      databaseBranchPool: ""
  auditExports: []
`.trim();

const MANIFEST_SCHEMA_INVALID = `
apiVersion: ai-sdlc.io/v1alpha1
kind: CompliancePosture
metadata:
  name: test-project
spec:
  regimes: "not-an-array"
  auditExports: []
`.trim();

// ── Temp directory helpers ────────────────────────────────────────────────

let testDir: string;

function setupTestDir(): string {
  const dir = join(
    tmpdir(),
    `aisdlc-compliance-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function writeManifest(dir: string, content: string): void {
  writeFileSync(join(dir, '.ai-sdlc', 'compliance.yaml'), content, 'utf-8');
}

beforeEach(() => {
  testDir = setupTestDir();
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('loadCompliancePosture()', () => {
  // AC #6: Default baseline returned when manifest is missing
  describe('missing manifest → baseline', () => {
    it('returns baseline posture when compliance.yaml does not exist', () => {
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(BASELINE_POSTURE);
    });

    it('baseline posture has empty regimes array', () => {
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result[0].spec.regimes).toEqual([]);
    });

    it('baseline posture has kind CompliancePosture', () => {
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result[0].kind).toBe('CompliancePosture');
    });
  });

  // OQ-6: Loader returns CompliancePosture[] (single-element list in v1)
  describe('return type is CompliancePosture[]', () => {
    it('always returns an array', () => {
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns single-element array with valid manifest', () => {
      writeManifest(testDir, VALID_MANIFEST);
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('caller accesses gates via posture[0].spec.derivedGates', () => {
      writeManifest(testDir, VALID_MANIFEST_WITH_OVERRIDES);
      const result = loadCompliancePosture({ projectRoot: testDir });
      // v1: gate readers consume posture[0].spec.derivedGates
      expect(result[0].spec.derivedGates).toBeDefined();
      expect(result[0].spec.derivedGates?.databaseBranchPool).toBe('shared-with-rls');
    });
  });

  // AC #3: Schema validation
  describe('schema validation', () => {
    it('loads a valid manifest with regimes', () => {
      writeManifest(testDir, VALID_MANIFEST);
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result).toHaveLength(1);
      expect(result[0].metadata.name).toBe('test-project');
      expect(result[0].spec.regimes).toHaveLength(1);
      expect(result[0].spec.regimes[0].id).toBe('SOC2-T2');
    });

    it('loads a valid manifest with no regimes (none declared)', () => {
      writeManifest(testDir, VALID_MANIFEST_NO_REGIMES);
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result).toHaveLength(1);
      expect(result[0].spec.regimes).toEqual([]);
    });

    it('loads a valid manifest with derivedGates overrides + notes', () => {
      writeManifest(testDir, VALID_MANIFEST_WITH_OVERRIDES);
      const result = loadCompliancePosture({ projectRoot: testDir });
      expect(result).toHaveLength(1);
      expect(result[0].spec.derivedGates?.databaseBranchPool).toBe('shared-with-rls');
    });

    it('throws CompliancePostureValidationError when schema is invalid', () => {
      writeManifest(testDir, MANIFEST_SCHEMA_INVALID);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        CompliancePostureValidationError,
      );
    });

    it('CompliancePostureValidationError includes validation errors', () => {
      writeManifest(testDir, MANIFEST_SCHEMA_INVALID);
      try {
        loadCompliancePosture({ projectRoot: testDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CompliancePostureValidationError);
        const e = err as CompliancePostureValidationError;
        expect(e.validationErrors).toBeDefined();
        expect(e.validationErrors.length).toBeGreaterThan(0);
      }
    });

    it('throws CompliancePostureValidationError for unparseable YAML', () => {
      writeFileSync(join(testDir, '.ai-sdlc', 'compliance.yaml'), '{ invalid yaml: [', 'utf-8');
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        CompliancePostureValidationError,
      );
    });
  });

  // AC #5 (OQ-2): Missing attestation fields in regimes
  describe('missing attestation rejection', () => {
    it('throws MissingComplianceAttestation when attestedBy is missing', () => {
      writeManifest(testDir, MANIFEST_MISSING_ATTESTED_BY);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        MissingComplianceAttestation,
      );
    });

    it('MissingComplianceAttestation has correct regimeId and missingField for attestedBy', () => {
      writeManifest(testDir, MANIFEST_MISSING_ATTESTED_BY);
      try {
        loadCompliancePosture({ projectRoot: testDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MissingComplianceAttestation);
        const e = err as MissingComplianceAttestation;
        expect(e.regimeId).toBe('HIPAA');
        expect(e.missingField).toBe('attestedBy');
      }
    });

    it('throws MissingComplianceAttestation when attestedAt is missing', () => {
      writeManifest(testDir, MANIFEST_MISSING_ATTESTED_AT);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        MissingComplianceAttestation,
      );
    });

    it('MissingComplianceAttestation has correct regimeId and missingField for attestedAt', () => {
      writeManifest(testDir, MANIFEST_MISSING_ATTESTED_AT);
      try {
        loadCompliancePosture({ projectRoot: testDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MissingComplianceAttestation);
        const e = err as MissingComplianceAttestation;
        expect(e.regimeId).toBe('HIPAA');
        expect(e.missingField).toBe('attestedAt');
      }
    });
  });

  // AC #5 (OQ-2): Missing override notes for derivedGates
  describe('missing derivedGates override notes rejection', () => {
    it('throws MissingDerivedGateOverrideNotes when _notes is absent for overridden field', () => {
      writeManifest(testDir, MANIFEST_OVERRIDE_WITHOUT_NOTES);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        MissingDerivedGateOverrideNotes,
      );
    });

    it('MissingDerivedGateOverrideNotes has correct gateField', () => {
      writeManifest(testDir, MANIFEST_OVERRIDE_WITHOUT_NOTES);
      try {
        loadCompliancePosture({ projectRoot: testDir });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MissingDerivedGateOverrideNotes);
        const e = err as MissingDerivedGateOverrideNotes;
        expect(e.gateField).toBe('databaseBranchPool');
      }
    });

    it('throws MissingDerivedGateOverrideNotes when _notes entry is empty string', () => {
      writeManifest(testDir, MANIFEST_OVERRIDE_EMPTY_NOTES);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).toThrow(
        MissingDerivedGateOverrideNotes,
      );
    });

    it('does NOT throw when no derivedGates overrides are present', () => {
      writeManifest(testDir, VALID_MANIFEST);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).not.toThrow();
    });

    it('does NOT throw when all overridden fields have non-empty notes', () => {
      writeManifest(testDir, VALID_MANIFEST_WITH_OVERRIDES);
      expect(() => loadCompliancePosture({ projectRoot: testDir })).not.toThrow();
    });
  });

  // Options
  describe('options', () => {
    it('uses process.cwd() as projectRoot by default', () => {
      // Just verify it doesn't throw (it'll use the actual cwd which likely
      // has no compliance.yaml and return baseline)
      expect(() => loadCompliancePosture()).not.toThrow();
    });

    it('accepts a custom manifestPath option', () => {
      // Write manifest in a non-default location
      const customDir = join(testDir, 'custom');
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, 'posture.yaml'), VALID_MANIFEST, 'utf-8');

      const result = loadCompliancePosture({
        projectRoot: testDir,
        manifestPath: 'custom/posture.yaml',
      });
      expect(result).toHaveLength(1);
      expect(result[0].spec.regimes[0].id).toBe('SOC2-T2');
    });
  });
});

// ── Error class tests ─────────────────────────────────────────────────────

describe('MissingComplianceAttestation', () => {
  it('has correct name', () => {
    const err = new MissingComplianceAttestation('HIPAA', 'attestedBy');
    expect(err.name).toBe('MissingComplianceAttestation');
  });

  it('is an instance of Error', () => {
    const err = new MissingComplianceAttestation('SOC2-T2', 'attestedAt');
    expect(err).toBeInstanceOf(Error);
  });

  it('message includes regime id and missing field', () => {
    const err = new MissingComplianceAttestation('PCI-DSS-L1', 'attestedBy');
    expect(err.message).toContain('PCI-DSS-L1');
    expect(err.message).toContain('attestedBy');
  });
});

describe('MissingDerivedGateOverrideNotes', () => {
  it('has correct name', () => {
    const err = new MissingDerivedGateOverrideNotes('databaseBranchPool');
    expect(err.name).toBe('MissingDerivedGateOverrideNotes');
  });

  it('is an instance of Error', () => {
    const err = new MissingDerivedGateOverrideNotes('secretScanStrictness');
    expect(err).toBeInstanceOf(Error);
  });

  it('message includes gate field name', () => {
    const err = new MissingDerivedGateOverrideNotes('attestationRequired');
    expect(err.message).toContain('attestationRequired');
  });
});

describe('CompliancePostureValidationError', () => {
  it('has correct name', () => {
    const err = new CompliancePostureValidationError([{ path: '/', message: 'test' }]);
    expect(err.name).toBe('CompliancePostureValidationError');
  });

  it('is an instance of Error', () => {
    const err = new CompliancePostureValidationError([]);
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes validationErrors', () => {
    const errors = [{ path: '/spec/regimes', message: 'must be array' }];
    const err = new CompliancePostureValidationError(errors);
    expect(err.validationErrors).toEqual(errors);
  });
});
