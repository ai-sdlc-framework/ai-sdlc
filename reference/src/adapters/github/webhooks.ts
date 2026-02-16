/**
 * GitHub webhook signature verification and event transformers.
 * Converts raw GitHub webhook payloads into typed adapter events.
 * <!-- Source: PRD Section 9 -->
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IssueEvent, PREvent, BuildEvent, Issue, PullRequest, Build } from '../interfaces.js';
import type { WebhookBridge } from '../webhook-bridge.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GitHubWebhookConfig {
  /** HMAC secret for verifying GitHub webhook signatures. */
  secret: string;
}

export interface GitHubWebhookBridges {
  issues?: WebhookBridge<IssueEvent>;
  pullRequests?: WebhookBridge<PREvent>;
  builds?: WebhookBridge<BuildEvent>;
}

// ── Raw GitHub payload types (minimal) ───────────────────────────────

interface GitHubIssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body?: string | null;
    state: string;
    labels: Array<{ name: string }>;
    assignee?: { login: string } | null;
    html_url: string;
  };
}

interface GitHubPRPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body?: string | null;
    head: { ref: string };
    base: { ref: string };
    state: string;
    merged: boolean;
    user: { login: string };
    html_url: string;
  };
}

interface GitHubWorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    conclusion: string | null;
    html_url: string;
    status: string;
  };
}

interface GitHubCheckRunPayload {
  action: string;
  check_run: {
    id: number;
    conclusion: string | null;
    html_url: string;
    status: string;
  };
}

// ── Signature Verification ───────────────────────────────────────────

/**
 * Verify GitHub HMAC SHA-256 webhook signature.
 * Expects `x-hub-signature-256` header in the format `sha256=<hex>`.
 */
export function verifyGitHubSignature(
  secret: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
): boolean {
  const signature = headers['x-hub-signature-256'];
  if (!signature) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Event Transformers ───────────────────────────────────────────────

function mapGitHubIssue(raw: GitHubIssuePayload['issue']): Issue {
  return {
    id: String(raw.number),
    title: raw.title,
    description: raw.body ?? undefined,
    status: raw.state,
    labels: raw.labels.map((l) => l.name),
    assignee: raw.assignee?.login,
    url: raw.html_url,
  };
}

function mapGitHubPR(raw: GitHubPRPayload['pull_request']): PullRequest {
  return {
    id: String(raw.number),
    title: raw.title,
    description: raw.body ?? undefined,
    sourceBranch: raw.head.ref,
    targetBranch: raw.base.ref,
    status: raw.merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
    author: raw.user.login,
    url: raw.html_url,
  };
}

/**
 * Transform a raw GitHub issue webhook payload into an IssueEvent.
 * Returns null for unrecognized actions.
 */
export function transformIssueEvent(payload: unknown): IssueEvent | null {
  const p = payload as GitHubIssuePayload;
  if (!p?.issue || !p?.action) return null;

  const actionMap: Record<string, IssueEvent['type']> = {
    opened: 'created',
    edited: 'updated',
    closed: 'transitioned',
    reopened: 'transitioned',
  };

  const type = actionMap[p.action];
  if (!type) return null;

  return {
    type,
    issue: mapGitHubIssue(p.issue),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Transform a raw GitHub PR webhook payload into a PREvent.
 * Returns null for unrecognized actions.
 */
export function transformPREvent(payload: unknown): PREvent | null {
  const p = payload as GitHubPRPayload;
  if (!p?.pull_request || !p?.action) return null;

  let type: PREvent['type'];
  switch (p.action) {
    case 'opened':
      type = 'opened';
      break;
    case 'synchronize':
      type = 'updated';
      break;
    case 'closed':
      type = p.pull_request.merged ? 'merged' : 'closed';
      break;
    default:
      return null;
  }

  return {
    type,
    pullRequest: mapGitHubPR(p.pull_request),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Transform a raw GitHub workflow_run or check_run webhook into a BuildEvent.
 * Returns null for unrecognized actions/payloads.
 */
export function transformBuildEvent(payload: unknown): BuildEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  // workflow_run events
  if (p.workflow_run && p.action === 'completed') {
    const wf = p as unknown as GitHubWorkflowRunPayload;
    const run = wf.workflow_run;
    const build: Build = {
      id: String(run.id),
      status: run.conclusion ?? 'unknown',
      url: run.html_url,
    };
    return {
      type: run.conclusion === 'failure' ? 'failed' : 'completed',
      build,
      timestamp: new Date().toISOString(),
    };
  }

  // check_run events
  if (p.check_run && p.action === 'completed') {
    const cr = p as unknown as GitHubCheckRunPayload;
    const run = cr.check_run;
    const build: Build = {
      id: String(run.id),
      status: run.conclusion ?? 'unknown',
      url: run.html_url,
    };
    return {
      type: run.conclusion === 'failure' ? 'failed' : 'completed',
      build,
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

// ── Provider Factory ─────────────────────────────────────────────────

/**
 * Create a GitHub webhook provider config for use with the webhook server.
 * Routes events to the appropriate WebhookBridge instances.
 */
export function createGitHubWebhookProvider(
  webhookConfig: GitHubWebhookConfig,
  bridges: GitHubWebhookBridges,
  path = '/webhooks/github',
) {
  return {
    path,
    verifySignature: (headers: Record<string, string | undefined>, body: Buffer) =>
      verifyGitHubSignature(webhookConfig.secret, headers, body),
    onEvent: (headers: Record<string, string | undefined>, payload: unknown) => {
      const eventType = headers['x-github-event'];

      switch (eventType) {
        case 'issues':
          if (bridges.issues) bridges.issues.push(payload);
          break;
        case 'pull_request':
          if (bridges.pullRequests) bridges.pullRequests.push(payload);
          break;
        case 'workflow_run':
        case 'check_run':
          if (bridges.builds) bridges.builds.push(payload);
          break;
      }
    },
  };
}
