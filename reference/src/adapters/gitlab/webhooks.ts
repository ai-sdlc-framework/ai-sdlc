/**
 * GitLab webhook verification and event transformers.
 * GitLab uses X-Gitlab-Token header for webhook authentication.
 * <!-- Source: PRD Section 9 -->
 */

import type { IssueEvent, PREvent, BuildEvent, Issue, PullRequest, Build } from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GitLabWebhookConfig {
  /** Secret token for verifying GitLab webhooks (X-Gitlab-Token). */
  secretToken: string;
}

// ── Signature Verification ───────────────────────────────────────────

/**
 * Verify GitLab webhook secret token.
 * GitLab sends the secret in the X-Gitlab-Token header (plain text comparison).
 */
export function verifyGitLabToken(
  secretToken: string,
  headers: Record<string, string | undefined>,
): boolean {
  const token = headers['x-gitlab-token'];
  if (!token) return false;
  return token === secretToken;
}

// ── Event Transformers ───────────────────────────────────────────────

interface GitLabMRPayload {
  event_type: string;
  object_attributes: {
    iid: number;
    title: string;
    description?: string;
    source_branch: string;
    target_branch: string;
    state: string;
    action: string;
    url: string;
    author_id: number;
  };
  user: { username: string };
}

interface GitLabPipelinePayload {
  object_kind: string;
  object_attributes: {
    id: number;
    status: string;
    ref: string;
    detailed_status?: string;
  };
}

interface GitLabIssuePayload {
  event_type: string;
  object_attributes: {
    iid: number;
    title: string;
    description?: string;
    state: string;
    action: string;
    url: string;
    labels?: Array<{ title: string }>;
  };
  assignees?: Array<{ username: string }>;
}

export function transformGitLabIssueEvent(payload: unknown): IssueEvent | null {
  const p = payload as GitLabIssuePayload;
  if (!p?.object_attributes || p.event_type !== 'issue') return null;

  const actionMap: Record<string, IssueEvent['type']> = {
    open: 'created',
    update: 'updated',
    close: 'transitioned',
    reopen: 'transitioned',
  };

  const type = actionMap[p.object_attributes.action];
  if (!type) return null;

  const issue: Issue = {
    id: String(p.object_attributes.iid),
    title: p.object_attributes.title,
    description: p.object_attributes.description,
    status: p.object_attributes.state,
    labels: p.object_attributes.labels?.map((l) => l.title) ?? [],
    assignee: p.assignees?.[0]?.username,
    url: p.object_attributes.url,
  };

  return { type, issue, timestamp: new Date().toISOString() };
}

export function transformGitLabMREvent(payload: unknown): PREvent | null {
  const p = payload as GitLabMRPayload;
  if (!p?.object_attributes || p.event_type !== 'merge_request') return null;

  let type: PREvent['type'];
  switch (p.object_attributes.action) {
    case 'open':
      type = 'opened';
      break;
    case 'update':
      type = 'updated';
      break;
    case 'merge':
      type = 'merged';
      break;
    case 'close':
      type = 'closed';
      break;
    default:
      return null;
  }

  const pr: PullRequest = {
    id: String(p.object_attributes.iid),
    title: p.object_attributes.title,
    description: p.object_attributes.description,
    sourceBranch: p.object_attributes.source_branch,
    targetBranch: p.object_attributes.target_branch,
    status: p.object_attributes.state === 'merged' ? 'merged' : p.object_attributes.state === 'closed' ? 'closed' : 'open',
    author: p.user?.username ?? '',
    url: p.object_attributes.url,
  };

  return { type, pullRequest: pr, timestamp: new Date().toISOString() };
}

export function transformGitLabPipelineEvent(payload: unknown): BuildEvent | null {
  const p = payload as GitLabPipelinePayload;
  if (!p?.object_attributes || p.object_kind !== 'pipeline') return null;

  const status = p.object_attributes.status;
  if (status !== 'success' && status !== 'failed') return null;

  const build: Build = {
    id: String(p.object_attributes.id),
    status,
  };

  return {
    type: status === 'failed' ? 'failed' : 'completed',
    build,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a GitLab webhook provider config for use with the webhook server.
 */
export function createGitLabWebhookProvider(
  webhookConfig: GitLabWebhookConfig,
  bridges: {
    issues?: { push(payload: unknown): void };
    mergeRequests?: { push(payload: unknown): void };
    pipelines?: { push(payload: unknown): void };
  },
  path = '/webhooks/gitlab',
) {
  return {
    path,
    verifySignature: (headers: Record<string, string | undefined>, _body: Buffer) =>
      verifyGitLabToken(webhookConfig.secretToken, headers),
    onEvent: (headers: Record<string, string | undefined>, payload: unknown) => {
      const eventType = headers['x-gitlab-event'];

      if (eventType === 'Issue Hook' && bridges.issues) {
        bridges.issues.push(payload);
      } else if (eventType === 'Merge Request Hook' && bridges.mergeRequests) {
        bridges.mergeRequests.push(payload);
      } else if (eventType === 'Pipeline Hook' && bridges.pipelines) {
        bridges.pipelines.push(payload);
      }
    },
  };
}
