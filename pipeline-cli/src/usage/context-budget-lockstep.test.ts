/**
 * The Stop hook (`ai-sdlc-plugin/hooks/lib/context-budget.js`) is a standalone
 * script and cannot import the usage config loader, so it carries its own copy
 * of the role budget defaults, the budget parsing and the session-name rule.
 * This test loads both and asserts they agree.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_BUDGETS, parseUsageConfig, roleFromSessionName } from './usage-config.js';

const require = createRequire(import.meta.url);
const hook = require('../../../ai-sdlc-plugin/hooks/lib/context-budget.js') as {
  DEFAULT_ROLE_BUDGETS: unknown;
  CLEAR_HOOK_NAME: string;
  parseRoleBudgets: (yaml: string) => unknown;
  roleFromName: (name: string) => string | null;
};

describe('context budget lockstep with the Stop hook', () => {
  it('has the same default budgets', () => {
    expect(hook.DEFAULT_ROLE_BUDGETS).toEqual(DEFAULT_ROLE_BUDGETS);
  });

  it('reads the same budgets from a config document', () => {
    const text = [
      'apiVersion: ai-sdlc.io/v1alpha1',
      'kind: UsageConfig',
      'spec:',
      '  roles:',
      '    planner:',
      '      contextBudgetTokens: 90000',
      '    operator-dispatch:',
      '      turnBudget: 25',
      '    executor:',
      '      contextBudgetTokens: 70000',
      '      turnBudget: 40',
    ].join('\n');
    const parsed = parseUsageConfig(text, 'machine');
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(hook.parseRoleBudgets(text)).toEqual(parsed.roles);
  });

  it('resolves session names to the same roles', () => {
    for (const name of ['planner', 'Executor-aisdlc-1', 'operator-dispatch.2', 'planners', 'x']) {
      expect(hook.roleFromName(name) ?? undefined).toBe(roleFromSessionName(name));
    }
  });
});
