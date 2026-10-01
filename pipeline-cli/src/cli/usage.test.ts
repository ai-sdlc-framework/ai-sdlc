import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUsageCli, renderIngestResult } from './usage.js';

let root: string;
let writes: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-usage-'));
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    writes.push(String(s));
    return true;
  });
  vi.stubEnv('AI_SDLC_USAGE_DIR', join(root, 'usage'));
  vi.stubEnv('CLAUDE_CODE_ENV', '');
  vi.stubEnv('CLAUDE_REMOTE_EXECUTION', '');
  vi.stubEnv('AI_SDLC_USAGE_INGEST', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const projects = join(root, 'projects');
  mkdirSync(join(projects, 'p1'), { recursive: true });
  writeFileSync(
    join(projects, 'p1', 's1.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-02T10:00:00Z',
      sessionId: 's1',
      cwd: join(root, 'elsewhere'),
      message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n`,
  );
  return projects;
}

describe('cli-usage ingest', () => {
  it('prints JSON counts', async () => {
    await buildUsageCli(['ingest', '--projects-dir', fixture(), '--json']).parseAsync();
    expect(JSON.parse(writes.join(''))).toMatchObject({
      filesScanned: 1,
      callsWritten: 1,
      repeatsSkipped: 0,
      errors: 0,
    });
  });

  it('prints a text summary', async () => {
    await buildUsageCli(['ingest', '--projects-dir', fixture(), '--backfill']).parseAsync();
    expect(writes.join('')).toContain('Calls written:   1');
  });

  it('explains a no-op in a remote sandbox', async () => {
    vi.stubEnv('CLAUDE_CODE_ENV', 'ccr');
    await buildUsageCli(['ingest', '--projects-dir', fixture()]).parseAsync();
    expect(writes.join('')).toContain('remote sandbox');
  });
});

describe('renderIngestResult', () => {
  const base = {
    filesScanned: 2,
    callsWritten: 1,
    repeatsSkipped: 3,
    errors: 0,
    limitEvents: 0,
    otherScopeSkipped: 4,
    timedOut: true,
  };
  it('mentions skipped other-scope and the time limit', () => {
    const out = renderIngestResult(base);
    expect(out).toContain('Other-scope skipped: 4');
    expect(out).toContain('time limit');
  });
  it('explains the switched-off state', () => {
    expect(renderIngestResult({ ...base, disabled: 'switched-off' })).toContain('switched off');
  });
});
