import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, utimesSync } from 'node:fs';
import { acquireIngestLock, ingestIntervalMs } from './ingest-lock.js';
import { ingestClaudeTranscripts } from './ingest-claude.js';
import { launchUsageIngestDetached } from './launch.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-launch-'));
});
afterEach(() => removeFixtureDir(dir));

const fastEnv = (): NodeJS.ProcessEnv => ({
  AI_SDLC_USAGE_INGEST_INTERVAL_MS: '0',
  AI_SDLC_USAGE_DIR: join(dir, 'u'),
});

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
    expect(launchUsageIngestDetached({ binPath: bin, maxSeconds: 7, env: fastEnv() })).toBe(true);
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
    expect(launchUsageIngestDetached({ binPath: join(dir, 'missing.mjs'), env: fastEnv() })).toBe(
      false,
    );
  });

  it('swallows a bin that fails to run', async () => {
    const bin = join(dir, 'bad.mjs');
    writeFileSync(bin, 'throw new Error("boom");');
    expect(launchUsageIngestDetached({ binPath: bin, env: fastEnv() })).toBe(true);
  });

  it('spaces launches by the interval, injected clock and env override', () => {
    const bin = join(dir, 'noop.mjs');
    writeFileSync(bin, '');
    const usageDir = join(dir, 'u2');
    const at = (t: number, env: NodeJS.ProcessEnv = {}): boolean =>
      launchUsageIngestDetached({ binPath: bin, usageDir, env, now: () => t });
    const t0 = Date.now();
    expect(at(t0)).toBe(true);
    expect(at(t0 + 5_000)).toBe(false);
    expect(at(t0 + 21_000)).toBe(true);
    // env interval wins
    expect(at(t0 + 21_500, { AI_SDLC_USAGE_INGEST_INTERVAL_MS: '100' })).toBe(true);
    expect(at(t0 + 21_500, { AI_SDLC_USAGE_INGEST_INTERVAL_MS: '60000' })).toBe(false);
  });
});

describe('ingest lock', () => {
  it('only one of two holders runs; stale locks are taken over', () => {
    const d = join(dir, 'lock');
    const rel = acquireIngestLock(d);
    expect(rel).toBeDefined();
    expect(acquireIngestLock(d)).toBeUndefined();
    rel!();
    // dead pid
    writeFileSync(join(d, '.ingest.lock'), '2147483646');
    const r2 = acquireIngestLock(d);
    expect(r2).toBeDefined();
    r2!();
    // live pid but too old
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.ingest.lock'), String(process.pid));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(d, '.ingest.lock'), old, old);
    const r3 = acquireIngestLock(d);
    expect(r3).toBeDefined();
    r3!();
    expect(ingestIntervalMs({})).toBe(20_000);
    expect(ingestIntervalMs({ AI_SDLC_USAGE_INGEST_INTERVAL_MS: 'x' })).toBe(20_000);
  });

  it('a second ingest exits without reading files', async () => {
    const d = join(dir, 'lock2');
    const rel = acquireIngestLock(d)!;
    const res = await ingestClaudeTranscripts({
      usageDir: d,
      projectsDir: join(dir, 'p'),
      env: {},
    });
    expect(res.disabled).toBe('already-running');
    expect(res.filesScanned).toBe(0);
    rel();
  });
});
