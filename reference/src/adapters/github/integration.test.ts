/**
 * Live integration tests for the GitHub adapter.
 * Read-only operations against the real ai-sdlc repo.
 * Skipped when GITHUB_TOKEN is not set.
 */
import { describe, it, expect } from 'vitest';
import { createGitHubIssueTracker, createGitHubSourceControl, type GitHubConfig } from './index.js';

describe.skipIf(!process.env.GITHUB_TOKEN)('GitHub integration (live)', () => {
  const config: GitHubConfig = {
    org: 'ai-sdlc-framework',
    repo: 'ai-sdlc',
    token: { secretRef: 'github-token' },
  };

  it('listIssues returns an array', async () => {
    const tracker = createGitHubIssueTracker(config);
    const issues = await tracker.listIssues({});
    expect(Array.isArray(issues)).toBe(true);
  });

  it('getFileContents reads README.md from main', async () => {
    const sc = createGitHubSourceControl(config);
    const file = await sc.getFileContents('README.md', 'main');
    expect(file.content).toContain('AI-SDLC');
    expect(file.encoding).toBe('utf-8');
  });

  it('getFileContents reads package.json from main', async () => {
    const sc = createGitHubSourceControl(config);
    const file = await sc.getFileContents('package.json', 'main');
    const pkg = JSON.parse(file.content);
    expect(pkg.name).toBe('ai-sdlc');
  });
});
