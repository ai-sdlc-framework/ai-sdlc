import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchUsageIngestDetached } from './launch.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-launch-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(path: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('launchUsageIngestDetached', () => {
  it('starts the bin detached with a time limit and returns immediately', async () => {
    const marker = join(dir, 'ran.txt');
    const bin = join(dir, 'bin.mjs');
    writeFileSync(
      bin,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`,
    );
    const started = Date.now();
    expect(launchUsageIngestDetached({ binPath: bin, maxSeconds: 7, env: {} })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await waitFor(marker)).toBe(true);
  });

  it('does nothing in a remote sandbox, when switched off, or when the bin is missing', () => {
    const bin = join(dir, 'bin.mjs');
    writeFileSync(bin, '');
    expect(launchUsageIngestDetached({ binPath: bin, env: { CLAUDE_CODE_ENV: 'ccr' } })).toBe(
      false,
    );
    expect(launchUsageIngestDetached({ binPath: bin, env: { CLAUDE_REMOTE_EXECUTION: '1' } })).toBe(
      false,
    );
    expect(launchUsageIngestDetached({ binPath: bin, env: { AI_SDLC_USAGE_INGEST: 'off' } })).toBe(
      false,
    );
    expect(launchUsageIngestDetached({ binPath: join(dir, 'missing.mjs'), env: {} })).toBe(false);
  });

  it('swallows a bin that fails to run', async () => {
    const bin = join(dir, 'bad.mjs');
    writeFileSync(bin, 'throw new Error("boom");');
    expect(launchUsageIngestDetached({ binPath: bin, env: {} })).toBe(true);
  });
});
