/**
 * AISDLC-1279 — Orchestrator.health() must agree with `ai-sdlc validate`.
 * Uses the real config loader and validator against temp directories.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { PIPELINE_YAML } from './cli/commands/init.js';
import { formatOutput } from './cli/formatters/index.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'health-config-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function health(configDir: string) {
  const orch = new Orchestrator({ configDir });
  try {
    return await orch.health();
  } finally {
    orch.close();
  }
}

function render(r: Awaited<ReturnType<typeof health>>): string {
  return formatOutput('table', { type: 'health', ...r });
}

describe('Orchestrator.health() config validation (AISDLC-1279)', () => {
  it('reports unparseable YAML and names the file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'pipeline.yaml'), 'apiVersion: [unclosed\n  kind: : :\n');
    const r = await health(dir);
    expect(r.configValid).toBe(false);
    expect(r.errors.join('\n')).toContain('pipeline.yaml');
    expect(render(r)).not.toContain('Config:      valid');
  });

  it('reports a schema violation and names the file', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'pipeline.yaml'),
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline\nmetadata:\n  name: x\nspec:\n  triggers: not-a-list\n',
    );
    const r = await health(dir);
    expect(r.configValid).toBe(false);
    expect(r.errors.join('\n')).toContain('pipeline.yaml');
    expect(render(r)).not.toContain('Config:      valid');
  });

  it('reports a missing config directory', async () => {
    const r = await health(join(tmp(), 'nope'));
    expect(r.configValid).toBe(false);
    expect(r.errors.join('\n')).toContain('Config directory not found');
    expect(render(r)).not.toContain('Config:      valid');
  });

  it('is valid on the init pipeline scaffold', async () => {
    const dir = join(tmp(), '.ai-sdlc');
    mkdirSync(dir);
    writeFileSync(join(dir, 'pipeline.yaml'), PIPELINE_YAML);
    const r = await health(dir);
    expect(r.errors).toEqual([]);
    expect(r.configValid).toBe(true);
    expect(render(r)).toContain('Config:      valid');
  });
});
