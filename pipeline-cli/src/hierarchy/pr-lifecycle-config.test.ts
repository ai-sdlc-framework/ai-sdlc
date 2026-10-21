import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { load as yamlLoad } from 'js-yaml';

import {
  loadPrLifecycleConfig,
  PR_LIFECYCLE_DEFAULTS,
  PR_LIFECYCLE_KEY_READERS,
} from './pr-lifecycle-config.js';

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

describe('pr-lifecycle.yaml operational keys', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  it('every key under spec has a registered reader', () => {
    const doc = yamlLoad(
      readFileSync(path.join(repoRoot, '.ai-sdlc', 'pr-lifecycle.yaml'), 'utf-8'),
    ) as { spec: Record<string, unknown> };
    const unread = Object.keys(doc.spec).filter((k) => !(k in PR_LIFECYCLE_KEY_READERS));
    expect(unread).toEqual([]);
    for (const trust of ['docsOnlyPaths', 'releaseBranchPrefix', 'taskIdPattern']) {
      expect(doc.spec).not.toHaveProperty(trust);
    }
  });

  it('the shipped yaml loads to the code defaults', () => {
    expect(loadPrLifecycleConfig(repoRoot)).toEqual(PR_LIFECYCLE_DEFAULTS);
  });

  it('reads overrides and ignores invalid values', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'prlc-'));
    mkdirSync(path.join(d, '.ai-sdlc'));
    writeFileSync(
      path.join(d, '.ai-sdlc', 'pr-lifecycle.yaml'),
      'spec:\n  webhook: {port: 9000, debounceMs: -1}\n  stall: {staleMs: 5}\n  reconcile: {timerOpenMs: 7}\n',
    );
    const c = loadPrLifecycleConfig(d);
    rmSync(d, { recursive: true, force: true });
    expect(c.webhook).toEqual({ port: 9000, debounceMs: PR_LIFECYCLE_DEFAULTS.webhook.debounceMs });
    expect(c.stall).toEqual({ staleMs: 5, graceMs: PR_LIFECYCLE_DEFAULTS.stall.graceMs });
    expect(c.reconcile.timerOpenMs).toBe(7);
    for (const r of Object.values(PR_LIFECYCLE_KEY_READERS)) r(c);
  });
});
