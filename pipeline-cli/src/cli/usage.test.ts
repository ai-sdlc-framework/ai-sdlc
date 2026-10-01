import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

describe('cli-usage ingest output carries no transcript text', () => {
  const CANARY = 'SENTINEL-CANARY-CLI-TEXT';

  it('prints and writes no canary on normal and error paths (json and text)', async () => {
    const projects = fixture();
    const file = join(projects, 'p1', 's1.jsonl');
    appendFileSync(file, `{"type":"user","message":{"content":"${CANARY} tool output"}}\n`);
    appendFileSync(
      file,
      `{"type":"assistant","unknown":"${CANARY}","message":{"id":"u","model":"m","content":"${CANARY}","usage":{"input_tokens":1,"output_tokens":1},"newField":1},"timestamp":"2026-09-02T10:00:00Z"}\n`,
    );
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'user', pad: `${CANARY}${'x'.repeat(5 * 1024 * 1024)}` })}\n`,
    );
    appendFileSync(file, `{bad json ${CANARY}\n`);
    mkdirSync(join(projects, 'p1', 's1', 'subagents'), { recursive: true });
    writeFileSync(
      join(projects, 'p1', 's1', 'subagents', 'agent-a1.jsonl'),
      `{"type":"assistant","timestamp":"2026-09-02T10:00:00Z","message":{"id":"x1","model":"m","usage":{"output_tokens":1}}}\n{"type":"assistant","message":{"content":"${CANARY}`,
    );
    const errors: string[] = [];
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errors.push(String(c));
        return true;
      });
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        errors.push(a.map(String).join(' '));
      }),
    );
    try {
      await buildUsageCli(['ingest', '--projects-dir', projects, '--json']).parseAsync();
      await buildUsageCli(['ingest', '--projects-dir', projects, '--backfill']).parseAsync();
      await buildUsageCli([
        'ingest',
        '--projects-dir',
        join(root, 'missing'),
        '--json',
      ]).parseAsync();
    } finally {
      errSpy.mockRestore();
      for (const sp of consoleSpies) sp.mockRestore();
    }
    const all = [...writes, ...errors].join('\n');
    expect(all).toContain('callsWritten');
    expect(all).not.toContain('SENTINEL');
    for (const rel of readdirSync(join(root, 'usage'), { recursive: true }) as string[]) {
      const full = join(root, 'usage', rel);
      if (statSync(full).isFile())
        expect(readFileSync(full, 'utf-8'), rel).not.toContain('SENTINEL');
    }
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
