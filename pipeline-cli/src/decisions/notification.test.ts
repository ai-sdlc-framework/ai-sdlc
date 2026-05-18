/**
 * notification.ts unit tests — AISDLC-292 AC#4, AC#6.
 */

import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Decision } from './decision-record.js';
import { postSlackWebhook, sendDecisionNotifications } from './notification.js';

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDecision(overrides?: Partial<Decision['metadata']>): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id: 'DEC-0001',
      source: 'ad-hoc',
      scope: 'workspace',
      created: '2026-05-01T00:00:00Z',
      updated: '2026-05-01T00:00:00Z',
      ...overrides,
    },
    spec: {
      summary: 'Should we use approach A or B?',
      options: [
        { id: 'opt-a', description: 'Approach A' },
        { id: 'opt-b', description: 'Approach B' },
      ],
    },
    status: { lifecycle: 'open' },
    decisionLog: [],
  };
}

// ── No notifications when surfaces are disabled ───────────────────────────────

describe('sendDecisionNotifications — disabled surfaces', () => {
  it('returns empty array when no surfaces are enabled', async () => {
    const records = await sendDecisionNotifications(makeDecision(), 'opt-a', 'op@example.com', {
      slack: { enabled: false },
      email: { enabled: false },
    });
    expect(records).toEqual([]);
  });

  it('returns empty array when config is empty', async () => {
    const records = await sendDecisionNotifications(makeDecision(), 'opt-a', undefined, {});
    expect(records).toEqual([]);
  });
});

// ── Slack ─────────────────────────────────────────────────────────────────────

describe('sendDecisionNotifications — Slack', () => {
  it('skips Slack when enabled but no webhookUrl', async () => {
    const sender = vi.fn();
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      undefined,
      { slack: { enabled: true } },
      { httpSender: sender },
    );
    expect(sender).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('posts to Slack when enabled + webhookUrl configured', async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      'op@example.com',
      { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/X' } },
      { httpSender: sender },
    );
    expect(sender).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T/B/X',
      expect.stringContaining('DEC-0001'),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.surface).toBe('slack');
    expect(records[0]!.status).toBe('sent');
    expect(records[0]!.decisionId).toBe('DEC-0001');
    expect(records[0]!.chosenOptionId).toBe('opt-a');
  });

  it('marks record as failed when Slack returns non-2xx', async () => {
    const sender = vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 403' });
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      undefined,
      { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/X' } },
      { httpSender: sender },
    );
    expect(records[0]!.status).toBe('failed');
    expect(records[0]!.error).toBe('HTTP 403');
  });

  it('marks record as failed when sender throws', async () => {
    const sender = vi.fn().mockRejectedValue(new Error('network down'));
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      undefined,
      { slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/X' } },
      { httpSender: sender },
    );
    expect(records[0]!.status).toBe('failed');
    expect(records[0]!.error).toBe('network down');
  });
});

// ── Email ─────────────────────────────────────────────────────────────────────

describe('sendDecisionNotifications — email', () => {
  it('skips email when enabled but recipients is empty', async () => {
    const writer = vi.fn();
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      undefined,
      { email: { enabled: true, recipients: [] } },
      { jsonlWriter: writer },
    );
    expect(writer).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('writes one record per recipient when enabled', async () => {
    const writer = vi.fn().mockReturnValue(true);
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      'op@example.com',
      { email: { enabled: true, recipients: ['a@example.com', 'b@example.com'] } },
      { jsonlWriter: writer, artifactsDir: '/tmp/test-artifacts' },
    );
    expect(writer).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
    expect(records[0]!.surface).toBe('email');
    expect(records[0]!.target).toBe('a@example.com');
    expect(records[0]!.status).toBe('queued');
    expect(records[1]!.target).toBe('b@example.com');
  });

  it('marks email record failed when writer returns false', async () => {
    const writer = vi.fn().mockReturnValue(false);
    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-a',
      undefined,
      { email: { enabled: true, recipients: ['x@example.com'] } },
      { jsonlWriter: writer },
    );
    expect(records[0]!.status).toBe('failed');
    expect(records[0]!.error).toBe('write failed (see stderr)');
  });
});

// ── Multi-surface ─────────────────────────────────────────────────────────────

describe('sendDecisionNotifications — multi-surface', () => {
  it('fires both Slack and email in parallel and returns all records', async () => {
    const slackSender = vi.fn().mockResolvedValue({ ok: true });
    const writer = vi.fn().mockReturnValue(true);

    const records = await sendDecisionNotifications(
      makeDecision(),
      'opt-b',
      'op@example.com',
      {
        slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        email: { enabled: true, recipients: ['a@example.com'] },
      },
      { httpSender: slackSender, jsonlWriter: writer },
    );

    expect(records).toHaveLength(2);
    const surfaces = records.map((r) => r.surface).sort();
    expect(surfaces).toEqual(['email', 'slack']);
  });
});

// ── postSlackWebhook direct tests ─────────────────────────────────────────────

describe('postSlackWebhook — direct', () => {
  it('returns ok:false with explicit error for invalid URL', async () => {
    const result = await postSlackWebhook('not a url', '{}');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid webhook URL');
  });

  it('returns ok:true on 2xx HTTP response', async () => {
    const server: Server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await postSlackWebhook(`http://127.0.0.1:${port}/hook`, '{"x":1}');
      expect(result.ok).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns ok:false with HTTP <status> on non-2xx', async () => {
    const server: Server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await postSlackWebhook(`http://127.0.0.1:${port}/hook`, '{}');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('500');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('returns ok:false on connection error', async () => {
    const result = await postSlackWebhook('http://127.0.0.1:1/hook', '{}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
