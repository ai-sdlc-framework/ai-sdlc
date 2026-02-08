import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGitHubIssueTracker,
  createGitHubSourceControl,
  createGitHubCIPipeline,
  type GitHubConfig,
} from './index.js';

// ── Mock Octokit ────────────────────────────────────────────────────

const mockIssues = {
  listForRepo: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const mockPulls = {
  create: vi.fn(),
  merge: vi.fn(),
  listFiles: vi.fn(),
};

const mockGit = {
  getRef: vi.fn(),
  createRef: vi.fn(),
};

const mockRepos = {
  getContent: vi.fn(),
  createCommitStatus: vi.fn(),
};

const mockActions = {
  createWorkflowDispatch: vi.fn(),
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
  listWorkflowRunArtifacts: vi.fn(),
};

const mockChecks = {
  listForSuite: vi.fn(),
};

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    issues: mockIssues,
    pulls: mockPulls,
    git: mockGit,
    repos: mockRepos,
    actions: mockActions,
    checks: mockChecks,
  })),
}));

vi.mock('../resolve-secret.js', () => ({
  resolveSecret: vi.fn(() => 'ghp_mock_token'),
}));

const config: GitHubConfig = {
  org: 'test-org',
  repo: 'test-repo',
  token: { secretRef: 'github-token' },
};

// ── IssueTracker tests ──────────────────────────────────────────────

describe('createGitHubIssueTracker', () => {
  beforeEach(() => vi.clearAllMocks());

  const tracker = createGitHubIssueTracker(config);

  it('listIssues maps GitHub response to Issue[]', async () => {
    mockIssues.listForRepo.mockResolvedValue({
      data: [
        {
          number: 1,
          title: 'Bug report',
          body: 'Something broke',
          state: 'open',
          labels: [{ name: 'bug' }],
          assignee: { login: 'alice' },
          html_url: 'https://github.com/test-org/test-repo/issues/1',
        },
        {
          number: 2,
          title: 'PR title',
          body: null,
          state: 'open',
          labels: [],
          assignee: null,
          html_url: 'https://github.com/test-org/test-repo/pull/2',
          pull_request: {},
        },
      ],
    });

    const issues = await tracker.listIssues({});
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      id: '1',
      title: 'Bug report',
      description: 'Something broke',
      status: 'open',
      labels: ['bug'],
      assignee: 'alice',
      url: 'https://github.com/test-org/test-repo/issues/1',
    });
  });

  it('listIssues passes filter params', async () => {
    mockIssues.listForRepo.mockResolvedValue({ data: [] });

    await tracker.listIssues({
      status: 'closed',
      labels: ['bug', 'p0'],
      assignee: 'bob',
    });

    expect(mockIssues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
        state: 'closed',
        labels: 'bug,p0',
        assignee: 'bob',
      }),
    );
  });

  it('getIssue returns mapped issue', async () => {
    mockIssues.get.mockResolvedValue({
      data: {
        number: 42,
        title: 'Feature request',
        body: 'Add dark mode',
        state: 'open',
        labels: [],
        assignee: null,
        html_url: 'https://github.com/test-org/test-repo/issues/42',
      },
    });

    const issue = await tracker.getIssue('42');
    expect(issue.id).toBe('42');
    expect(issue.title).toBe('Feature request');
    expect(mockIssues.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));
  });

  it('createIssue sends correct params', async () => {
    mockIssues.create.mockResolvedValue({
      data: {
        number: 10,
        title: 'New issue',
        body: 'Description',
        state: 'open',
        labels: [{ name: 'enhancement' }],
        assignee: { login: 'alice' },
        html_url: 'https://github.com/test-org/test-repo/issues/10',
      },
    });

    const issue = await tracker.createIssue({
      title: 'New issue',
      description: 'Description',
      labels: ['enhancement'],
      assignee: 'alice',
    });

    expect(issue.id).toBe('10');
    expect(mockIssues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New issue',
        body: 'Description',
        labels: ['enhancement'],
        assignees: ['alice'],
      }),
    );
  });

  it('updateIssue patches the issue', async () => {
    mockIssues.update.mockResolvedValue({
      data: {
        number: 10,
        title: 'Updated title',
        body: null,
        state: 'open',
        labels: [],
        assignee: null,
        html_url: 'https://github.com/test-org/test-repo/issues/10',
      },
    });

    const issue = await tracker.updateIssue('10', { title: 'Updated title' });
    expect(issue.title).toBe('Updated title');
  });

  it('transitionIssue closes an issue', async () => {
    mockIssues.update.mockResolvedValue({
      data: {
        number: 5,
        title: 'Done',
        body: null,
        state: 'closed',
        labels: [],
        assignee: null,
        html_url: 'https://github.com/test-org/test-repo/issues/5',
      },
    });

    const issue = await tracker.transitionIssue('5', 'close');
    expect(issue.status).toBe('closed');
    expect(mockIssues.update).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed' }));
  });

  it('watchIssues returns empty async iterator', async () => {
    const stream = tracker.watchIssues({});
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });
});

// ── SourceControl tests ─────────────────────────────────────────────

describe('createGitHubSourceControl', () => {
  beforeEach(() => vi.clearAllMocks());

  const sc = createGitHubSourceControl(config);

  it('createBranch gets SHA and creates ref', async () => {
    mockGit.getRef.mockResolvedValue({
      data: { object: { sha: 'abc123' } },
    });
    mockGit.createRef.mockResolvedValue({ data: {} });

    const branch = await sc.createBranch({ name: 'feature/new' });
    expect(branch).toEqual({ name: 'feature/new', sha: 'abc123' });
    expect(mockGit.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main' }));
    expect(mockGit.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'refs/heads/feature/new',
        sha: 'abc123',
      }),
    );
  });

  it('createBranch uses custom from ref', async () => {
    mockGit.getRef.mockResolvedValue({
      data: { object: { sha: 'def456' } },
    });
    mockGit.createRef.mockResolvedValue({ data: {} });

    await sc.createBranch({ name: 'hotfix', from: 'develop' });
    expect(mockGit.getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/develop' }));
  });

  it('createPR maps response correctly', async () => {
    mockPulls.create.mockResolvedValue({
      data: {
        number: 99,
        title: 'Add feature',
        body: 'Description',
        head: { ref: 'feature/new' },
        base: { ref: 'main' },
        state: 'open',
        merged: false,
        user: { login: 'alice' },
        html_url: 'https://github.com/test-org/test-repo/pull/99',
      },
    });

    const pr = await sc.createPR({
      title: 'Add feature',
      description: 'Description',
      sourceBranch: 'feature/new',
      targetBranch: 'main',
    });

    expect(pr).toEqual({
      id: '99',
      title: 'Add feature',
      description: 'Description',
      sourceBranch: 'feature/new',
      targetBranch: 'main',
      status: 'open',
      author: 'alice',
      url: 'https://github.com/test-org/test-repo/pull/99',
    });
  });

  it('mergePR passes correct merge method', async () => {
    mockPulls.merge.mockResolvedValue({
      data: { sha: 'merge123', merged: true },
    });

    const result = await sc.mergePR('99', 'squash');
    expect(result).toEqual({ sha: 'merge123', merged: true });
    expect(mockPulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({ merge_method: 'squash' }),
    );
  });

  it('getFileContents decodes base64 content', async () => {
    const encoded = Buffer.from('hello world').toString('base64');
    mockRepos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        path: 'README.md',
        content: encoded,
      },
    });

    const file = await sc.getFileContents('README.md', 'main');
    expect(file).toEqual({
      path: 'README.md',
      content: 'hello world',
      encoding: 'utf-8',
    });
  });

  it('getFileContents throws for directories', async () => {
    mockRepos.getContent.mockResolvedValue({ data: [] });

    await expect(sc.getFileContents('src/', 'main')).rejects.toThrow('not a file');
  });

  it('listChangedFiles maps removed to deleted', async () => {
    mockPulls.listFiles.mockResolvedValue({
      data: [
        { filename: 'a.ts', status: 'added', additions: 10, deletions: 0 },
        { filename: 'b.ts', status: 'removed', additions: 0, deletions: 5 },
        { filename: 'c.ts', status: 'modified', additions: 3, deletions: 2 },
      ],
    });

    const files = await sc.listChangedFiles('1');
    expect(files).toEqual([
      { path: 'a.ts', status: 'added', additions: 10, deletions: 0 },
      { path: 'b.ts', status: 'deleted', additions: 0, deletions: 5 },
      { path: 'c.ts', status: 'modified', additions: 3, deletions: 2 },
    ]);
  });

  it('setCommitStatus calls createCommitStatus', async () => {
    mockRepos.createCommitStatus.mockResolvedValue({ data: {} });

    await sc.setCommitStatus('sha123', {
      state: 'success',
      context: 'ci/tests',
      description: 'All tests passed',
    });

    expect(mockRepos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: 'sha123',
        state: 'success',
        context: 'ci/tests',
      }),
    );
  });

  it('watchPREvents returns empty async iterator', async () => {
    const stream = sc.watchPREvents({});
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });
});

// ── Error handling ──────────────────────────────────────────────────

describe('error handling', () => {
  it('throws when repo is missing from config', () => {
    expect(() => createGitHubIssueTracker({ org: 'test-org' })).toThrow(
      'GitHubConfig.repo is required',
    );
  });
});

// ── CIPipeline tests ────────────────────────────────────────────────

describe('createGitHubCIPipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  const ci = createGitHubCIPipeline(config);

  it('triggerBuild dispatches workflow and returns latest run', async () => {
    mockActions.createWorkflowDispatch.mockResolvedValue({ data: {} });
    mockActions.listWorkflowRuns.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 12345,
            status: 'queued',
            html_url: 'https://github.com/test-org/test-repo/actions/runs/12345',
          },
        ],
      },
    });

    const build = await ci.triggerBuild({ branch: 'main' });
    expect(build.id).toBe('12345');
    expect(build.status).toBe('queued');
    expect(build.url).toContain('actions/runs');
    expect(mockActions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'main', workflow_id: 'ci.yml' }),
    );
  });

  it('triggerBuild handles empty workflow runs', async () => {
    mockActions.createWorkflowDispatch.mockResolvedValue({ data: {} });
    mockActions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [] },
    });

    const build = await ci.triggerBuild({ branch: 'feature' });
    expect(build.id).toBe('pending');
  });

  it('getBuildStatus maps completed/success', async () => {
    mockActions.getWorkflowRun.mockResolvedValue({
      data: {
        id: 123,
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:05:00Z',
      },
    });

    const status = await ci.getBuildStatus('123');
    expect(status.status).toBe('succeeded');
    expect(status.startedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('getBuildStatus maps completed/failure', async () => {
    mockActions.getWorkflowRun.mockResolvedValue({
      data: { id: 123, status: 'completed', conclusion: 'failure' },
    });

    const status = await ci.getBuildStatus('123');
    expect(status.status).toBe('failed');
  });

  it('getBuildStatus maps in_progress', async () => {
    mockActions.getWorkflowRun.mockResolvedValue({
      data: { id: 123, status: 'in_progress', conclusion: null },
    });

    const status = await ci.getBuildStatus('123');
    expect(status.status).toBe('running');
  });

  it('getBuildStatus maps cancelled', async () => {
    mockActions.getWorkflowRun.mockResolvedValue({
      data: { id: 123, status: 'completed', conclusion: 'cancelled' },
    });

    const status = await ci.getBuildStatus('123');
    expect(status.status).toBe('cancelled');
  });

  it('getTestResults aggregates check run conclusions', async () => {
    mockChecks.listForSuite.mockResolvedValue({
      data: {
        check_runs: [
          { conclusion: 'success' },
          { conclusion: 'success' },
          { conclusion: 'failure' },
          { conclusion: 'skipped' },
        ],
      },
    });

    const results = await ci.getTestResults('456');
    expect(results.passed).toBe(2);
    expect(results.failed).toBe(1);
    expect(results.skipped).toBe(1);
  });

  it('getTestResults returns zeros for no check runs', async () => {
    mockChecks.listForSuite.mockResolvedValue({
      data: { check_runs: [] },
    });

    const results = await ci.getTestResults('789');
    expect(results).toEqual({ passed: 0, failed: 0, skipped: 0 });
  });

  it('getCoverageReport returns zero when no artifact', async () => {
    mockActions.listWorkflowRunArtifacts.mockResolvedValue({
      data: { artifacts: [] },
    });

    const report = await ci.getCoverageReport('123');
    expect(report.lineCoverage).toBe(0);
  });

  it('getCoverageReport returns placeholder when coverage artifact found', async () => {
    mockActions.listWorkflowRunArtifacts.mockResolvedValue({
      data: { artifacts: [{ name: 'test-coverage-report' }] },
    });

    const report = await ci.getCoverageReport('123');
    expect(report.lineCoverage).toBe(0);
    expect(report.branchCoverage).toBe(0);
  });

  it('getCoverageReport handles API errors gracefully', async () => {
    mockActions.listWorkflowRunArtifacts.mockRejectedValue(new Error('Not found'));

    const report = await ci.getCoverageReport('999');
    expect(report.lineCoverage).toBe(0);
  });

  it('watchBuildEvents returns empty async iterator', async () => {
    const stream = ci.watchBuildEvents({});
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
  });
});

// Integration tests live in integration.test.ts (no mocks).
