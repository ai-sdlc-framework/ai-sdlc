/**
 * `ClaudeCliInlineSpawner` — unit tests (AISDLC-198).
 *
 * The spawner is exercised against a temp directory so tests can assert
 * the manifest is written correctly without touching real filesystem paths.
 * All tests use a deterministic `now` function so manifests are comparable.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeCliInlineSpawner,
  isManifestEmitted,
  resolveManifestPath,
  type DispatchManifest,
} from './claude-cli-inline.js';
import type { SpawnOpts } from '../../types.js';

const FIXED_NOW = '2026-05-05T00:00:00.000Z';
const fixedNow = () => FIXED_NOW;

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-198-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baseOpts: SpawnOpts = {
  type: 'developer',
  prompt: 'Implement the task.',
  cwd: '/project/.worktrees/aisdlc-123',
};

describe('ClaudeCliInlineSpawner', () => {
  describe('buildManifest', () => {
    it('produces the correct manifest shape', () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath: join(dir, 'manifest.json'),
          taskId: 'AISDLC-123',
          now: fixedNow,
        });
        const manifest = spawner.buildManifest(baseOpts);
        expect(manifest).toEqual<DispatchManifest>({
          version: 1,
          taskId: 'AISDLC-123',
          subagentType: 'developer',
          model: 'claude-sonnet-4-6',
          prompt: 'Implement the task.',
          cwd: '/project/.worktrees/aisdlc-123',
          runInBackground: false,
          emittedAt: FIXED_NOW,
        });
      } finally {
        cleanup();
      }
    });

    it('uses security-reviewer model for security reviewer type', () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath: join(dir, 'manifest.json'),
          taskId: 'AISDLC-123',
          now: fixedNow,
        });
        const manifest = spawner.buildManifest({ ...baseOpts, type: 'security-reviewer' });
        expect(manifest.model).toBe('claude-opus-4-6');
      } finally {
        cleanup();
      }
    });

    it('respects modelOverrides', () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath: join(dir, 'manifest.json'),
          taskId: 'AISDLC-123',
          now: fixedNow,
          modelOverrides: { developer: 'claude-opus-4-6' },
        });
        const manifest = spawner.buildManifest(baseOpts);
        expect(manifest.model).toBe('claude-opus-4-6');
      } finally {
        cleanup();
      }
    });

    it('emits null model for unknown subagent types', () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath: join(dir, 'manifest.json'),
          taskId: 'AISDLC-123',
          now: fixedNow,
        });
        // refinement-reviewer has no default model
        const manifest = spawner.buildManifest({ ...baseOpts, type: 'refinement-reviewer' });
        expect(manifest.model).toBeNull();
      } finally {
        cleanup();
      }
    });

    it('stamps empty taskId when not provided', () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath: join(dir, 'manifest.json'),
          now: fixedNow,
        });
        const manifest = spawner.buildManifest(baseOpts);
        expect(manifest.taskId).toBe('');
      } finally {
        cleanup();
      }
    });
  });

  describe('spawn', () => {
    it('writes the manifest to disk and returns manifest-emitted status', async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const manifestPath = join(dir, '_orchestrator', 'dispatch-manifest.json');
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath,
          taskId: 'AISDLC-123',
          now: fixedNow,
        });

        const result = await spawner.spawn(baseOpts);

        expect(result.status).toBe('manifest-emitted');
        expect(result.type).toBe('developer');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        // File should exist on disk
        const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as DispatchManifest;
        expect(onDisk.taskId).toBe('AISDLC-123');
        expect(onDisk.version).toBe(1);
        expect(onDisk.subagentType).toBe('developer');
      } finally {
        cleanup();
      }
    });

    it('returns the manifest on the result object', async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath,
          taskId: 'AISDLC-456',
          now: fixedNow,
        });

        const result = await spawner.spawn(baseOpts);

        expect(isManifestEmitted(result)).toBe(true);
        if (isManifestEmitted(result)) {
          expect(result.manifest.taskId).toBe('AISDLC-456');
          expect(result.manifest.version).toBe(1);
        }
      } finally {
        cleanup();
      }
    });

    it('creates parent directories automatically', async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        // Deep nested path — directories don't exist yet
        const manifestPath = join(dir, 'a', 'b', 'c', 'manifest.json');
        const spawner = new ClaudeCliInlineSpawner({ manifestPath, now: fixedNow });

        const result = await spawner.spawn(baseOpts);

        expect(result.status).toBe('manifest-emitted');
        // File should be on disk
        const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(onDisk.version).toBe(1);
      } finally {
        cleanup();
      }
    });

    it('returns error status when the manifest path is unwritable', async () => {
      // Use a path that cannot be created (file as directory parent)
      const { dir, cleanup } = makeTmpDir();
      try {
        // Write a regular file where we expect a directory (sync, not async import)
        writeFileSync(join(dir, 'not-a-dir'), '');
        const manifestPath = join(dir, 'not-a-dir', 'manifest.json');
        const spawner = new ClaudeCliInlineSpawner({ manifestPath, now: fixedNow });

        const result = await spawner.spawn(baseOpts);

        // Should return an error rather than throwing
        expect(result.status).toBe('error');
        expect(result.error).toContain('not-a-dir');
      } finally {
        cleanup();
      }
    });
  });

  describe('spawnParallel', () => {
    it('runs opts sequentially and returns results in order', async () => {
      const { dir, cleanup } = makeTmpDir();
      try {
        const manifestPath = join(dir, 'manifest.json');
        const spawner = new ClaudeCliInlineSpawner({
          manifestPath,
          taskId: 'AISDLC-123',
          now: fixedNow,
        });

        const opts: SpawnOpts[] = [
          { type: 'code-reviewer', prompt: 'Review code.', cwd: '/project' },
          { type: 'test-reviewer', prompt: 'Review tests.', cwd: '/project' },
          { type: 'security-reviewer', prompt: 'Review security.', cwd: '/project' },
        ];

        const results = await spawner.spawnParallel(opts);

        expect(results).toHaveLength(3);
        expect(results[0].type).toBe('code-reviewer');
        expect(results[1].type).toBe('test-reviewer');
        expect(results[2].type).toBe('security-reviewer');
        // All should be manifest-emitted (last one writes over the file)
        for (const r of results) {
          expect(r.status).toBe('manifest-emitted');
        }
      } finally {
        cleanup();
      }
    });
  });

  describe('isManifestEmitted', () => {
    it('returns true for manifest-emitted results', () => {
      const result = {
        type: 'developer' as const,
        output: '',
        status: 'manifest-emitted' as const,
        manifest: {} as DispatchManifest,
        durationMs: 0,
      };
      expect(isManifestEmitted(result)).toBe(true);
    });

    it('returns false for success results', () => {
      const result = {
        type: 'developer' as const,
        output: '{}',
        status: 'success' as const,
        durationMs: 0,
      };
      expect(isManifestEmitted(result)).toBe(false);
    });

    it('returns false for error results', () => {
      const result = {
        type: 'developer' as const,
        output: '',
        status: 'error' as const,
        error: 'oops',
        durationMs: 0,
      };
      expect(isManifestEmitted(result)).toBe(false);
    });
  });

  describe('resolveManifestPath', () => {
    it('returns the overridePath when provided', () => {
      expect(resolveManifestPath('/custom/path/manifest.json')).toBe('/custom/path/manifest.json');
    });

    it('falls back to ARTIFACTS_DIR env + default name', () => {
      const original = process.env.ARTIFACTS_DIR;
      try {
        process.env.ARTIFACTS_DIR = '/custom/artifacts';
        expect(resolveManifestPath()).toBe(
          '/custom/artifacts/_orchestrator/dispatch-manifest.json',
        );
      } finally {
        if (original === undefined) {
          delete process.env.ARTIFACTS_DIR;
        } else {
          process.env.ARTIFACTS_DIR = original;
        }
      }
    });

    it('falls back to <cwd>/artifacts when ARTIFACTS_DIR is unset', () => {
      const original = process.env.ARTIFACTS_DIR;
      try {
        delete process.env.ARTIFACTS_DIR;
        const result = resolveManifestPath();
        expect(result).toContain('/_orchestrator/dispatch-manifest.json');
        expect(result).toContain('artifacts');
      } finally {
        if (original !== undefined) {
          process.env.ARTIFACTS_DIR = original;
        }
      }
    });
  });
});
