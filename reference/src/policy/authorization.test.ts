import { describe, it, expect } from 'vitest';
import {
  checkPermission,
  checkConstraints,
  authorize,
  createAuthorizationHook,
} from './authorization.js';
import type { Permissions, AgentConstraints, AutonomyPolicy } from '../core/types.js';

describe('checkPermission', () => {
  const permissions: Permissions = {
    read: ['src/**', 'docs/**'],
    write: ['src/**'],
    execute: ['build', 'test'],
  };

  it('allows matching read targets', () => {
    expect(checkPermission(permissions, 'read', 'src/index.ts').allowed).toBe(true);
    expect(checkPermission(permissions, 'read', 'docs/README.md').allowed).toBe(true);
  });

  it('denies non-matching targets', () => {
    const result = checkPermission(permissions, 'read', 'secrets/key.pem');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('permissions');
  });

  it('allows matching write targets', () => {
    expect(checkPermission(permissions, 'write', 'src/main.ts').allowed).toBe(true);
  });

  it('denies write to unmatched paths', () => {
    expect(checkPermission(permissions, 'write', 'docs/guide.md').allowed).toBe(false);
  });

  it('allows exact execute matches', () => {
    expect(checkPermission(permissions, 'execute', 'build').allowed).toBe(true);
    expect(checkPermission(permissions, 'execute', 'test').allowed).toBe(true);
  });

  it('denies execute for unmatched commands', () => {
    expect(checkPermission(permissions, 'execute', 'deploy').allowed).toBe(false);
  });

  it('denies when permission list is empty', () => {
    const empty: Permissions = { read: [], write: [], execute: [] };
    expect(checkPermission(empty, 'read', 'anything').allowed).toBe(false);
  });
});

describe('checkConstraints', () => {
  it('blocks paths matching blockedPaths', () => {
    const constraints: AgentConstraints = {
      blockedPaths: ['**/auth/**', '**/payment/**'],
    };
    const result = checkConstraints(constraints, 'src/auth/login.ts');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('constraints');
  });

  it('allows paths not matching blockedPaths', () => {
    const constraints: AgentConstraints = {
      blockedPaths: ['**/auth/**'],
    };
    expect(checkConstraints(constraints, 'src/utils/helper.ts').allowed).toBe(true);
  });

  it('blocks files not in allowedLanguages', () => {
    const constraints: AgentConstraints = {
      allowedLanguages: ['typescript', 'javascript'],
    };
    const result = checkConstraints(constraints, 'src/main.py');
    expect(result.allowed).toBe(false);
    expect(result.layer).toBe('constraints');
  });

  it('allows files in allowedLanguages', () => {
    const constraints: AgentConstraints = {
      allowedLanguages: ['typescript', 'javascript'],
    };
    expect(checkConstraints(constraints, 'src/index.ts').allowed).toBe(true);
    expect(checkConstraints(constraints, 'src/app.jsx').allowed).toBe(true);
  });

  it('allows files with no extension when allowedLanguages is set', () => {
    const constraints: AgentConstraints = {
      allowedLanguages: ['typescript'],
    };
    expect(checkConstraints(constraints, 'Makefile').allowed).toBe(true);
  });

  it('allows everything when constraints are empty', () => {
    const constraints: AgentConstraints = {};
    expect(checkConstraints(constraints, 'anything.py').allowed).toBe(true);
  });
});

describe('authorize', () => {
  const permissions: Permissions = {
    read: ['**'],
    write: ['src/**'],
    execute: ['build'],
  };

  it('passes when both permissions and constraints allow', () => {
    const constraints: AgentConstraints = { allowedLanguages: ['typescript'] };
    expect(authorize(permissions, constraints, 'write', 'src/index.ts').allowed).toBe(true);
  });

  it('fails when permissions deny', () => {
    const constraints: AgentConstraints = {};
    expect(authorize(permissions, constraints, 'write', 'docs/README.md').allowed).toBe(false);
  });

  it('fails when constraints deny', () => {
    const constraints: AgentConstraints = { blockedPaths: ['**/secret/**'] };
    expect(authorize(permissions, constraints, 'write', 'src/secret/key.ts').allowed).toBe(false);
  });

  it('skips constraint check for read actions', () => {
    const constraints: AgentConstraints = { blockedPaths: ['src/**'] };
    // blockedPaths only apply to writes
    expect(authorize(permissions, constraints, 'read', 'src/index.ts').allowed).toBe(true);
  });
});

describe('createAuthorizationHook', () => {
  const policy: AutonomyPolicy = {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AutonomyPolicy',
    metadata: { name: 'test-policy' },
    spec: {
      levels: [
        {
          level: 0,
          name: 'Supervised',
          permissions: { read: ['**'], write: [], execute: [] },
          guardrails: { requireApproval: 'all' },
          monitoring: 'continuous',
        },
        {
          level: 1,
          name: 'Semi-Autonomous',
          permissions: { read: ['**'], write: ['src/**'], execute: ['build', 'test'] },
          guardrails: { requireApproval: 'security-critical-only' },
          monitoring: 'real-time-notification',
        },
      ],
      promotionCriteria: {},
      demotionTriggers: [],
    },
  };

  it('allows actions within level permissions', () => {
    const levels = new Map([['agent-1', 1]]);
    const constraints = new Map<string, AgentConstraints>();
    const hook = createAuthorizationHook(policy, levels, constraints);

    expect(hook({ agent: 'agent-1', action: 'write', target: 'src/index.ts' }).allowed).toBe(true);
  });

  it('denies actions outside level permissions', () => {
    const levels = new Map([['agent-1', 0]]);
    const constraints = new Map<string, AgentConstraints>();
    const hook = createAuthorizationHook(policy, levels, constraints);

    const result = hook({ agent: 'agent-1', action: 'write', target: 'src/index.ts' });
    expect(result.allowed).toBe(false);
  });

  it('denies unknown agents', () => {
    const levels = new Map<string, number>();
    const constraints = new Map<string, AgentConstraints>();
    const hook = createAuthorizationHook(policy, levels, constraints);

    const result = hook({ agent: 'unknown', action: 'read', target: 'anything' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unknown');
  });

  it('applies agent constraints on write', () => {
    const levels = new Map([['agent-1', 1]]);
    const constraints = new Map([
      ['agent-1', { blockedPaths: ['**/auth/**'] } as AgentConstraints],
    ]);
    const hook = createAuthorizationHook(policy, levels, constraints);

    expect(hook({ agent: 'agent-1', action: 'write', target: 'src/auth/login.ts' }).allowed).toBe(
      false,
    );
  });
});
