import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf-8'));

describe('package.json orchestrator exports', () => {
  it('has a "./orchestrator" subpath export with types and import', () => {
    expect(pkg.exports['./orchestrator']).toEqual({
      types: './dist/orchestrator/index.d.ts',
      import: './dist/orchestrator/index.js',
    });
  });

  it('dist files referenced by "./orchestrator" export exist', () => {
    const orchestratorExport = pkg.exports['./orchestrator'];
    expect(existsSync(resolve(PKG_ROOT, orchestratorExport.types))).toBe(true);
    expect(existsSync(resolve(PKG_ROOT, orchestratorExport.import))).toBe(true);
  });

  it('orchestrator subpath re-exports expected symbols', async () => {
    const orchestrator = await import(
      resolve(PKG_ROOT, pkg.exports['./orchestrator'].import)
    );
    expect(orchestrator.loadConfig).toBeDefined();
    expect(orchestrator.validateIssue).toBeDefined();
    expect(orchestrator.parseComplexity).toBeDefined();
    expect(orchestrator.executePipeline).toBeDefined();
    expect(orchestrator.validateAgentOutput).toBeDefined();
    expect(orchestrator.createLogger).toBeDefined();
  });
});

// Type-level verification: these imports confirm the type exports compile.
// No runtime assertion needed — a compilation failure here means the types
// are not properly re-exported.
import type {
  AiSdlcConfig as _AiSdlcConfig,
  ExecuteOptions as _ExecuteOptions,
  ValidationContext as _ValidationContext,
  ValidationResult as _ValidationResult,
  ValidationViolation as _ValidationViolation,
  Logger as _Logger,
} from './index.js';
