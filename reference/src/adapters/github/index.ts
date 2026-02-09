/**
 * GitHub adapter — implements SourceControl, IssueTracker, and CIPipeline interfaces.
 *
 * SourceControl and IssueTracker use @octokit/rest.
 * CIPipeline remains a stub (GitHub Actions API integration is out of scope).
 * watchIssues/watchPREvents return empty async iterators (webhooks needed for real impl).
 */

import { Octokit } from '@octokit/rest';
import { resolveSecret } from '../resolve-secret.js';
import type {
  SourceControl,
  IssueTracker,
  IssueComment,
  CIPipeline,
  Issue,
  IssueFilter,
  CreateIssueInput,
  UpdateIssueInput,
  EventStream,
  IssueEvent,
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
  TriggerBuildInput,
  Build,
  BuildStatus,
  TestResults,
  CoverageReport,
  BuildFilter,
  BuildEvent,
} from '../interfaces.js';

export type GitHubConfig = {
  org: string;
  repo?: string;
  token?: { secretRef: string };
};

// ── Internal helpers ──────────────────────────────────────────────────

function createOctokit(config: GitHubConfig): Octokit {
  const token = config.token ? resolveSecret(config.token.secretRef) : undefined;
  return new Octokit({ auth: token });
}

function getOwnerRepo(config: GitHubConfig): { owner: string; repo: string } {
  if (!config.repo) {
    throw new Error('GitHubConfig.repo is required for this operation');
  }
  return { owner: config.org, repo: config.repo };
}

function mapGitHubIssue(gh: {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: unknown[];
  assignee?: { login: string } | null;
  html_url: string;
}): Issue {
  return {
    id: String(gh.number),
    title: gh.title,
    description: gh.body ?? undefined,
    status: gh.state,
    labels: (gh.labels as Array<{ name?: string } | string>)
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter(Boolean),
    assignee: gh.assignee?.login,
    url: gh.html_url,
  };
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub — real implementation requires webhook ingestion
    },
  };
}

// ── IssueTracker ──────────────────────────────────────────────────────

export function createGitHubIssueTracker(config: GitHubConfig): IssueTracker {
  const octokit = createOctokit(config);
  const ownerRepo = getOwnerRepo(config);

  return {
    async listIssues(filter: IssueFilter): Promise<Issue[]> {
      const params: Record<string, unknown> = {
        ...ownerRepo,
        per_page: 100,
      };
      if (filter.status) {
        params.state = filter.status === 'closed' ? 'closed' : 'open';
      }
      if (filter.labels?.length) {
        params.labels = filter.labels.join(',');
      }
      if (filter.assignee) {
        params.assignee = filter.assignee;
      }
      const { data } = await octokit.issues.listForRepo(
        params as Parameters<typeof octokit.issues.listForRepo>[0],
      );
      // Filter out pull requests (GitHub treats them as issues)
      return data.filter((i) => !i.pull_request).map(mapGitHubIssue);
    },

    async getIssue(id: string): Promise<Issue> {
      const { data } = await octokit.issues.get({
        ...ownerRepo,
        issue_number: Number(id),
      });
      return mapGitHubIssue(data);
    },

    async createIssue(input: CreateIssueInput): Promise<Issue> {
      const { data } = await octokit.issues.create({
        ...ownerRepo,
        title: input.title,
        body: input.description,
        labels: input.labels,
        assignees: input.assignee ? [input.assignee] : undefined,
      });
      return mapGitHubIssue(data);
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<Issue> {
      const { data } = await octokit.issues.update({
        ...ownerRepo,
        issue_number: Number(id),
        title: input.title,
        body: input.description,
        labels: input.labels,
        assignees: input.assignee ? [input.assignee] : undefined,
      });
      return mapGitHubIssue(data);
    },

    async transitionIssue(id: string, transition: string): Promise<Issue> {
      const state = transition === 'close' ? 'closed' : 'open';
      const { data } = await octokit.issues.update({
        ...ownerRepo,
        issue_number: Number(id),
        state: state as 'open' | 'closed',
      });
      return mapGitHubIssue(data);
    },

    async addComment(id: string, body: string): Promise<void> {
      await octokit.issues.createComment({
        ...ownerRepo,
        issue_number: Number(id),
        body,
      });
    },

    async getComments(id: string): Promise<IssueComment[]> {
      const { data } = await octokit.issues.listComments({
        ...ownerRepo,
        issue_number: Number(id),
        per_page: 100,
      });
      return data.map((c) => ({ body: c.body ?? '' }));
    },

    watchIssues(_filter: IssueFilter): EventStream<IssueEvent> {
      return createStubEventStream();
    },
  };
}

// ── SourceControl ─────────────────────────────────────────────────────

export function createGitHubSourceControl(config: GitHubConfig): SourceControl {
  const octokit = createOctokit(config);
  const ownerRepo = getOwnerRepo(config);

  return {
    async createBranch(input: CreateBranchInput): Promise<Branch> {
      const fromRef = input.from ?? 'heads/main';
      const ref = fromRef.startsWith('heads/') ? fromRef : `heads/${fromRef}`;
      const { data: refData } = await octokit.git.getRef({
        ...ownerRepo,
        ref,
      });
      const sha = refData.object.sha;
      try {
        await octokit.git.createRef({
          ...ownerRepo,
          ref: `refs/heads/${input.name}`,
          sha,
        });
      } catch (err: unknown) {
        // Branch already exists — update it to point to the latest SHA
        const status = (err as { status?: number }).status;
        if (status === 422) {
          await octokit.git.updateRef({
            ...ownerRepo,
            ref: `heads/${input.name}`,
            sha,
            force: true,
          });
        } else {
          throw err;
        }
      }
      return { name: input.name, sha };
    },

    async createPR(input: CreatePRInput): Promise<PullRequest> {
      const { data } = await octokit.pulls.create({
        ...ownerRepo,
        title: input.title,
        body: input.description,
        head: input.sourceBranch,
        base: input.targetBranch,
      });
      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? undefined,
        sourceBranch: data.head.ref,
        targetBranch: data.base.ref,
        status: data.merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
        author: data.user?.login ?? '',
        url: data.html_url,
      };
    },

    async mergePR(id: string, strategy: MergeStrategy): Promise<MergeResult> {
      const mergeMethodMap: Record<MergeStrategy, 'merge' | 'squash' | 'rebase'> = {
        merge: 'merge',
        squash: 'squash',
        rebase: 'rebase',
      };
      const { data } = await octokit.pulls.merge({
        ...ownerRepo,
        pull_number: Number(id),
        merge_method: mergeMethodMap[strategy],
      });
      return { sha: data.sha, merged: data.merged };
    },

    async getFileContents(path: string, ref: string): Promise<FileContent> {
      const { data } = await octokit.repos.getContent({
        ...ownerRepo,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file') {
        throw new Error(`Path "${path}" is not a file`);
      }
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return { path: data.path, content, encoding: 'utf-8' };
    },

    async listChangedFiles(prId: string): Promise<ChangedFile[]> {
      const { data } = await octokit.pulls.listFiles({
        ...ownerRepo,
        pull_number: Number(prId),
        per_page: 100,
      });
      return data.map((f) => ({
        path: f.filename,
        status: (f.status === 'removed' ? 'deleted' : f.status) as ChangedFile['status'],
        additions: f.additions,
        deletions: f.deletions,
      }));
    },

    async setCommitStatus(sha: string, status: CommitStatus): Promise<void> {
      await octokit.repos.createCommitStatus({
        ...ownerRepo,
        sha,
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.targetUrl,
      });
    },

    watchPREvents(_filter: PRFilter): EventStream<PREvent> {
      return createStubEventStream();
    },
  };
}

// ── CIPipeline ────────────────────────────────────────────────────────

export function createGitHubCIPipeline(
  config: GitHubConfig & { workflowFile?: string },
): CIPipeline {
  const octokit = createOctokit(config);
  const ownerRepo = getOwnerRepo(config);
  const workflowFile = config.workflowFile ?? 'ci.yml';

  return {
    async triggerBuild(input: TriggerBuildInput): Promise<Build> {
      await octokit.actions.createWorkflowDispatch({
        ...ownerRepo,
        workflow_id: workflowFile,
        ref: input.branch,
        inputs: input.parameters,
      });

      // GitHub doesn't return the run ID from dispatch — poll for the latest run
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        ...ownerRepo,
        workflow_id: workflowFile,
        branch: input.branch,
        per_page: 1,
      });

      const run = runs.workflow_runs[0];
      return {
        id: run ? String(run.id) : 'pending',
        status: run?.status ?? 'queued',
        url: run?.html_url,
      };
    },

    async getBuildStatus(id: string): Promise<BuildStatus> {
      const { data } = await octokit.actions.getWorkflowRun({
        ...ownerRepo,
        run_id: Number(id),
      });

      const statusMap: Record<string, BuildStatus['status']> = {
        queued: 'pending',
        in_progress: 'running',
        completed: 'succeeded',
        cancelled: 'cancelled',
      };

      let status = statusMap[data.status ?? 'queued'] ?? 'pending';
      // Override status based on conclusion for completed runs
      if (data.status === 'completed') {
        if (data.conclusion === 'failure' || data.conclusion === 'timed_out') {
          status = 'failed';
        } else if (data.conclusion === 'cancelled') {
          status = 'cancelled';
        }
      }

      return {
        id: String(data.id),
        status,
        startedAt: data.run_started_at ?? undefined,
        completedAt: data.updated_at ?? undefined,
      };
    },

    async getTestResults(buildId: string): Promise<TestResults> {
      // Extract test results from check runs associated with the workflow run
      const { data } = await octokit.checks.listForSuite({
        ...ownerRepo,
        check_suite_id: Number(buildId),
      });

      let passed = 0;
      let failed = 0;
      let skipped = 0;

      for (const check of data.check_runs) {
        if (check.conclusion === 'success') passed++;
        else if (check.conclusion === 'failure') failed++;
        else if (check.conclusion === 'skipped' || check.conclusion === 'neutral') skipped++;
      }

      // If no check runs found, return zero counts
      return { passed, failed, skipped };
    },

    async getCoverageReport(buildId: string): Promise<CoverageReport> {
      // Best-effort: try to find coverage data from artifacts
      try {
        const { data } = await octokit.actions.listWorkflowRunArtifacts({
          ...ownerRepo,
          run_id: Number(buildId),
        });

        const coverageArtifact = data.artifacts.find((a) => a.name.includes('coverage'));

        if (!coverageArtifact) {
          return { lineCoverage: 0 };
        }

        // Return placeholder — actual coverage parsing depends on format
        return { lineCoverage: 0, branchCoverage: 0, functionCoverage: 0 };
      } catch {
        return { lineCoverage: 0 };
      }
    },

    watchBuildEvents(_filter: BuildFilter): EventStream<BuildEvent> {
      return createStubEventStream();
    },
  };
}
