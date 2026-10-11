import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfigFiles } from './validate-config.js';

const VALID = `apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
metadata:
  name: model-routing
spec:
  strength: [sonnet, opus]
  exploreShare: 0
  salt: s
  cells:
    developer:
      '*': { model: sonnet }
    security-reviewer:
      '*': { model: opus }
`;

describe('validateConfigFiles() with ModelRouting', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'validate-routing-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a valid ModelRouting document as valid', () => {
    writeFileSync(join(dir, 'model-routing.yaml'), VALID);
    const [r] = validateConfigFiles(dir);
    expect(r).toMatchObject({ file: 'model-routing.yaml', kind: 'ModelRouting', valid: true });
    expect(r.errors).toEqual([]);
  });

  it('reports an invalid ModelRouting document with errors', () => {
    writeFileSync(
      join(dir, 'model-routing.yaml'),
      VALID.replace('strength: [sonnet, opus]', 'strength: nope'),
    );
    const [r] = validateConfigFiles(dir);
    expect(r.kind).toBe('ModelRouting');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
