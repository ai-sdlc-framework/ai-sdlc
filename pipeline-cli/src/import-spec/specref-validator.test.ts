/**
 * Tests for the RFC-0036 Phase 3 `specRef` field validator.
 *
 * Coverage contract (AC5):
 *  - validateSpecRef: present+valid, absent, malformed (missing required,
 *    bad enum, extra properties, non-object type)
 *  - checkSpecRefArtifactExists: file found, file missing, no artifactPath,
 *    null/undefined specRef, absolute path handling
 *
 * @module import-spec/specref-validator.test
 */

import { describe, expect, it } from 'vitest';

import {
  checkSpecRefArtifactExists,
  validateSpecRef,
  type SpecRefValue,
} from './specref-validator.js';

// ── validateSpecRef ──────────────────────────────────────────────────────────

describe('validateSpecRef — absent / null', () => {
  it('treats undefined as valid (field is optional)', () => {
    const result = validateSpecRef(undefined);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('treats null as valid (field is optional)', () => {
    const result = validateSpecRef(null);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('validateSpecRef — present + valid', () => {
  it('accepts a minimal specRef with only the required "source" field', () => {
    const specRef: SpecRefValue = { source: 'spec-kit' };
    const result = validateSpecRef(specRef);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts all enum values for "source"', () => {
    const sources = ['spec-kit', 'adopter-rfc', 'linear', 'notion', 'inline', 'other'] as const;
    for (const source of sources) {
      const result = validateSpecRef({ source });
      expect(result.valid).toBe(true);
    }
  });

  it('accepts a full spec-kit specRef with all optional fields', () => {
    const specRef: SpecRefValue = {
      source: 'spec-kit',
      featureId: 'auth-feature',
      taskId: 'T-007',
      artifactPath: '.specify/specs/auth-feature/tasks.md',
      contractsPath: '.specify/specs/auth-feature/contracts/auth-api.yaml',
      importedAt: '2026-05-13T15:00:00Z',
    };
    const result = validateSpecRef(specRef);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts an adopter-rfc specRef without optional artifact fields', () => {
    const result = validateSpecRef({ source: 'adopter-rfc', featureId: 'multi-tenancy' });
    expect(result.valid).toBe(true);
  });
});

describe('validateSpecRef — malformed', () => {
  it('rejects when "source" is missing (required field)', () => {
    const result = validateSpecRef({ featureId: 'auth-feature', taskId: 'T-1' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('required'))).toBe(true);
  });

  it('rejects an unknown "source" enum value', () => {
    const result = validateSpecRef({ source: 'jira' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('source'))).toBe(true);
  });

  it('rejects additional properties not in the schema', () => {
    const result = validateSpecRef({
      source: 'spec-kit',
      extraField: 'not-allowed',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('additional'))).toBe(true);
  });

  it('rejects a non-object specRef (string)', () => {
    const result = validateSpecRef('.specify/specs/tasks.md');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object specRef (number)', () => {
    const result = validateSpecRef(42);
    expect(result.valid).toBe(false);
  });

  it('rejects a non-object specRef (array)', () => {
    const result = validateSpecRef(['spec-kit']);
    expect(result.valid).toBe(false);
  });

  it('rejects an empty featureId (minLength: 1)', () => {
    const result = validateSpecRef({ source: 'spec-kit', featureId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('featureId'))).toBe(true);
  });

  it('rejects an empty taskId (minLength: 1)', () => {
    const result = validateSpecRef({ source: 'spec-kit', taskId: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('taskId'))).toBe(true);
  });

  it('rejects an empty artifactPath (minLength: 1)', () => {
    const result = validateSpecRef({ source: 'spec-kit', artifactPath: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('artifactPath'))).toBe(true);
  });

  it('returns all errors at once (allErrors mode)', () => {
    // Both source is wrong AND there is an extra field
    const result = validateSpecRef({ source: 'jira', unknownField: 'x' });
    expect(result.valid).toBe(false);
    // Should report at least 2 errors (bad enum + additionalProperties)
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── checkSpecRefArtifactExists ────────────────────────────────────────────────

describe('checkSpecRefArtifactExists — no specRef / no artifactPath', () => {
  it('returns found:true when specRef is undefined', () => {
    const result = checkSpecRefArtifactExists(undefined);
    expect(result.found).toBe(true);
    expect(result.infoMessage).toBeUndefined();
  });

  it('returns found:true when specRef is null', () => {
    const result = checkSpecRefArtifactExists(null);
    expect(result.found).toBe(true);
    expect(result.infoMessage).toBeUndefined();
  });

  it('returns found:true when specRef has no artifactPath', () => {
    const result = checkSpecRefArtifactExists({ source: 'spec-kit' });
    expect(result.found).toBe(true);
    expect(result.infoMessage).toBeUndefined();
  });
});

describe('checkSpecRefArtifactExists — file found', () => {
  it('returns found:true when existsFn returns true', () => {
    const result = checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: '.specify/specs/auth/tasks.md' },
      { workDir: '/project', existsFn: () => true },
    );
    expect(result.found).toBe(true);
    expect(result.infoMessage).toBeUndefined();
  });

  it('resolves a relative artifactPath against workDir', () => {
    const checked: string[] = [];
    checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: 'specs/tasks.md' },
      {
        workDir: '/repo',
        existsFn: (p) => {
          checked.push(p);
          return true;
        },
      },
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBe('/repo/specs/tasks.md');
  });

  it('uses an absolute artifactPath as-is', () => {
    const checked: string[] = [];
    checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: '/abs/path/tasks.md' },
      {
        workDir: '/repo',
        existsFn: (p) => {
          checked.push(p);
          return true;
        },
      },
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBe('/abs/path/tasks.md');
  });
});

describe('checkSpecRefArtifactExists — file missing (info-level)', () => {
  const missingFn = () => false;

  it('returns found:false when existsFn returns false', () => {
    const result = checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: '.specify/specs/missing/tasks.md' },
      { workDir: '/project', existsFn: missingFn },
    );
    expect(result.found).toBe(false);
  });

  it('populates resolvedPath on a cache miss', () => {
    const result = checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: 'specs/tasks.md' },
      { workDir: '/project', existsFn: missingFn },
    );
    expect(result.resolvedPath).toBe('/project/specs/tasks.md');
  });

  it('includes an info-level message on a cache miss', () => {
    const result = checkSpecRefArtifactExists(
      { source: 'spec-kit', artifactPath: 'specs/tasks.md' },
      { workDir: '/project', existsFn: missingFn },
    );
    expect(result.infoMessage).toBeDefined();
    expect(result.infoMessage).toContain('[specref-validator] info:');
    expect(result.infoMessage).toContain('specs/tasks.md');
  });

  it('never throws on a missing file (info-only, not blocking)', () => {
    expect(() =>
      checkSpecRefArtifactExists(
        { source: 'spec-kit', artifactPath: 'ghost.md' },
        { workDir: '/project', existsFn: missingFn },
      ),
    ).not.toThrow();
  });
});

// ── Backward-compatibility: tasks without specRef validate cleanly (AC4) ──────

describe('backward compatibility — native tasks without specRef', () => {
  it('validateSpecRef(undefined) is valid (no regression for native tasks)', () => {
    // This is the "absent specRef" case that native/operator-authored tasks hit.
    // It is also tested in the "absent / null" suite above; this copy makes the
    // AC4 story explicit so reviewers can find it easily.
    expect(validateSpecRef(undefined).valid).toBe(true);
  });

  it('checkSpecRefArtifactExists with no specRef is a no-op (no regression)', () => {
    // Native tasks pass undefined — no file check, no info message.
    const result = checkSpecRefArtifactExists(undefined, { existsFn: () => false });
    expect(result.found).toBe(true);
    expect(result.infoMessage).toBeUndefined();
  });
});
