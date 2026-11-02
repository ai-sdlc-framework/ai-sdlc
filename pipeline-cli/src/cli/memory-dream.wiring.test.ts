import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMemoryDreamCli } from './memory-dream.js';

const original = process.argv;

afterEach(() => {
  process.argv = original;
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<string> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  });
  process.argv = ['node', 'cli-memory-dream', ...args];
  await runMemoryDreamCli();
  return chunks.join('');
}

describe('cli-memory-dream recover and backup wiring (AISDLC-1131)', () => {
  it('backup skips when the memory folder is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mem1131-cli-'));
    const out = await run(['backup', '--dir', join(root, 'missing'), '--project-dir', root]);
    expect(out).toContain('memory backup skipped');
  });

  it('recover runs against an empty transcripts folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mem1131-cli-'));
    const projects = mkdtempSync(join(tmpdir(), 'mem1131-proj-'));
    const out = await run([
      'recover',
      '--from-transcripts',
      projects,
      '--dir',
      join(root, 'memory'),
      '--project-dir',
      root,
    ]);
    expect(out.length).toBeGreaterThan(0);
  });
});
