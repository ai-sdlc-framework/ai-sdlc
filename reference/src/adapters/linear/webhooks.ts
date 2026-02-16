/**
 * Linear webhook verification and event transformers.
 * Linear uses HMAC SHA-256 via X-Linear-Signature header.
 * <!-- Source: PRD Section 9 -->
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IssueEvent, Issue } from '../interfaces.js';

// ── Types ────────────────────────────────────────────────────────────

export interface LinearWebhookConfig {
  /** Signing secret for Linear webhooks. */
  signingSecret: string;
}

// ── Signature Verification ───────────────────────────────────────────

/**
 * Verify Linear webhook HMAC SHA-256 signature.
 * Linear sends the signature in the X-Linear-Signature header as raw hex.
 */
export function verifyLinearSignature(
  signingSecret: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
): boolean {
  const signature = headers['x-linear-signature'];
  if (!signature) return false;

  const expected = createHmac('sha256', signingSecret).update(body).digest('hex');

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Event Transformers ───────────────────────────────────────────────

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    title: string;
    description?: string;
    state?: { name: string };
    labels?: { nodes: Array<{ name: string }> };
    assignee?: { name: string } | null;
    url: string;
  };
}

export function transformLinearIssueEvent(payload: unknown): IssueEvent | null {
  const p = payload as LinearWebhookPayload;
  if (!p?.data || p.type !== 'Issue') return null;

  const actionMap: Record<string, IssueEvent['type']> = {
    create: 'created',
    update: 'updated',
  };

  const type = actionMap[p.action];
  if (!type) return null;

  const issue: Issue = {
    id: p.data.id,
    title: p.data.title,
    description: p.data.description,
    status: p.data.state?.name ?? 'unknown',
    labels: p.data.labels?.nodes.map((l) => l.name) ?? [],
    assignee: p.data.assignee?.name,
    url: p.data.url,
  };

  return { type, issue, timestamp: new Date().toISOString() };
}

/**
 * Create a Linear webhook provider config for use with the webhook server.
 */
export function createLinearWebhookProvider(
  webhookConfig: LinearWebhookConfig,
  bridges: { issues?: { push(payload: unknown): void } },
  path = '/webhooks/linear',
) {
  return {
    path,
    verifySignature: (headers: Record<string, string | undefined>, body: Buffer) =>
      verifyLinearSignature(webhookConfig.signingSecret, headers, body),
    onEvent: (_headers: Record<string, string | undefined>, payload: unknown) => {
      if (bridges.issues) bridges.issues.push(payload);
    },
  };
}
