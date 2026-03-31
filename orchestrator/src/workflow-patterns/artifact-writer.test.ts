import { describe, it, expect } from 'vitest';
import { writeArtifact } from './artifact-writer.js';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'ai-sdlc-artifact-test-' + Date.now());

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('writeArtifact', () => {
  it('writes file to correct path', () => {
    setup();
    const result = writeArtifact(TEST_DIR, '.claude/commands/auto-test.md', '# Test');

    expect(result.success).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    expect(readFileSync(result.filePath, 'utf-8')).toBe('# Test');
    cleanup();
  });

  it('creates parent directories', () => {
    setup();
    const result = writeArtifact(TEST_DIR, '.claude/skills/auto-build/SKILL.md', '# Skill');

    expect(result.success).toBe(true);
    expect(existsSync(join(TEST_DIR, '.claude/skills/auto-build'))).toBe(true);
    cleanup();
  });

  it('refuses to overwrite existing files', () => {
    setup();
    const filePath = join(TEST_DIR, 'existing.md');
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(filePath, 'original content');

    const result = writeArtifact(TEST_DIR, 'existing.md', 'new content');

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(readFileSync(filePath, 'utf-8')).toBe('original content');
    cleanup();
  });

  it('returns file path on success', () => {
    setup();
    const result = writeArtifact(TEST_DIR, 'test/output.yml', 'content');

    expect(result.filePath).toBe(join(TEST_DIR, 'test/output.yml'));
    cleanup();
  });

  it('handles write errors gracefully', () => {
    // Write to a path that can't be created (null byte in name)
    const result = writeArtifact('/nonexistent-root-path-12345', 'file.md', 'content');

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
