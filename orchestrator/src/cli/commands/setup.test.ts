/** First-run smoke test for `ai-sdlc setup` on a fresh repository (AISDLC-1178). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSetup, renderSetupReport, type SetupAdapters } from './setup.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function adapters(over: Partial<SetupAdapters> = {}): SetupAdapters {
  return {
    runInit: (d) => {
      mkdirSync(join(d, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(d, '.ai-sdlc', 'pipeline.yaml'), 'x');
      return { exitCode: 0, output: '' };
    },
    runDoctor: () => ({ exitCode: 0, output: '' }),
    ...over,
  };
}

describe('ai-sdlc setup', () => {
  it('first run on a fresh repo inits, registers MCP and runs doctor', () => {
    const r = runSetup(dir, adapters());
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    expect(byId.init.status).toBe('done');
    expect(byId.mcp.status).toBe('done');
    expect(byId.doctor.status).toBe('done');
    expect(byId['signing-key'].status).toBe('skipped');
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(false);
  });

  it('second run changes nothing and says so', () => {
    runSetup(dir, adapters());
    const r = runSetup(
      dir,
      adapters({
        runInit: () => {
          throw new Error('init must not rerun');
        },
      }),
    );
    expect(r.unchanged).toBe(true);
    expect(r.steps.find((s) => s.id === 'init')?.status).toBe('skipped');
    expect(r.steps.find((s) => s.id === 'mcp')?.status).toBe('skipped');
    expect(renderSetupReport(r).join('\n')).toContain('Nothing changed');
  });

  it('reports not-possible steps with a next action', () => {
    const r = runSetup(
      dir,
      adapters({
        runInit: () => ({ exitCode: 2, output: 'boom' }),
        runDoctor: () => ({ exitCode: 1, output: 'fail' }),
      }),
    );
    expect(r.ok).toBe(false);
    const bad = r.steps.filter((s) => s.status === 'not-possible');
    expect(bad.map((s) => s.id)).toEqual(['init', 'doctor']);
    expect(bad.every((s) => s.nextAction)).toBe(true);
    const text = renderSetupReport(r).join('\n');
    expect(text).toContain('next:');
    expect(text).toContain('Setup incomplete');
  });

  it('reports an MCP failure as not-possible', () => {
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers": 5}');
    const r = runSetup(dir, adapters());
    expect(r.steps.find((s) => s.id === 'mcp')?.status).toBe('not-possible');
  });
});
