import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadJudgmentConfig,
  readJudgmentConfigFromBaseRef,
  JUDGMENT_CONFIG_PATH,
} from './config-loader.js';
import { resolveJudgmentConfig, disabledJudgmentConfig } from './config.js';

const VALID = `apiVersion: ai-sdlc.io/v1alpha1
kind: JudgmentConfig
metadata:
  name: t
spec:
  provider: jev
  model: jev-1.13.0
`;

describe('loadJudgmentConfig', () => {
  const read = (raw: string | null) => ({
    readBaseConfig: () => raw,
    env: {},
  });

  it('resolves defaults when a provider is named', () => {
    const c = loadJudgmentConfig(read(VALID));
    expect(c.provider).toBe('jev');
    expect(c.egressAllow).toEqual(['work-item-text']);
    expect(c.defaults.mode).toBe('shadow');
  });

  it('is disabled for a missing, unparseable or schema-invalid file', () => {
    expect(loadJudgmentConfig(read(null))).toEqual(disabledJudgmentConfig());
    expect(loadJudgmentConfig(read('a: [unclosed'))).toEqual(disabledJudgmentConfig());
    expect(loadJudgmentConfig(read(VALID.replace('JudgmentConfig', 'Other')))).toEqual(
      disabledJudgmentConfig(),
    );
    expect(loadJudgmentConfig(read(VALID + '  egress:\n    allow: [nope]\n'))).toEqual(
      disabledJudgmentConfig(),
    );
  });

  it('never throws when the reader throws', () => {
    const c = loadJudgmentConfig({
      env: {},
      readBaseConfig: () => {
        throw new Error('x');
      },
    });
    expect(c).toEqual(disabledJudgmentConfig());
  });

  it('AI_SDLC_JUDGMENT=off disables the layer', () => {
    const c = loadJudgmentConfig({ ...read(VALID), env: { AI_SDLC_JUDGMENT: 'off' } });
    expect(c).toEqual(disabledJudgmentConfig());
  });

  it('AI_SDLC_JUDGMENT_CONFIG_PATH reads a local file instead of the base ref', () => {
    const c = loadJudgmentConfig({
      env: { AI_SDLC_JUDGMENT_CONFIG_PATH: '/some/file.yaml' },
      readBaseConfig: () => {
        throw new Error('base ref must not be read');
      },
      readLocalFile: (p) => (p === '/some/file.yaml' ? VALID : null),
    });
    expect(c.provider).toBe('jev');
    const missing = loadJudgmentConfig({
      env: { AI_SDLC_JUDGMENT_CONFIG_PATH: '/nope.yaml' },
    });
    expect(missing).toEqual(disabledJudgmentConfig());
  });

  it('reads a real local file through the env path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'judgment-cfg-'));
    try {
      const file = join(dir, 'c.yaml');
      writeFileSync(file, VALID);
      expect(loadJudgmentConfig({ env: { AI_SDLC_JUDGMENT_CONFIG_PATH: file } }).provider).toBe(
        'jev',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('against a real git repo', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd,
        stdio: 'ignore',
      });

    it('ignores a working-tree copy and reads the committed base ref', () => {
      const dir = mkdtempSync(join(tmpdir(), 'judgment-git-'));
      try {
        git(dir, 'init', '-q', '-b', 'main');
        writeFileSync(join(dir, 'README.md'), 'x');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'init');
        // No config on the base ref; a working-tree copy exists and must be ignored.
        mkdirSync(join(dir, '.ai-sdlc'));
        writeFileSync(join(dir, JUDGMENT_CONFIG_PATH), VALID);
        expect(loadJudgmentConfig({ workDir: dir, baseRef: 'main', env: {} })).toEqual(
          disabledJudgmentConfig(),
        );
        // Once committed on the base ref it is read.
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'cfg');
        expect(loadJudgmentConfig({ workDir: dir, baseRef: 'main', env: {} }).provider).toBe('jev');
        // A different working-tree edit does not change what is read.
        writeFileSync(join(dir, JUDGMENT_CONFIG_PATH), VALID.replace('jev', 'other'));
        expect(loadJudgmentConfig({ workDir: dir, baseRef: 'main', env: {} }).provider).toBe('jev');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null for a missing ref, an option-like ref, or a non-repo', () => {
      const dir = mkdtempSync(join(tmpdir(), 'judgment-nogit-'));
      try {
        expect(readJudgmentConfigFromBaseRef(dir, 'origin/main')).toBeNull();
        expect(readJudgmentConfigFromBaseRef(dir, '--output=x')).toBeNull();
        expect(readJudgmentConfigFromBaseRef(dir, '')).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('resolveJudgmentConfig', () => {
  it('is disabled with no provider or no doc', () => {
    expect(resolveJudgmentConfig({ spec: {} })).toEqual(disabledJudgmentConfig());
    expect(resolveJudgmentConfig(null)).toEqual(disabledJudgmentConfig());
  });

  it('carries judgments, thresholds and promotion', () => {
    const c = resolveJudgmentConfig({
      spec: {
        provider: 'p',
        egress: { allow: ['code-diff', 'bogus'] },
        defaults: { mode: 'off', timeoutMs: 5, cache: true },
        judgments: { a: { mode: 'enforce' }, b: { thresholds: { 'p@m': { x: 1 } } } },
      },
    });
    expect(c.egressAllow).toEqual(['code-diff']);
    expect(c.defaults).toEqual({ mode: 'off', timeoutMs: 5, cache: true });
    expect(c.judgments.a.thresholds).toEqual({});
    expect(c.judgments.b.thresholds['p@m']).toEqual({ x: 1 });
  });
});
