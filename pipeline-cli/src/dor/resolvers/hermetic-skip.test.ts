import { describe, expect, it } from 'vitest';
import { hermeticGithubIssueSkipResolver, hermeticUrlSkipResolver } from './hermetic-skip.js';
import type { Reference } from '../types.js';

describe('hermeticUrlSkipResolver', () => {
  it('supports only url kind', () => {
    expect(hermeticUrlSkipResolver.supports({ raw: 'https://x.com', kind: 'url' })).toBe(true);
    expect(hermeticUrlSkipResolver.supports({ raw: '#1', kind: 'github-issue' })).toBe(false);
    expect(hermeticUrlSkipResolver.supports({ raw: 'a/b.ts', kind: 'file-existence' })).toBe(false);
  });

  it('always resolves true with a hermetic-skip reason', async () => {
    const ref: Reference = { raw: 'https://ai-sdlc.io/docs/api-reference/runners', kind: 'url' };
    const res = await hermeticUrlSkipResolver.resolve(ref, { workDir: '/tmp' });
    expect(res.resolved).toBe(true);
    expect(res.reason).toMatch(/hermetic mode/);
  });
});

describe('hermeticGithubIssueSkipResolver', () => {
  it('supports only github-issue kind', () => {
    expect(hermeticGithubIssueSkipResolver.supports({ raw: '#42', kind: 'github-issue' })).toBe(
      true,
    );
    expect(hermeticGithubIssueSkipResolver.supports({ raw: 'https://x.com', kind: 'url' })).toBe(
      false,
    );
  });

  it('always resolves true with a hermetic-skip reason', async () => {
    const ref: Reference = { raw: 'gh#42', kind: 'github-issue' };
    const res = await hermeticGithubIssueSkipResolver.resolve(ref, { workDir: '/tmp' });
    expect(res.resolved).toBe(true);
    expect(res.reason).toMatch(/hermetic mode/);
  });
});
