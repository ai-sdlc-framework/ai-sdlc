import { describe, it, expect } from 'vitest';
import {
  createTokenAuthenticator,
  createAlwaysAuthenticator,
  type AuthIdentity,
} from './authentication.js';

const testIdentity: AuthIdentity = {
  actor: 'agent-1',
  actorType: 'ai-agent',
  roles: ['developer'],
  groups: ['team-a'],
  scopes: ['repo:read', 'repo:write'],
};

describe('createTokenAuthenticator', () => {
  it('authenticates valid tokens', async () => {
    const tokens = new Map([['tok-123', testIdentity]]);
    const auth = createTokenAuthenticator(tokens);
    const result = await auth.authenticate('tok-123');
    expect(result.success).toBe(true);
    expect(result.identity).toEqual(testIdentity);
  });

  it('rejects invalid tokens', async () => {
    const tokens = new Map([['tok-123', testIdentity]]);
    const auth = createTokenAuthenticator(tokens);
    const result = await auth.authenticate('bad-token');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Invalid');
  });

  it('rejects empty tokens', async () => {
    const auth = createTokenAuthenticator(new Map());
    const result = await auth.authenticate('');
    expect(result.success).toBe(false);
  });

  it('supports multiple tokens', async () => {
    const identity2: AuthIdentity = {
      actor: 'human-1',
      actorType: 'human',
      roles: ['admin'],
      groups: ['ops'],
      scopes: ['*'],
    };
    const tokens = new Map([
      ['tok-1', testIdentity],
      ['tok-2', identity2],
    ]);
    const auth = createTokenAuthenticator(tokens);
    const r1 = await auth.authenticate('tok-1');
    const r2 = await auth.authenticate('tok-2');
    expect(r1.identity?.actor).toBe('agent-1');
    expect(r2.identity?.actor).toBe('human-1');
  });
});

describe('createAlwaysAuthenticator', () => {
  it('always returns success with the given identity', async () => {
    const auth = createAlwaysAuthenticator(testIdentity);
    const result = await auth.authenticate('anything');
    expect(result.success).toBe(true);
    expect(result.identity).toEqual(testIdentity);
  });

  it('works with empty token', async () => {
    const auth = createAlwaysAuthenticator(testIdentity);
    const result = await auth.authenticate('');
    expect(result.success).toBe(true);
  });

  it('returns the exact identity provided', async () => {
    const custom: AuthIdentity = {
      actor: 'svc',
      actorType: 'service-account',
      roles: [],
      groups: [],
      scopes: ['metrics:read'],
    };
    const auth = createAlwaysAuthenticator(custom);
    const result = await auth.authenticate('tok');
    expect(result.identity).toEqual(custom);
  });
});
