/**
 * Stub Bitbucket adapter for testing.
 * Implements SourceControl interface in-memory.
 */

import type {
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

export interface StubBitbucketAdapter extends SourceControl {
  getBranchCount(): number;
  getPRCount(): number;
  getStoredPR(id: string): PullRequest | undefined;
}

export function createStubBitbucket(): StubBitbucketAdapter {
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
      const id = `bb-pr-${nextPRId++}`;
      const pr: PullRequest = {
        id,
        title: input.title,
        description: input.description,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        status: 'open',
        author: 'stub-user',
        url: `https://bitbucket.org/pull-requests/${id}`,
      };
      prs.set(id, pr);
      return pr;
    },

    async mergePR(id: string, _strategy: MergeStrategy): Promise<MergeResult> {
      const pr = prs.get(id);
      if (!pr) throw new Error(`PR "${id}" not found`);
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
      return {
        async *[Symbol.asyncIterator]() {
          // Stub: no events
        },
      };
    },

    getBranchCount(): number {
      return branches.size;
    },

    getPRCount(): number {
      return prs.size;
    },

    getStoredPR(id: string): PullRequest | undefined {
      return prs.get(id);
    },
  };
}
