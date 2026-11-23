import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pipelineCliBin, pipelineCliBinDir } from './bin-dir.js';

describe('pipelineCliBinDir (AISDLC-1359)', () => {
  it('is derived from the module, not the working directory', () => {
    const dir = pipelineCliBinDir();
    expect(path.basename(dir)).toBe('bin');
    expect(existsSync(pipelineCliBin('cli-usage.mjs'))).toBe(true);
    expect(existsSync(pipelineCliBin('cli-attestation.mjs'))).toBe(true);
    expect(existsSync(pipelineCliBin('cli-dispatch.mjs'))).toBe(true);
  });

  it('resolves from an explicit module url and directory', () => {
    expect(pipelineCliBinDir('file:///x/pkg/src/bin-dir.js')).toBe('/x/pkg/bin');
    expect(pipelineCliBin('a.mjs', '/d')).toBe('/d/a.mjs');
  });
});
