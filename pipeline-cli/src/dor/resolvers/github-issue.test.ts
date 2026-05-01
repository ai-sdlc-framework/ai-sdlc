import { describe, expect, it } from 'vitest';
import { githubIssueResolver } from './github-issue.js';
import { FakeRunner, fail, ok } from '../../__test-helpers/fake-runner.js';
import type { Reference } from '../types.js';

describe('githubIssueResolver', () => {
  describe('supports', () => {
    it('matches `#42`', () => {
      expect(githubIssueResolver.supports({ raw: '#42', kind: 'github-issue' })).toBe(true);
    });
    it('matches `gh#42`', () => {
      expect(githubIssueResolver.supports({ raw: 'gh#42', kind: 'unknown' })).toBe(true);
    });
    it('matches `owner/repo#42`', () => {
      expect(
        githubIssueResolver.supports({ raw: 'ai-sdlc-framework/ai-sdlc#42', kind: 'unknown' }),
      ).toBe(true);
    });
    it('matches issue URL', () => {
      expect(
        githubIssueResolver.supports({
          raw: 'https://github.com/owner/repo/issues/42',
          kind: 'url',
        }),
      ).toBe(true);
    });
    it('matches PR URL', () => {
      expect(
        githubIssueResolver.supports({
          raw: 'https://github.com/owner/repo/pull/42',
          kind: 'url',
        }),
      ).toBe(true);
    });
    it('rejects bare urls', () => {
      expect(githubIssueResolver.supports({ raw: 'https://example.com/foo', kind: 'url' })).toBe(
        false,
      );
    });
    it('rejects file-existence kind', () => {
      expect(githubIssueResolver.supports({ raw: '#42', kind: 'file-existence' })).toBe(false);
    });
  });

  describe('resolve', () => {
    const ref: Reference = { raw: '#42', kind: 'github-issue' };

    it('returns resolved=true on `gh issue view` success', async () => {
      const runner = new FakeRunner().on(/^gh issue view/, ok('{"number":42}'));
      const res = await githubIssueResolver.resolve(ref, {
        workDir: '/tmp',
        runner: runner.toRunner(),
      });
      expect(res.resolved).toBe(true);
    });

    it('falls back to `gh pr view` on issue miss', async () => {
      const runner = new FakeRunner()
        .on(/^gh issue view/, fail('not found'))
        .on(/^gh pr view/, ok('{"number":42}'));
      const res = await githubIssueResolver.resolve(ref, {
        workDir: '/tmp',
        runner: runner.toRunner(),
      });
      expect(res.resolved).toBe(true);
    });

    it('returns resolved=false when both calls fail', async () => {
      const runner = new FakeRunner()
        .on(/^gh issue view/, fail('not found'))
        .on(/^gh pr view/, fail('not found either'));
      const res = await githubIssueResolver.resolve(ref, {
        workDir: '/tmp',
        runner: runner.toRunner(),
      });
      expect(res.resolved).toBe(false);
      expect(res.reason).toMatch(/not found/);
    });

    it('respects timeoutMs option (passes through to runner)', async () => {
      const runner = new FakeRunner().on(/^gh issue view/, ok('{"number":42}'));
      const res = await githubIssueResolver.resolve(ref, {
        workDir: '/tmp',
        runner: runner.toRunner(),
        timeoutMs: 1234,
      });
      expect(res.resolved).toBe(true);
      expect(runner.calls[0]?.opts?.timeout).toBe(1234);
    });

    it('truncates very long error messages to 200 chars', async () => {
      const longErr = 'x'.repeat(500);
      const runner = new FakeRunner()
        .on(/^gh issue view/, fail(longErr))
        .on(/^gh pr view/, fail(longErr));
      const res = await githubIssueResolver.resolve(ref, {
        workDir: '/tmp',
        runner: runner.toRunner(),
      });
      expect(res.resolved).toBe(false);
      expect((res.reason ?? '').length).toBeLessThanOrEqual(200);
    });
  });
});
