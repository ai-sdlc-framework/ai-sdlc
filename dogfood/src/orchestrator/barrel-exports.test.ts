import { describe, it, expect } from 'vitest';
import * as barrel from './index.js';

describe('orchestrator barrel exports', () => {
  it('exports loadConfigAsync', () => {
    expect(barrel.loadConfigAsync).toBeTypeOf('function');
  });

  it('exports startWatch', () => {
    expect(barrel.startWatch).toBeTypeOf('function');
  });

  it('exports parsePipelineManifest', () => {
    expect(barrel.parsePipelineManifest).toBeTypeOf('function');
  });

  it('exports buildPipelineDistribution', () => {
    expect(barrel.buildPipelineDistribution).toBeTypeOf('function');
  });

  it('continues to export loadConfig', () => {
    expect(barrel.loadConfig).toBeTypeOf('function');
  });
});
