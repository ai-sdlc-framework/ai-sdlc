import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadPrLifecycleConfig } from './pr-lifecycle-config.js';

describe('loadPrLifecycleConfig', () => {
  const dirs: string[] = [];
  const project = (body?: string): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'prlc-'));
    dirs.push(d);
    if (body !== undefined) {
      mkdirSync(path.join(d, '.ai-sdlc'));
      writeFileSync(path.join(d, '.ai-sdlc', 'pr-lifecycle.yaml'), body);
    }
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('defaults when the file or key is missing or invalid', () => {
    expect(loadPrLifecycleConfig(project()).maxSameHeadActions).toBe(1);
    expect(loadPrLifecycleConfig(project('spec: {}\n')).maxSameHeadActions).toBe(1);
    expect(
      loadPrLifecycleConfig(project('spec:\n  loopGuard:\n    maxSameHeadActions: 0\n'))
        .maxSameHeadActions,
    ).toBe(1);
    expect(loadPrLifecycleConfig(project(': : [')).maxSameHeadActions).toBe(1);
  });

  it('reads loopGuard.maxSameHeadActions', () => {
    const d = project('spec:\n  loopGuard:\n    maxSameHeadActions: 3\n');
    expect(loadPrLifecycleConfig(d).maxSameHeadActions).toBe(3);
  });
});
