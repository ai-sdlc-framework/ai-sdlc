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

  describe('drift-handling slice (RFC-0036 Phase 6 / AISDLC-331)', () => {
    it('defaults to auto-sync for typoCosmetic + defer-24h-window for semanticScope', () => {
      withTmp((dir) => {
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.driftHandling.typoCosmetic).toBe('auto-sync');
        expect(cfg.driftHandling.semanticScope).toBe('defer-24h-window');
      });
    });

    it('reads the nested adopter-authoring: drift-handling: severityThresholds: block', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          [
            'adopter-authoring:',
            '  drift-handling:',
            '    severityThresholds:',
            '      typoCosmetic: defer-24h-window',
            '      semanticScope: defer-24h-window',
          ].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.driftHandling.typoCosmetic).toBe('defer-24h-window');
        expect(cfg.driftHandling.semanticScope).toBe('defer-24h-window');
      });
    });

    it('accepts the flat top-level drift-handling: block (convenience form)', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          ['drift-handling:', '  typoCosmetic: defer-24h-window'].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.driftHandling.typoCosmetic).toBe('defer-24h-window');
        // unset field still falls through to default
        expect(cfg.driftHandling.semanticScope).toBe('defer-24h-window');
      });
    });

    it('rejects unknown drift action values by falling back to defaults', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          [
            'drift-handling:',
            '  severityThresholds:',
            '    typoCosmetic: yolo',
            '    semanticScope: wat',
          ].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.driftHandling.typoCosmetic).toBe('auto-sync');
        expect(cfg.driftHandling.semanticScope).toBe('defer-24h-window');
      });
    });
  });

  describe('rfc-scaffold slice (RFC-0036 Phase 2/9 / AISDLC-327/334)', () => {
    it('defaults rfcDir to "rfcs/" when the file is absent', () => {
      withTmp((dir) => {
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.rfcScaffold.rfcDir).toBe('rfcs/');
      });
    });

    it('reads the nested adopter-authoring: rfc-scaffold: block', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          ['adopter-authoring:', '  rfc-scaffold:', '    rfcDir: ../company-rfcs/'].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.rfcScaffold.rfcDir).toBe('../company-rfcs/');
      });
    });

    it('accepts the flat top-level rfc-scaffold: block (convenience form)', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          ['rfc-scaffold:', '  rfcDir: my-rfcs/'].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.rfcScaffold.rfcDir).toBe('my-rfcs/');
      });
    });

    it('falls back to default when rfcDir is empty or not a string', () => {
      withTmp((dir) => {
        mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
        writeFileSync(
          join(dir, '.ai-sdlc', 'adopter-authoring.yaml'),
          ['rfc-scaffold:', '  rfcDir: ""'].join('\n'),
          'utf8',
        );
        const cfg = loadAdopterAuthoringConfig({ workDir: dir });
        expect(cfg.rfcScaffold.rfcDir).toBe('rfcs/');
      });
    });
  });
});
