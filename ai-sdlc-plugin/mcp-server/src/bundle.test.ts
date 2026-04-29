/**
 * Smoke test for the bundled `dist/bin.js` artifact (AISDLC-75 AC #2).
 *
 * The plugin manifest spawns `node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/bin.js`
 * — so the committed bundle MUST run with no installed `node_modules/`. This
 * test does not move node_modules (which would race with parallel test runs);
 * instead it exercises a stronger invariant by spawning the bundle from a
 * tmpdir CWD with `NODE_PATH` cleared, so any `Cannot find module` regression
 * surfaces immediately.
 *
 * The deeper "really no node_modules" check lives in
 * `scripts/verify-bundle.mjs`, run as a CI gate (see `verify-bundle` script).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distBin = resolve(__dirname, '..', 'dist', 'bin.js');

describe('bundled dist/bin.js (AISDLC-75)', () => {
  beforeAll(() => {
    if (!existsSync(distBin)) {
      throw new Error(
        `dist/bin.js missing at ${distBin}. Run \`pnpm build\` before tests. ` +
          `Plugin marketplace clones do NOT run pnpm install — this file MUST be committed.`,
      );
    }
  });

  it('exists and is non-empty', () => {
    const size = statSync(distBin).size;
    // Sanity floor: the SDK + zod alone are >100KB. <50KB means bundling broke.
    expect(size).toBeGreaterThan(50_000);
  });

  it('starts with the shebang on line 1', () => {
    const head = readFileSync(distBin, 'utf-8').slice(0, 30);
    expect(head.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('contains the createRequire interop banner', () => {
    const head = readFileSync(distBin, 'utf-8').slice(0, 400);
    expect(head).toContain('createRequire');
  });

  it('is valid ESM (parses with node --check)', async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((res) => {
      const child = spawn(process.execPath, ['--check', distBin], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('exit', (code) => res({ code, stderr }));
    });
    expect(result.code, `node --check failed:\n${result.stderr}`).toBe(0);
  });

  it('responds to MCP initialize when spawned from an empty cwd', async () => {
    // Spawn with cwd = tmpdir so any accidental relative-path resolution
    // would fail loudly. NODE_PATH cleared so Node can't fall back to a
    // global module path.
    const cleanCwd = mkdtempSync(join(tmpdir(), 'ai-sdlc-bundle-smoke-'));
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (res) => {
        const child = spawn(process.execPath, [distBin], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: cleanCwd,
          env: { ...process.env, NODE_PATH: '' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        const initRpc = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'bundle-smoke', version: '1.0' },
          },
        });
        child.stdin.write(initRpc + '\n');
        setTimeout(() => child.stdin.end(), 200);
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          res({ stdout, stderr, code: -1 });
        }, 5000);
        child.on('exit', (code) => {
          clearTimeout(timeout);
          res({ stdout, stderr, code });
        });
      },
    );

    expect(result.stderr, 'spawned bundle wrote to stderr').not.toMatch(
      /Cannot find (module|package)/i,
    );
    expect(result.stdout).toContain('"jsonrpc":"2.0"');
    expect(result.stdout).toContain('"protocolVersion"');
  }, 10_000);
});
