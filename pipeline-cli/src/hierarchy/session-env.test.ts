import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HIERARCHY_SESSION_ENV_VARS, strippedSessionEnv } from './session-env.js';

describe('session-env', () => {
  it('strips every session var and keeps the rest', () => {
    const base: NodeJS.ProcessEnv = { KEEP: '1' };
    for (const k of HIERARCHY_SESSION_ENV_VARS) base[k] = 'x';
    const env = strippedSessionEnv(base);
    for (const k of HIERARCHY_SESSION_ENV_VARS) expect(env[k]).toBeUndefined();
    expect(env.KEEP).toBe('1');
  });

  it('defaults to process.env', () => {
    expect(strippedSessionEnv().CLAUDE_PROJECT_DIR).toBeUndefined();
  });

  it('vitest.git-env.setup.mjs deletes exactly the same names', () => {
    const src = readFileSync(resolve(__dirname, '../../../vitest.git-env.setup.mjs'), 'utf-8');
    for (const k of HIERARCHY_SESSION_ENV_VARS) expect(src).toContain(`'${k}'`);
    const block = /HIERARCHY_SESSION_ENV_VARS\s*=\s*\[([\s\S]*?)\]/.exec(src);
    const names = [...(block?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...HIERARCHY_SESSION_ENV_VARS].sort());
  });
});
