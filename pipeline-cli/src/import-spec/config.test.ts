import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdopterAuthoringConfig, resolveAdopterAuthoringPath } from './config.js';

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-auth-cfg-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('resolveAdopterAuthoringPath', () => {
  it('joins to .ai-sdlc/adopter-authoring.yaml under workDir', () => {
    expect(resolveAdopterAuthoringPath('/tmp/x')).toBe('/tmp/x/.ai-sdlc/adopter-authoring.yaml');
  });
});

describe('loadAdopterAuthoringConfig', () => {
  it('returns defaults when the file is absent', () => {
    withTmp((dir) => {
      const cfg = loadAdopterAuthoringConfig({ workDir: dir });
      expect(cfg.import.artifactGranularity).toBe('tasks-md-only');
      expect(cfg.import.dorStrictness).toBe('strict');
      expect(cfg.import.dorRejection).toBe('refuse-emit-clarification');
    });
  });

  it('reads a nested adopter-authoring: import: block', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
        [
          'adopter-authoring:',
          '  import:',
          '    artifactGranularity: tasks-md-only',
          '    dorStrictness: warn',
          '    dorRejection: refuse-emit-clarification',
        ].join('\n'),
        'utf8',
      );
      const cfg = loadAdopterAuthoringConfig({ workDir: dir });
      expect(cfg.import.dorStrictness).toBe('warn');
    });
  });

  it('reads a flat top-level import: block (convenience form)', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
        ['import:', '  dorStrictness: warn'].join('\n'),
        'utf8',
      );
      const cfg = loadAdopterAuthoringConfig({ workDir: dir });
      expect(cfg.import.dorStrictness).toBe('warn');
      // unset fields still fall through to defaults
      expect(cfg.import.dorRejection).toBe('refuse-emit-clarification');
    });
  });

  it('throws when the YAML is malformed', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
        '  not: : valid : yaml :::',
        'utf8',
      );
      expect(() => loadAdopterAuthoringConfig({ workDir: dir })).toThrow(/adopter-authoring/);
    });
  });

  it('falls back to defaults when YAML parses to null or non-object', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(dir, '.ai-sdlc', 'adopter-authoring.yaml'), '', 'utf8');
      const cfg = loadAdopterAuthoringConfig({ workDir: dir });
      expect(cfg.import.dorStrictness).toBe('strict');
    });
  });

  it('honours an explicit filePath override', () => {
    withTmp((dir) => {
      const altPath = join(dir, 'alt.yaml');
      writeFileSync(altPath, 'import:\n  dorStrictness: warn\n', 'utf8');
      const cfg = loadAdopterAuthoringConfig({ filePath: altPath });
      expect(cfg.import.dorStrictness).toBe('warn');
    });
  });

  it('rejects unknown values by falling back to defaults', () => {
    withTmp((dir) => {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
        ['import:', '  dorStrictness: yolo', '  artifactGranularity: spec-and-tasks'].join('\n'),
        'utf8',
      );
      const cfg = loadAdopterAuthoringConfig({ workDir: dir });
      expect(cfg.import.dorStrictness).toBe('strict');
      expect(cfg.import.artifactGranularity).toBe('tasks-md-only');
    });
  });
});
