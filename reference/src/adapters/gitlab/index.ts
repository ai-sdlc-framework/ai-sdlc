/**
 * GitLab adapter — implements SourceControl and CIPipeline via REST API v4.
 * Uses injected HttpClient for testability. All requests use native fetch.
 * <!-- Source: PRD Section 9 -->
 */

import { resolveSecret } from '../resolve-secret.js';
import type {
  SourceControl,
  CIPipeline,
  Branch,
  CreateBranchInput,
  PullRequest,
  CreatePRInput,
  MergeStrategy,
  MergeResult,
  FileContent,
  ChangedFile,
  CommitStatus,
  PRFilter,
  PREvent,
  EventStream,
  TriggerBuildInput,
  Build,
  BuildStatus,
  TestResults,
  CoverageReport,
  BuildFilter,
  BuildEvent,
} from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitLabConfig {
  /** GitLab API base URL (e.g. 'https://gitlab.com'). */
  baseUrl: string;
  /** Project ID (numeric) or URL-encoded path (e.g. 'group%2Fproject'). */
  projectId: string | number;
  /** Token secret reference for authentication. */
  token?: { secretRef: string };
}

// ── Internal Helpers ─────────────────────────────────────────────────

function createDefaultClient(config: GitLabConfig): HttpClient {
  const token = config.token ? resolveSecret(config.token.secretRef) : undefined;
  return async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string>),
    };
    if (token) headers['PRIVATE-TOKEN'] = token;
    return fetch(url, { ...init, headers });
  };
}

function apiUrl(config: GitLabConfig, path: string): string {
  const projectId = encodeURIComponent(String(config.projectId));
  return `${config.baseUrl}/api/v4/projects/${projectId}${path}`;
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub — real implementation uses webhooks
    },
  };
}

// ── SourceControl ────────────────────────────────────────────────────

export function createGitLabSourceControl(
  config: GitLabConfig,
  injectedClient?: HttpClient,
): SourceControl {
  const client = injectedClient ?? createDefaultClient(config);

  return {
    async createBranch(input: CreateBranchInput): Promise<Branch> {
      const res = await client(apiUrl(config, '/repository/branches'), {
        method: 'POST',
        body: JSON.stringify({ branch: input.name, ref: input.from ?? 'main' }),
      });
      if (!res.ok) throw new Error(`GitLab createBranch failed: ${res.status}`);
      const data = await res.json();
      return { name: data.name, sha: data.commit.id };
    },

    async createPR(input: CreatePRInput): Promise<PullRequest> {
      const res = await client(apiUrl(config, '/merge_requests'), {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
        }),
      });
      if (!res.ok) throw new Error(`GitLab createPR failed: ${res.status}`);
      const data = await res.json();
      return mapMergeRequest(data);
    },

    async mergePR(id: string, _strategy: MergeStrategy): Promise<MergeResult> {
      const res = await client(apiUrl(config, `/merge_requests/${id}/merge`), {
        method: 'PUT',
      });
      if (!res.ok) throw new Error(`GitLab mergePR failed: ${res.status}`);
      const data = await res.json();
      return { sha: data.merge_commit_sha ?? data.sha ?? '', merged: data.state === 'merged' };
    },

    async getFileContents(path: string, ref: string): Promise<FileContent> {
      const encodedPath = encodeURIComponent(path);
      const res = await client(apiUrl(config, `/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`));
      if (!res.ok) throw new Error(`GitLab getFileContents failed: ${res.status}`);
      const data = await res.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return { path: data.file_path, content, encoding: 'utf-8' };
    },

    async listChangedFiles(prId: string): Promise<ChangedFile[]> {
      const res = await client(apiUrl(config, `/merge_requests/${prId}/changes`));
      if (!res.ok) throw new Error(`GitLab listChangedFiles failed: ${res.status}`);
      const data = await res.json();
      return (data.changes ?? []).map((c: Record<string, unknown>) => ({
        path: (c.new_path ?? c.old_path) as string,
        status: c.new_file ? 'added' : c.deleted_file ? 'deleted' : c.renamed_file ? 'renamed' : 'modified',
        additions: typeof c.additions === 'number' ? c.additions : 0,
        deletions: typeof c.deletions === 'number' ? c.deletions : 0,
      }));
    },

    async setCommitStatus(sha: string, status: CommitStatus): Promise<void> {
      const stateMap: Record<string, string> = {
        pending: 'pending',
        success: 'success',
        failure: 'failed',
        error: 'failed',
      };
      const res = await client(apiUrl(config, `/statuses/${sha}`), {
        method: 'POST',
        body: JSON.stringify({
          state: stateMap[status.state] ?? 'pending',
          context: status.context,
          description: status.description,
          target_url: status.targetUrl,
        }),
      });
      if (!res.ok) throw new Error(`GitLab setCommitStatus failed: ${res.status}`);
    },

    watchPREvents(_filter: PRFilter): EventStream<PREvent> {
      return createStubEventStream();
    },
  };
}

// ── CIPipeline ───────────────────────────────────────────────────────

export function createGitLabCIPipeline(
  config: GitLabConfig,
  injectedClient?: HttpClient,
): CIPipeline {
  const client = injectedClient ?? createDefaultClient(config);

  return {
    async triggerBuild(input: TriggerBuildInput): Promise<Build> {
      const variables = input.parameters
        ? Object.entries(input.parameters).map(([key, value]) => ({ key, value }))
        : [];
      const res = await client(apiUrl(config, '/pipeline'), {
        method: 'POST',
        body: JSON.stringify({ ref: input.branch, variables }),
      });
      if (!res.ok) throw new Error(`GitLab triggerBuild failed: ${res.status}`);
      const data = await res.json();
      return { id: String(data.id), status: data.status, url: data.web_url };
    },

    async getBuildStatus(id: string): Promise<BuildStatus> {
      const res = await client(apiUrl(config, `/pipelines/${id}`));
      if (!res.ok) throw new Error(`GitLab getBuildStatus failed: ${res.status}`);
      const data = await res.json();
      return {
        id: String(data.id),
        status: mapGitLabPipelineStatus(data.status),
        startedAt: data.started_at ?? undefined,
        completedAt: data.finished_at ?? undefined,
      };
    },

    async getTestResults(buildId: string): Promise<TestResults> {
      const res = await client(apiUrl(config, `/pipelines/${buildId}/test_report`));
      if (!res.ok) return { passed: 0, failed: 0, skipped: 0 };
      const data = await res.json();
      return {
        passed: data.total_count - data.failed_count - data.skipped_count,
        failed: data.failed_count,
        skipped: data.skipped_count,
        duration: data.total_time,
      };
    },

    async getCoverageReport(buildId: string): Promise<CoverageReport> {
      // GitLab returns coverage from pipeline jobs
      const res = await client(apiUrl(config, `/pipelines/${buildId}/jobs`));
      if (!res.ok) return { lineCoverage: 0 };
      const jobs = (await res.json()) as Array<{ coverage: number | null }>;
      const coverages = jobs.map((j) => j.coverage).filter((c): c is number => c !== null);
      if (coverages.length === 0) return { lineCoverage: 0 };
      const avg = coverages.reduce((a, b) => a + b, 0) / coverages.length;
      return { lineCoverage: avg };
    },

    watchBuildEvents(_filter: BuildFilter): EventStream<BuildEvent> {
      return createStubEventStream();
    },
  };
}

// ── Mappers ──────────────────────────────────────────────────────────

function mapMergeRequest(data: Record<string, unknown>): PullRequest {
  return {
    id: String(data.iid),
    title: data.title as string,
    description: (data.description as string) ?? undefined,
    sourceBranch: data.source_branch as string,
    targetBranch: data.target_branch as string,
    status: data.state === 'merged' ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
    author: (data.author as Record<string, string>)?.username ?? '',
    url: data.web_url as string,
  };
}

function mapGitLabPipelineStatus(status: string): BuildStatus['status'] {
  const map: Record<string, BuildStatus['status']> = {
    created: 'pending',
    waiting_for_resource: 'pending',
    preparing: 'pending',
    pending: 'pending',
    running: 'running',
    success: 'succeeded',
    failed: 'failed',
    canceled: 'cancelled',
    skipped: 'cancelled',
    manual: 'pending',
    scheduled: 'pending',
  };
  return map[status] ?? 'pending';
}
