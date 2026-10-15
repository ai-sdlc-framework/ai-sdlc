import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createReceiver,
  eventFileName,
  touchWakeFile,
  WEBHOOK_PATH,
  type Receiver,
} from './webhook-receiver.js';

const SECRET = 's3cret';
const SHA = 'a'.repeat(40);
let dir: string;
let receiver: Receiver;
let wake: Mock<() => void>;

const sign = (body: string, secret = SECRET): string =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const checkRun = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    repository: { full_name: 'o/r', private: true },
    check_run: { head_sha: SHA, pull_requests: [{ number: 7 }], name: 'secret-name' },
    sender: { login: 'x' },
    ...extra,
  });

async function post(body: string, headers: Record<string, string>): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${receiver.port}${WEBHOOK_PATH}`, {
    method: 'POST',
    body,
    headers,
  });
  return { status: res.status };
}

const good = (body: string, id: string, event = 'check_run'): Record<string, string> => ({
  'x-hub-signature-256': sign(body),
  'x-github-event': event,
  'x-github-delivery': id,
});

const eventFiles = (): string[] => {
  try {
    return readdirSync(path.join(dir, 'events'));
  } catch {
    return [];
  }
};

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'webhook-'));
  wake = vi.fn<() => void>();
  receiver = createReceiver({
    secret: SECRET,
    boardDir: dir,
    port: 0,
    debounceMs: 40,
    now: () => new Date('2026-10-15T00:00:00.000Z'),
    wake,
  });
  await receiver.start();
});

afterEach(async () => {
  await receiver.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('webhook receiver (AISDLC-880)', () => {
  it('writes exactly one record with only the recorded fields; a replay writes nothing and returns 200', async () => {
    const body = checkRun();
    expect((await post(body, good(body, 'd-1'))).status).toBe(200);
    expect((await post(body, good(body, 'd-1'))).status).toBe(200);
    const files = eventFiles();
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(path.join(dir, 'events', files[0] as string), 'utf-8'));
    expect(rec).toEqual({
      repo: 'o/r',
      pr: 7,
      headSha: SHA,
      kind: 'check_run',
      deliveryId: 'd-1',
      receivedAt: '2026-10-15T00:00:00.000Z',
    });
    expect(files[0]).toBe(eventFileName(rec));
  });

  it('returns 401 and writes nothing for a missing or wrong signature (forged body)', async () => {
    const body = checkRun();
    const base = { 'x-github-event': 'check_run', 'x-github-delivery': 'd-2' };
    expect((await post(body, base)).status).toBe(401);
    expect((await post(body, { ...base, 'x-hub-signature-256': sign(body, 'wrong') })).status).toBe(
      401,
    );
    expect(
      (await post(checkRun({ forged: 1 }), { ...base, 'x-hub-signature-256': sign(body) })).status,
    ).toBe(401);
    expect(eventFiles()).toEqual([]);
  });

  it('coalesces five check-run deliveries for one head into one wake', async () => {
    for (let i = 0; i < 5; i++) {
      const body = checkRun();
      await post(body, good(body, `d-${i}`));
    }
    expect(eventFiles()).toHaveLength(5);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('records pull_request and status deliveries; drops unknown kinds and malformed payloads with 200', async () => {
    const pr = JSON.stringify({
      repository: { full_name: 'o/r' },
      pull_request: { number: 3, head: { sha: SHA } },
    });
    const st = JSON.stringify({ repository: { full_name: 'o/r' }, sha: SHA });
    await post(pr, good(pr, 'p-1', 'pull_request'));
    await post(st, good(st, 's-1', 'status'));
    expect(eventFiles()).toHaveLength(2);
    expect((await post(pr, good(pr, 'p-2', 'ping'))).status).toBe(200);
    expect((await post('{}', good('{}', 'p-3', 'pull_request'))).status).toBe(200);
    expect((await post(pr, good(pr, 'bad id!', 'pull_request'))).status).toBe(200);
    expect((await post('[]', good('[]', 'p-4', 'check_run'))).status).toBe(200);
    expect(eventFiles()).toHaveLength(2);
  });

  it('touchWakeFile creates the wake file', () => {
    touchWakeFile(dir);
    expect(readdirSync(dir)).toContain('wake');
  });
});
