/** AISDLC-1355: with no MCP client detected the report says so plainly. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('./mcp-setup.js', () => ({
  detectAgentsDetailed: () => ({ detected: [], skipped: [] }),
  installMcpServer: () => 'skipped',
}));

import { runSetup, renderSetupReport } from './setup.js';

describe('setup with no MCP client', () => {
  it('says no client was found and never "already registered"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-noclient-'));
    try {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(dir, '.ai-sdlc', 'pipeline.yaml'), 'x');
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(dir, '.github', 'workflows', 'ai-sdlc-gate.yml'), 'x');
      const r = runSetup(dir, {
        runInit: () => ({ exitCode: 0, output: '' }),
        runInitAdd: () => ({ exitCode: 0, output: '' }),
        runDoctor: () => ({ exitCode: 0, output: '' }),
        runCommand: () => ({ stdout: '', exitCode: 1 }),
        env: {},
      });
      const text = renderSetupReport(r).join('\n');
      expect(text).toContain('no MCP client was found');
      expect(text).not.toContain('already registered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
