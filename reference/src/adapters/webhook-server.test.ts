import { describe, it, expect, afterEach } from 'vitest';
import { createWebhookServer, type WebhookServer } from './webhook-server.js';

let server: WebhookServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

describe('WebhookServer', () => {
  it('starts and stops cleanly', async () => {
    server = createWebhookServer({ port: 0 });
    await server.start();
    expect(server.port).toBeGreaterThan(0);
    await server.stop();
    server = null;
  });

  it('responds to health check', async () => {
    server = createWebhookServer({ port: 0 });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.providers).toBe(0);
  });

  it('returns 405 for non-POST on webhook routes', async () => {
    server = createWebhookServer({ port: 0 });
    server.registerProvider({
      path: '/webhooks/test',
      verifySignature: () => true,
      onEvent: () => {},
    });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/webhooks/test`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('returns 404 for unknown routes', async () => {
    server = createWebhookServer({ port: 0 });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/unknown`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects requests with invalid signatures', async () => {
    server = createWebhookServer({ port: 0 });
    server.registerProvider({
      path: '/webhooks/test',
      verifySignature: () => false,
      onEvent: () => {},
    });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    expect(res.status).toBe(401);
  });

  it('dispatches verified payloads to provider', async () => {
    const received: unknown[] = [];
    server = createWebhookServer({ port: 0 });
    server.registerProvider({
      path: '/webhooks/test',
      verifySignature: () => true,
      onEvent: (_headers, body) => received.push(body),
    });
    await server.start();

    const payload = { action: 'opened', data: 42 };
    const res = await fetch(`http://127.0.0.1:${server.port}/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it('routes to correct provider by path prefix', async () => {
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    server = createWebhookServer({ port: 0 });
    server.registerProvider({
      path: '/webhooks/alpha',
      verifySignature: () => true,
      onEvent: (_h, body) => receivedA.push(body),
    });
    server.registerProvider({
      path: '/webhooks/beta',
      verifySignature: () => true,
      onEvent: (_h, body) => receivedB.push(body),
    });
    await server.start();

    await fetch(`http://127.0.0.1:${server.port}/webhooks/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'a' }),
    });

    await fetch(`http://127.0.0.1:${server.port}/webhooks/beta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'b' }),
    });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
    expect((receivedA[0] as Record<string, string>).provider).toBe('a');
    expect((receivedB[0] as Record<string, string>).provider).toBe('b');
  });

  it('returns 400 for malformed JSON', async () => {
    server = createWebhookServer({ port: 0 });
    server.registerProvider({
      path: '/webhooks/test',
      verifySignature: () => true,
      onEvent: () => {},
    });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
  });

  it('tracks provider count', () => {
    server = createWebhookServer({ port: 0 });
    expect(server.providerCount).toBe(0);

    server.registerProvider({
      path: '/a',
      verifySignature: () => true,
      onEvent: () => {},
    });
    expect(server.providerCount).toBe(1);

    server.registerProvider({
      path: '/b',
      verifySignature: () => true,
      onEvent: () => {},
    });
    expect(server.providerCount).toBe(2);
  });
});
