/**
 * Tests for the lease-push preflight wrapper (AISDLC-798). The golden-path and
 * negative-twin fixtures for the predicate itself live with the predicate, in
 * `ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs`; here the real plugin module is
 * loaded from the repository to prove the wrapper reaches it, and a stub module
 * covers the blocking rules.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimPreflight,
  leasePushPreflight,
  loadPolicyModule,
  type LeaseCondition,
  type PolicyModule,
} from './lease-preflight.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cond: LeaseCondition = { condition: 'heartbeat', found: 'f', expected: 'e', fix: 'x' };

function stub(allowed: boolean, held = allowed): PolicyModule {
  return {
    evaluateLeasePush: () => ({ allowed, failing: allowed ? [] : [cond] }),
    inspectInflightClaim: () => ({ held, failing: held ? [] : [cond] }),
    renderLeaseFailing: (f) => f.map((c) => `  - ${c.condition}`).join('\n'),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lease-preflight-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadPolicyModule', () => {
  it('finds the plugin policy module from a directory inside the repository', () => {
    const mod = loadPolicyModule([repoRoot], {});
    expect(typeof mod?.evaluateLeasePush).toBe('function');
  });

  it('honours CLAUDE_PLUGIN_ROOT', () => {
    const mod = loadPolicyModule([tmp], {
      CLAUDE_PLUGIN_ROOT: path.join(repoRoot, 'ai-sdlc-plugin'),
    });
    expect(typeof mod?.renderLeaseFailing).toBe('function');
  });

  it('returns null when no plugin is on disk or the module cannot be loaded', () => {
    expect(loadPolicyModule([tmp], {})).toBeNull();
    const bad = path.join(tmp, 'ai-sdlc-plugin', 'hooks', 'lib');
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, 'trusted-policy.js'), 'throw new Error("boom")');
    expect(loadPolicyModule([tmp], {})).toBeNull();
  });
});

describe('leasePushPreflight', () => {
  const mk = () => ({ projectDir: tmp, cwd: tmp, taskId: 'AISDLC-9' });

  it('is skipped when the module is missing', () => {
    const r = leasePushPreflight({ ...mk(), load: () => null });
    expect(r).toMatchObject({ status: 'skipped', blocking: false });
  });

  it('is allowed when the predicate allows', () => {
    const r = leasePushPreflight({ ...mk(), branch: 'b', boardDir: tmp, load: () => stub(true) });
    expect(r).toMatchObject({ status: 'allowed', blocking: false, failing: [] });
  });

  it('is advice for a hand-run session', () => {
    const r = leasePushPreflight({ ...mk(), env: {}, load: () => stub(false) });
    expect(r.status).toBe('refused');
    expect(r.blocking).toBe(false);
    expect(r.message).toContain('not-task-worktree');
    expect(r.message).toContain('- heartbeat');
  });

  it('blocks an executor session', () => {
    const r = leasePushPreflight({
      ...mk(),
      env: { AI_SDLC_HIERARCHY_ROLE: 'executor' },
      load: () => stub(false),
    });
    expect(r.blocking).toBe(true);
  });

  it('blocks when the board holds the task even without the launch env', () => {
    const inflight = path.join(tmp, 'board', 'inflight');
    mkdirSync(inflight, { recursive: true });
    writeFileSync(path.join(inflight, 'AISDLC-9.dispatch.json'), '{}');
    const r = leasePushPreflight({
      ...mk(),
      env: {},
      boardDir: path.join(tmp, 'board'),
      load: () => stub(false),
    });
    expect(r.blocking).toBe(true);
  });
});

describe('claimPreflight', () => {
  it('is skipped without the module', () => {
    expect(claimPreflight(tmp, 'AISDLC-9', {}, [tmp], () => null).status).toBe('skipped');
  });

  it('is allowed when env, claim and heartbeat hold', () => {
    const r = claimPreflight(tmp, 'AISDLC-9', {}, [tmp], () => stub(true));
    expect(r.status).toBe('allowed');
  });

  it('refuses with the conditions the claim lacks', () => {
    const r = claimPreflight(tmp, 'AISDLC-9', {}, [tmp], () => stub(false));
    expect(r).toMatchObject({ status: 'refused', blocking: true });
    expect(r.message).toContain('claim of AISDLC-9');
  });

  it('reaches the real predicate: no launch env is reported as hierarchy-env', () => {
    const r = claimPreflight(tmp, 'AISDLC-9', {}, [repoRoot]);
    expect(r.failing.map((f) => f.condition)).toEqual(['hierarchy-env']);
  });
});

describe('leasePushPreflight under allowForcePush: lease (AISDLC-1005)', () => {
  const policy = (mode: string) =>
    `apiVersion: ai-sdlc.io/v1alpha1\nkind: AgentRole\nspec:\n  governance:\n    allowForcePush: ${mode}\n`;
  const makeRepo = (mode: string) => {
    execFileSync('git', ['init', '-q', '-b', 'main', tmp]);
    mkdirSync(path.join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(path.join(tmp, '.ai-sdlc', 'agent-role.yaml'), policy(mode));
  };

  it('is allowed from the main checkout with no task worktree, sentinel or claim', () => {
    makeRepo('lease');
    const r = leasePushPreflight({
      projectDir: tmp,
      cwd: tmp,
      taskId: 'AISDLC-9',
      env: { AI_SDLC_HIERARCHY_ROLE: 'executor' },
      load: () => loadPolicyModule([repoRoot], {}),
    });
    expect(r).toMatchObject({ status: 'allowed', blocking: false, failing: [] });
  });

  it('leaseOnOwnBranch still refuses the same session', () => {
    makeRepo('leaseOnOwnBranch');
    const r = leasePushPreflight({
      projectDir: tmp,
      cwd: tmp,
      taskId: 'AISDLC-9',
      env: { AI_SDLC_HIERARCHY_ROLE: 'executor' },
      load: () => loadPolicyModule([repoRoot], {}),
    });
    expect(r.status).toBe('refused');
  });
});

describe('leasePushPreflight planner-filing shape (AISDLC-830)', () => {
  it('names the planner-filing accepted shape in the allowed message', () => {
    const r = leasePushPreflight({
      projectDir: '/p',
      cwd: '/p/.worktrees/file-x',
      taskId: 'file-x',
      env: { AI_SDLC_HIERARCHY_ROLE: 'planner' },
      load: () =>
        ({
          evaluateLeasePush: () => ({ allowed: true, failing: [], shape: 'planner-filing' }),
        }) as unknown as PolicyModule,
    });
    expect(r.status).toBe('allowed');
    expect(r.message).toContain('planner-filing');
    expect(r.message).toContain('DEC-0088');
  });
});
