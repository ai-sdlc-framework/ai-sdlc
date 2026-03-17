import { describe, it, expect } from 'vitest';
import * as runner from './index.js';

describe('runner barrel exports', () => {
  it('exports GitHubActionsRunner', () => {
    expect(runner.GitHubActionsRunner).toBeTypeOf('function');
  });

  it('exports ClaudeCodeRunner', () => {
    expect(runner.ClaudeCodeRunner).toBeTypeOf('function');
  });
});
