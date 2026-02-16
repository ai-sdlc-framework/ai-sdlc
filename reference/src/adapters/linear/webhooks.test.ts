import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyLinearSignature,
  transformLinearIssueEvent,
  createLinearWebhookProvider,
} from './webhooks.js';

describe('verifyLinearSignature', () => {
  const secret = 'linear-secret';
  const body = Buffer.from('{"test":true}');

  function sign(content: Buffer, key: string): string {
    return createHmac('sha256', key).update(content).digest('hex');
  }

  it('accepts valid signature', () => {
    const headers = { 'x-linear-signature': sign(body, secret) };
    expect(verifyLinearSignature(secret, headers, body)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(verifyLinearSignature(secret, { 'x-linear-signature': 'bad' }, body)).toBe(false);
  });

  it('rejects missing signature', () => {
    expect(verifyLinearSignature(secret, {}, body)).toBe(false);
  });

  it('rejects wrong secret', () => {
    const headers = { 'x-linear-signature': sign(body, 'wrong') };
    expect(verifyLinearSignature(secret, headers, body)).toBe(false);
  });
});

describe('transformLinearIssueEvent', () => {
  const basePayload = {
    action: 'create',
    type: 'Issue',
    data: {
      id: 'issue-1',
      title: 'Linear Issue',
      description: 'Details',
      state: { name: 'Todo' },
      labels: { nodes: [{ name: 'feature' }] },
      assignee: { name: 'Bob' },
      url: 'https://linear.app/team/issue-1',
    },
  };

  it('maps create action to created', () => {
    const event = transformLinearIssueEvent(basePayload);
    expect(event!.type).toBe('created');
    expect(event!.issue.id).toBe('issue-1');
    expect(event!.issue.title).toBe('Linear Issue');
    expect(event!.issue.labels).toEqual(['feature']);
    expect(event!.issue.assignee).toBe('Bob');
  });

  it('maps update action to updated', () => {
    const event = transformLinearIssueEvent({ ...basePayload, action: 'update' });
    expect(event!.type).toBe('updated');
  });

  it('returns null for non-Issue type', () => {
    expect(transformLinearIssueEvent({ ...basePayload, type: 'Comment' })).toBeNull();
  });

  it('returns null for unknown action', () => {
    expect(transformLinearIssueEvent({ ...basePayload, action: 'remove' })).toBeNull();
  });

  it('returns null for invalid payload', () => {
    expect(transformLinearIssueEvent(null)).toBeNull();
    expect(transformLinearIssueEvent({})).toBeNull();
  });

  it('handles missing optional fields', () => {
    const event = transformLinearIssueEvent({
      ...basePayload,
      data: { ...basePayload.data, labels: undefined, assignee: null, description: undefined },
    });
    expect(event!.issue.labels).toEqual([]);
    expect(event!.issue.assignee).toBeUndefined();
    expect(event!.issue.description).toBeUndefined();
  });
});

describe('createLinearWebhookProvider', () => {
  it('routes events to issues bridge', () => {
    const received: unknown[] = [];
    const provider = createLinearWebhookProvider(
      { signingSecret: 'test' },
      { issues: { push: (p) => received.push(p) } },
    );
    provider.onEvent({}, { action: 'create', type: 'Issue' });
    expect(received).toHaveLength(1);
  });
});
