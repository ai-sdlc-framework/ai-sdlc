import { describe, it, expect } from 'vitest';
import { createGitLabSourceControl, createGitLabCIPipeline, type HttpClient, type GitLabConfig } from './index.js';

// ── Mock HttpClient ──────────────────────────────────────────────────

function createMockClient(responses: Map<string, { status: number; body: unknown }>): HttpClient {
  return async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    // Try exact match first, then prefix match
    let entry = responses.get(key);
    if (!entry) {
      for (const [pattern, resp] of responses.entries()) {
        if (key.startsWith(pattern) || key.includes(pattern.split(' ')[1])) {
          entry = resp;
          break;
        }
      }
    }
    if (!entry) {
      return new Response('Not Found', { status: 404 }) as unknown as Response;
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry!.body,
    } as unknown as Response;
  };
}

const baseConfig: GitLabConfig = {
  baseUrl: 'https://gitlab.com',
  projectId: '12345',
};

// ── SourceControl ────────────────────────────────────────────────────

describe('createGitLabSourceControl', () => {
  it('createBranch sends POST and returns branch', async () => {
    const client = createMockClient(new Map([
      ['POST https://gitlab.com/api/v4/projects/12345/repository/branches', {
        status: 201,
        body: { name: 'feature/x', commit: { id: 'abc123' } },
      }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    const branch = await sc.createBranch({ name: 'feature/x', from: 'main' });
    expect(branch.name).toBe('feature/x');
    expect(branch.sha).toBe('abc123');
  });

  it('createPR sends POST and returns merge request', async () => {
    const client = createMockClient(new Map([
      ['POST https://gitlab.com/api/v4/projects/12345/merge_requests', {
        status: 201,
        body: {
          iid: 42, title: 'My MR', description: 'desc',
          source_branch: 'feature/x', target_branch: 'main',
          state: 'opened', author: { username: 'dev1' }, web_url: 'https://gitlab.com/mr/42',
        },
      }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    const pr = await sc.createPR({ title: 'My MR', description: 'desc', sourceBranch: 'feature/x', targetBranch: 'main' });
    expect(pr.id).toBe('42');
    expect(pr.title).toBe('My MR');
    expect(pr.status).toBe('open');
    expect(pr.author).toBe('dev1');
  });

  it('mergePR sends PUT and returns merge result', async () => {
    const client = createMockClient(new Map([
      ['PUT https://gitlab.com/api/v4/projects/12345/merge_requests/42/merge', {
        status: 200,
        body: { merge_commit_sha: 'def456', state: 'merged' },
      }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    const result = await sc.mergePR('42', 'merge');
    expect(result.sha).toBe('def456');
    expect(result.merged).toBe(true);
  });

  it('getFileContents decodes base64 content', async () => {
    const content = Buffer.from('hello world').toString('base64');
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/repository/files', {
        status: 200,
        body: { file_path: 'README.md', content, encoding: 'base64' },
      }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    const file = await sc.getFileContents('README.md', 'main');
    expect(file.content).toBe('hello world');
    expect(file.path).toBe('README.md');
  });

  it('listChangedFiles returns diff information', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/merge_requests/42/changes', {
        status: 200,
        body: {
          changes: [
            { new_path: 'src/a.ts', old_path: 'src/a.ts', new_file: false, deleted_file: false, renamed_file: false, additions: 10, deletions: 2 },
            { new_path: 'src/b.ts', old_path: 'src/b.ts', new_file: true, deleted_file: false, renamed_file: false, additions: 50, deletions: 0 },
          ],
        },
      }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    const files = await sc.listChangedFiles('42');
    expect(files).toHaveLength(2);
    expect(files[0].status).toBe('modified');
    expect(files[1].status).toBe('added');
  });

  it('setCommitStatus maps state correctly', async () => {
    let sentBody: string | undefined;
    const client: HttpClient = async (_url, init) => {
      sentBody = init?.body as string;
      return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
    };
    const sc = createGitLabSourceControl(baseConfig, client);
    await sc.setCommitStatus('sha123', { state: 'failure', context: 'ci/test', description: 'failed' });
    const parsed = JSON.parse(sentBody!);
    expect(parsed.state).toBe('failed');
    expect(parsed.context).toBe('ci/test');
  });

  it('throws on API failure', async () => {
    const client = createMockClient(new Map([
      ['POST https://gitlab.com/api/v4/projects/12345/repository/branches', { status: 400, body: { message: 'bad' } }],
    ]));
    const sc = createGitLabSourceControl(baseConfig, client);
    await expect(sc.createBranch({ name: 'x' })).rejects.toThrow('GitLab createBranch failed: 400');
  });

  it('watchPREvents returns empty stream', () => {
    const sc = createGitLabSourceControl(baseConfig, async () => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response));
    const stream = sc.watchPREvents({});
    expect(stream[Symbol.asyncIterator]).toBeDefined();
  });
});

// ── CIPipeline ───────────────────────────────────────────────────────

describe('createGitLabCIPipeline', () => {
  it('triggerBuild sends POST pipeline', async () => {
    const client = createMockClient(new Map([
      ['POST https://gitlab.com/api/v4/projects/12345/pipeline', {
        status: 201,
        body: { id: 100, status: 'created', web_url: 'https://gitlab.com/pipelines/100' },
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const build = await ci.triggerBuild({ branch: 'main' });
    expect(build.id).toBe('100');
    expect(build.status).toBe('created');
  });

  it('triggerBuild passes variables', async () => {
    let sentBody: string | undefined;
    const client: HttpClient = async (_url, init) => {
      sentBody = init?.body as string;
      return { ok: true, status: 201, json: async () => ({ id: 1, status: 'created' }) } as unknown as Response;
    };
    const ci = createGitLabCIPipeline(baseConfig, client);
    await ci.triggerBuild({ branch: 'main', parameters: { FOO: 'bar' } });
    const parsed = JSON.parse(sentBody!);
    expect(parsed.variables).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('getBuildStatus maps pipeline status', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100', {
        status: 200,
        body: { id: 100, status: 'success', started_at: '2024-01-01T00:00:00Z', finished_at: '2024-01-01T01:00:00Z' },
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const status = await ci.getBuildStatus('100');
    expect(status.status).toBe('succeeded');
    expect(status.startedAt).toBe('2024-01-01T00:00:00Z');
  });

  it('getTestResults parses test report', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100/test_report', {
        status: 200,
        body: { total_count: 50, failed_count: 2, skipped_count: 3, total_time: 120 },
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const results = await ci.getTestResults('100');
    expect(results.passed).toBe(45);
    expect(results.failed).toBe(2);
    expect(results.skipped).toBe(3);
  });

  it('getTestResults returns zeros on failure', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100/test_report', { status: 404, body: {} }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const results = await ci.getTestResults('100');
    expect(results.passed).toBe(0);
  });

  it('getCoverageReport averages job coverages', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100/jobs', {
        status: 200,
        body: [{ coverage: 80 }, { coverage: 90 }, { coverage: null }],
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const report = await ci.getCoverageReport('100');
    expect(report.lineCoverage).toBe(85);
  });

  it('getCoverageReport returns 0 when no coverage', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100/jobs', {
        status: 200,
        body: [{ coverage: null }],
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const report = await ci.getCoverageReport('100');
    expect(report.lineCoverage).toBe(0);
  });

  it('getBuildStatus maps failed status', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100', {
        status: 200,
        body: { id: 100, status: 'failed' },
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const status = await ci.getBuildStatus('100');
    expect(status.status).toBe('failed');
  });

  it('getBuildStatus maps canceled status', async () => {
    const client = createMockClient(new Map([
      ['GET https://gitlab.com/api/v4/projects/12345/pipelines/100', {
        status: 200,
        body: { id: 100, status: 'canceled' },
      }],
    ]));
    const ci = createGitLabCIPipeline(baseConfig, client);
    const status = await ci.getBuildStatus('100');
    expect(status.status).toBe('cancelled');
  });
});
