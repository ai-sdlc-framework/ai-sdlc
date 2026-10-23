import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildContextCli } from './context.js';

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('cli-context validate', () => {
  it('passes on an empty project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    await buildContextCli(['validate', '--project-dir', dir]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('cli-context ingest-sections', () => {
  it('writes one entry per section under the tracked root and they validate', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cli-context-'));
    writeFileSync(join(dir, 'NOTES.md'), '# T\n\n## Why it exists\n\nBecause history.\n');
    await buildContextCli([
      'ingest-sections',
      'NOTES.md',
      '--project-dir',
      dir,
      '--observed',
      '2026-10-23',
    ]).parseAsync();
    expect(existsSync(join(dir, '.ai-sdlc/knowledge/process/why-it-exists.md'))).toBe(true);
    await buildContextCli(['validate', '--project-dir', dir]).parseAsync();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
