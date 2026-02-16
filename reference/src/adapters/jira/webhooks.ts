/**
 * Jira webhook verification and event transformers.
 * Jira Cloud uses a query parameter secret for webhook authentication.
 * <!-- Source: PRD Section 9 -->
 */

import type { IssueEvent, Issue } from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export interface JiraWebhookConfig {
  /** Secret token passed as query parameter for webhook verification. */
  secret: string;
}

// ── Verification ─────────────────────────────────────────────────────

/**
 * Verify Jira webhook by checking the secret query parameter.
 * The webhook URL should be configured as: /webhooks/jira?secret=<token>
 */
export function verifyJiraWebhook(
  secret: string,
  headers: Record<string, string | undefined>,
  _body: Buffer,
  querySecret?: string,
): boolean {
  // Jira webhooks can use a shared secret in the URL query parameter
  // or we can check a custom header
  if (querySecret) return querySecret === secret;
  // Fallback: check custom header
  const headerSecret = headers['x-jira-webhook-secret'];
  return headerSecret === secret;
}

// ── Event Transformers ───────────────────────────────────────────────

interface JiraWebhookPayload {
  webhookEvent: string;
  issue?: {
    key: string;
    fields: {
      summary: string;
      description?: unknown;
      status: { name: string };
      labels?: Array<{ name: string }> | string[];
      assignee?: { displayName: string } | null;
    };
    self: string;
  };
}

export function transformJiraIssueEvent(payload: unknown): IssueEvent | null {
  const p = payload as JiraWebhookPayload;
  if (!p?.webhookEvent || !p?.issue) return null;

  const eventMap: Record<string, IssueEvent['type']> = {
    'jira:issue_created': 'created',
    'jira:issue_updated': 'updated',
  };

  const type = eventMap[p.webhookEvent];
  if (!type) return null;

  const fields = p.issue.fields;
  const labels = (fields.labels ?? []).map((l) =>
    typeof l === 'string' ? l : (l as { name: string }).name,
  );

  const issue: Issue = {
    id: p.issue.key,
    title: fields.summary,
    description: typeof fields.description === 'string' ? fields.description : undefined,
    status: fields.status.name,
    labels,
    assignee: fields.assignee?.displayName,
    url: p.issue.self,
  };

  return { type, issue, timestamp: new Date().toISOString() };
}

/**
 * Create a Jira webhook provider config for use with the webhook server.
 */
export function createJiraWebhookProvider(
  webhookConfig: JiraWebhookConfig,
  bridges: { issues?: { push(payload: unknown): void } },
  path = '/webhooks/jira',
) {
  return {
    path,
    verifySignature: (headers: Record<string, string | undefined>, body: Buffer) =>
      verifyJiraWebhook(webhookConfig.secret, headers, body),
    onEvent: (_headers: Record<string, string | undefined>, payload: unknown) => {
      if (bridges.issues) bridges.issues.push(payload);
    },
  };
}
