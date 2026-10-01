import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOTMENT_TOLERANCE,
  DEFAULT_MODEL_MIX_SIMILARITY,
  MACHINE_CONFIG_FILE,
  defaultUsageConfig,
  loadUsageConfig,
  parseUsageConfig,
  readUsageConfigFromBaseRef,
} from './usage-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function doc(spec: string): string {
  return `apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nmetadata:\n  name: usage\nspec:\n${spec}`;
}

const noBase = (): string | null => null;

describe('defaults', () => {
  it('applies the documented defaults with no file', () => {
    const c = loadUsageConfig({ dir, readBaseConfig: noBase });
    expect(c.source).toBe('defaults');
    expect(c.windows.map((w) => `${w.name}:${w.lengthHours}:${w.mode}`)).toEqual([
      'session:5:first-use',
      'weekly:168:trailing',
    ]);
    expect(c.allotmentTolerance).toBe(DEFAULT_ALLOTMENT_TOLERANCE);
    expect(c.modelMixSimilarity).toBe(DEFAULT_MODEL_MIX_SIMILARITY);
    expect(c.weights).toEqual({ tokenClasses: {}, modelFamilies: {} });
    expect(c.warnings).toEqual([]);
    expect(c.planName).toBeUndefined();
  });

  it('defaultUsageConfig returns independent copies', () => {
    const a = defaultUsageConfig();
    a.windows[0].name = 'changed';
    expect(defaultUsageConfig().windows[0].name).toBe('session');
  });
});

describe('parseUsageConfig', () => {
  it('reads plan, windows, weights and tolerance', () => {
    const c = parseUsageConfig(
      doc(
        [
          '  plan:',
          '    name: demo-plan',
          '    monthlyPriceUsd: 100',
          '  windows:',
          '    - name: week',
          '      lengthHours: 24',
          '      anchor: "2026-09-01T00:00:00Z"',
          '    - name: day',
          '      lengthHours: 24',
          '  weights:',
          '    tokenClasses:',
          '      output: 4',
          '    modelFamilies:',
          '      opus: 3',
          '  allotmentTolerance: 0.1',
          '  modelMixSimilarity: 0.9',
        ].join('\n'),
      ),
      'machine',
    );
    if (typeof c === 'string') throw new Error(c);
    expect(c.planName).toBe('demo-plan');
    expect(c.monthlyPriceUsd).toBe(100);
    expect(c.windows[0].mode).toBe('fixed');
    expect(c.windows[1].mode).toBe('trailing');
    expect(c.weights.tokenClasses.output).toBe(4);
    expect(c.weights.modelFamilies.opus).toBe(3);
    expect(c.allotmentTolerance).toBe(0.1);
    expect(c.modelMixSimilarity).toBe(0.9);
  });

  it('rejects invalid documents with a reason', () => {
    expect(parseUsageConfig('a: [', 'machine')).toBe('not valid YAML');
    expect(parseUsageConfig(doc('  allotmentTolerance: -1'), 'machine')).toMatch(
      /allotmentTolerance/,
    );
    expect(parseUsageConfig('kind: Other\n', 'machine')).toEqual(expect.any(String));
    expect(
      parseUsageConfig(
        doc('  windows:\n    - name: w\n      lengthHours: 2\n      mode: fixed'),
        'machine',
      ),
    ).toMatch(/needs an anchor/);
  });

  it('accepts an empty spec', () => {
    const c = parseUsageConfig(doc('  {}'), 'base-ref');
    expect(typeof c).not.toBe('string');
  });
});

describe('precedence', () => {
  const base = doc('  plan:\n    name: from-base');
  const machine = doc('  plan:\n    name: from-machine');

  it('reads the base ref when there is no machine file', () => {
    const c = loadUsageConfig({ dir, readBaseConfig: () => base });
    expect(c.source).toBe('base-ref');
    expect(c.planName).toBe('from-base');
  });

  it('the machine file takes precedence over the base ref', () => {
    writeFileSync(join(dir, MACHINE_CONFIG_FILE), machine);
    const c = loadUsageConfig({ dir, readBaseConfig: () => base });
    expect(c.source).toBe('machine');
    expect(c.planName).toBe('from-machine');
  });

  it('skips an invalid machine file with a warning and falls through', () => {
    writeFileSync(join(dir, MACHINE_CONFIG_FILE), 'kind: [');
    const c = loadUsageConfig({ dir, readBaseConfig: () => base });
    expect(c.source).toBe('base-ref');
    expect(c.warnings[0]).toMatch(/machine-level usage config/);
  });

  it('an invalid base config falls back to defaults with a warning', () => {
    const c = loadUsageConfig({ dir, readBaseConfig: () => doc('  allotmentTolerance: 0') });
    expect(c.source).toBe('defaults');
    expect(c.warnings[0]).toMatch(/base ref/);
  });

  it('passes the working directory and base ref to the reader', () => {
    const seen: string[] = [];
    loadUsageConfig({
      dir,
      workDir: '/w',
      baseRef: 'origin/dev',
      readBaseConfig: (w, r) => {
        seen.push(w, r);
        return null;
      },
    });
    expect(seen).toEqual(['/w', 'origin/dev']);
  });
});

describe('readUsageConfigFromBaseRef', () => {
  it('reads the file as committed on the ref, not the working tree', () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    git('config', 'commit.gpgsign', 'false');
    execFileSync('mkdir', ['-p', join(dir, '.ai-sdlc')]);
    writeFileSync(join(dir, '.ai-sdlc', 'usage-config.yaml'), 'committed: true\n');
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
    writeFileSync(join(dir, '.ai-sdlc', 'usage-config.yaml'), 'edited: true\n');
    expect(readUsageConfigFromBaseRef(dir, 'main')).toBe('committed: true\n');
    expect(readUsageConfigFromBaseRef(dir, 'missing-ref')).toBeNull();
  });
});
