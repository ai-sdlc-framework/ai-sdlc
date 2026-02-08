/**
 * Stub GitLab adapter for testing.
 * Implements CIPipeline and SourceControl interfaces in-memory.
 */

import type {
  CIPipeline,
  TriggerBuildInput,
  Build,
  BuildStatus,
  TestResults,
  CoverageReport,
  BuildFilter,
  BuildEvent,
  SourceControl,
  CreateBranchInput,
  Branch,
  CreatePRInput,
  PullRequest,
  MergeStrategy,
  MergeResult,
  FileContent,
  ChangedFile,
  CommitStatus,
  PRFilter,
  PREvent,
  EventStream,
} from '../interfaces.js';

export interface StubGitLabCIAdapter extends CIPipeline {
  getBuildCount(): number;
  getStoredBuild(id: string): BuildStatus | undefined;
}

export interface StubGitLabSourceAdapter extends SourceControl {
  getBranchCount(): number;
  getPRCount(): number;
}

function createStubEventStream<T>(): EventStream<T> {
  return {
    async *[Symbol.asyncIterator]() {
      // Stub: no events
    },
  };
}

export function createStubGitLabCI(): StubGitLabCIAdapter {
  const builds = new Map<string, { input: TriggerBuildInput; status: BuildStatus }>();
  let nextId = 1;

  return {
    async triggerBuild(input: TriggerBuildInput): Promise<Build> {
      const id = `gl-build-${nextId++}`;
      const status: BuildStatus = {
        id,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      builds.set(id, { input, status });
      return { id, status: 'succeeded', url: `https://gitlab.example.com/builds/${id}` };
    },

    async getBuildStatus(id: string): Promise<BuildStatus> {
      const build = builds.get(id);
      if (!build) throw new Error(`Build "${id}" not found`);
      return build.status;
    },

    async getTestResults(_buildId: string): Promise<TestResults> {
      return { passed: 10, failed: 0, skipped: 1, duration: 5000 };
    },

    async getCoverageReport(_buildId: string): Promise<CoverageReport> {
      return { lineCoverage: 85, branchCoverage: 78 };
    },

    watchBuildEvents(_filter: BuildFilter): EventStream<BuildEvent> {
      return createStubEventStream();
    },

    getBuildCount(): number {
      return builds.size;
    },

    getStoredBuild(id: string): BuildStatus | undefined {
      return builds.get(id)?.status;
    },
  };
}

export function createStubGitLabSource(): StubGitLabSourceAdapter {
  const branches = new Map<string, Branch>();
  const prs = new Map<string, PullRequest>();
  const statuses = new Map<string, CommitStatus>();
  let nextPRId = 1;

  return {
    async createBranch(input: CreateBranchInput): Promise<Branch> {
      const branch: Branch = { name: input.name, sha: `sha-${Date.now()}` };
      branches.set(input.name, branch);
      return branch;
    },

    async createPR(input: CreatePRInput): Promise<PullRequest> {
      const id = `gl-mr-${nextPRId++}`;
      const pr: PullRequest = {
        id,
        title: input.title,
        description: input.description,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        status: 'open',
        author: 'stub-user',
        url: `https://gitlab.example.com/merge_requests/${id}`,
      };
      prs.set(id, pr);
      return pr;
    },

    async mergePR(id: string, _strategy: MergeStrategy): Promise<MergeResult> {
      const pr = prs.get(id);
      if (!pr) throw new Error(`MR "${id}" not found`);
      pr.status = 'merged';
      return { sha: `merge-sha-${Date.now()}`, merged: true };
    },

    async getFileContents(path: string, _ref: string): Promise<FileContent> {
      return { path, content: '', encoding: 'utf-8' };
    },

    async listChangedFiles(_prId: string): Promise<ChangedFile[]> {
      return [];
    },

    async setCommitStatus(sha: string, status: CommitStatus): Promise<void> {
      statuses.set(sha, status);
    },

    watchPREvents(_filter: PRFilter): EventStream<PREvent> {
      return createStubEventStream();
    },

    getBranchCount(): number {
      return branches.size;
    },

    getPRCount(): number {
      return prs.size;
    },
  };
}
