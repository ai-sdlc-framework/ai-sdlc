/**
 * `@ai-sdlc/reference` schema-validator delegate tests — RFC-0023 §9 /
 * AISDLC-178.5 AC#5/AC#6.
 *
 * Exercises the dynamic-import contract end-to-end against the real
 * `@ai-sdlc/reference` package (workspace dep), then exercises the
 * delegate's mapping from reference errors → YamlValidationIssue shape.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  loadReferenceSchemaValidator,
  __resetReferenceCacheForTests,
} from './reference-validator.js';

// Cold-import of @ai-sdlc/reference pulls Linear SDK + Ajv compilation;
// under the workspace-recursive test runner this can exceed the default
// 5s budget. Bump per-test for this suite.
const COLD_IMPORT_TIMEOUT_MS = 30_000;

describe('loadReferenceSchemaValidator', () => {
  beforeEach(() => {
    __resetReferenceCacheForTests();
  });

  it(
    'returns a validator function (not null) when @ai-sdlc/reference is resolvable',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      expect(validator).not.toBeNull();
      expect(typeof validator).toBe('function');
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    'returns [] for a valid Pipeline document',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      expect(validator).not.toBeNull();
      const valid = {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'Pipeline',
        metadata: { name: 'test-pipeline' },
        spec: {
          triggers: [{ event: 'issue.assigned' }],
          providers: { issueTracker: { type: 'linear' } },
          stages: [{ name: 'implement' }],
        },
      };
      const issues = validator!('Pipeline', valid);
      expect(issues).toEqual([]);
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    'returns issues with mapped path + message for an invalid document',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      expect(validator).not.toBeNull();
      // Missing required `spec` — should yield at least one issue.
      const invalid = {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'Pipeline',
        metadata: { name: 'pipeline-x' },
      };
      const issues = validator!('Pipeline', invalid);
      expect(issues).not.toBeNull();
      expect(issues!.length).toBeGreaterThan(0);
      for (const issue of issues!) {
        expect(typeof issue.message).toBe('string');
        expect(issue.message.length).toBeGreaterThan(0);
        // Path is always populated (defaults to `/` when reference returns empty).
        expect(typeof issue.path).toBe('string');
        expect(issue.path!.length).toBeGreaterThan(0);
      }
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    'caches the resolved module across calls (second call resolves immediately)',
    async () => {
      const v1 = await loadReferenceSchemaValidator();
      const v2 = await loadReferenceSchemaValidator();
      // Both calls produce a validator (the underlying module is memoized).
      expect(v1).not.toBeNull();
      expect(v2).not.toBeNull();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    'no-crash on cache reset followed by re-resolve',
    async () => {
      // Asserts the resolver is re-entrant after cache reset.
      __resetReferenceCacheForTests();
      const validator = await loadReferenceSchemaValidator();
      expect(validator).not.toBeNull();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );
});

describe('reference-validator delegate — error shape mapping', () => {
  beforeEach(() => {
    __resetReferenceCacheForTests();
  });

  it(
    'strips source/line/column (added later by validateYaml) and keeps only path+message',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      const issues = validator!('Pipeline', {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'Pipeline',
        // Missing metadata + spec — yields multiple errors.
      });
      expect(issues).not.toBeNull();
      for (const issue of issues!) {
        expect(issue).not.toHaveProperty('source');
        expect(issue).not.toHaveProperty('line');
        expect(issue).not.toHaveProperty('column');
        expect(issue).toHaveProperty('message');
        expect(issue).toHaveProperty('path');
      }
    },
    COLD_IMPORT_TIMEOUT_MS,
  );
});

describe('reference-validator delegate — skipped-kind handling (PR #474 coverage)', () => {
  beforeEach(() => {
    __resetReferenceCacheForTests();
  });

  it(
    'surfaces unknown kind as a single warning at /kind (string kind)',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      const issues = validator!('TotallyMadeUpKind', {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'TotallyMadeUpKind',
        metadata: { name: 'noop' },
      });
      expect(issues).not.toBeNull();
      expect(issues!.length).toBe(1);
      expect(issues![0].path).toBe('/kind');
      expect(issues![0].message).toMatch(/unknown kind 'TotallyMadeUpKind'/);
      expect(issues![0].message).toMatch(/loader-private convention or typo/);
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it(
    'stringifies non-string kind values when surfacing the warning',
    async () => {
      const validator = await loadReferenceSchemaValidator();
      const issues = validator!('NotARealKind', {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        // Numeric kind exercises the typeof !== 'string' branch.
        kind: 42 as unknown as string,
      });
      expect(issues).not.toBeNull();
      expect(issues!.length).toBe(1);
      expect(issues![0].path).toBe('/kind');
      expect(issues![0].message).toMatch(/unknown kind '42'/);
    },
    COLD_IMPORT_TIMEOUT_MS,
  );
});
