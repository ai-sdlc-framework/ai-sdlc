import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

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
    debounceMs: 300,
    now: () => new Date('2026-10-15T00:00:00.000Z'),
    wake,
  });
  await receiver.start();
});

afterEach(async () => {
  await receiver.stop();
  removeFixtureDir(dir);
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
    await new Promise((r) => setTimeout(r, 500));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a no-PR check_run is recorded but does not wake; a push to main does (AISDLC-1379)', async () => {
    const noPr = JSON.stringify({
      repository: { full_name: 'o/r' },
      check_run: { head_sha: SHA, pull_requests: [] },
    });
    await post(noPr, good(noPr, 'np-1'));
    expect(eventFiles()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(wake).not.toHaveBeenCalled();
    const feature = JSON.stringify({
      repository: { full_name: 'o/r' },
      ref: 'refs/heads/feat/x',
      after: SHA,
    });
    await post(feature, good(feature, 'pu-0', 'push'));
    expect(eventFiles()).toHaveLength(1);
    const push = JSON.stringify({
      repository: { full_name: 'o/r', default_branch: 'main' },
      ref: 'refs/heads/main',
      after: SHA,
    });
    await post(push, good(push, 'pu-1', 'push'));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    const dflt = JSON.stringify({
      repository: { full_name: 'o/r' },
      ref: 'refs/heads/main',
      after: 'b'.repeat(40),
    });
    await post(dflt, good(dflt, 'pu-2', 'push'));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
  });

  it('touches nothing for a replayed delivery id or a failed signature', async () => {
    const body = checkRun();
    await post(body, good(body, 'r-1'));
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    await post(body, good(body, 'r-1'));
    await post(body, { 'x-github-event': 'check_run', 'x-github-delivery': 'r-2' });
    await new Promise((r) => setTimeout(r, 500));
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

  it('records pipeline canary events with the sha, and the capped output on red (AISDLC-1023)', async () => {
    const red = JSON.stringify({
      repository: { full_name: 'o/r' },
      sha: SHA,
      detail: 'x'.repeat(5000),
    });
    const green = JSON.stringify({ repository: { full_name: 'o/r' }, sha: SHA });
    await post(red, good(red, 'c-1', 'pipeline-canary-red'));
    await post(green, good(green, 'c-2', 'pipeline-canary-green'));
    expect(eventFiles()).toHaveLength(2);
    const recs = eventFiles().map(
      (f) =>
        JSON.parse(readFileSync(path.join(dir, 'events', f), 'utf-8')) as Record<string, unknown>,
    );
    const r = recs.find((x) => x.kind === 'pipeline-canary-red')!;
    expect(r.headSha).toBe(SHA);
    expect(r.pr).toBeNull();
    expect((r.detail as string).length).toBe(4000);
    expect(recs.find((x) => x.kind === 'pipeline-canary-green')).not.toHaveProperty('detail');
  });

  it('touchWakeFile creates the wake file', () => {
    touchWakeFile(dir);
    expect(readdirSync(dir)).toContain('.reconcile-wake');
  });
});

describe('refused deliveries (AISDLC-1285)', () => {
  it('records a bad signature and clears the record on a verified delivery', async () => {
    const body = checkRun();
    const bad = { ...good(body, 'd-bad'), 'x-hub-signature-256': sign(body, 'wrong') };
    expect((await post(body, bad)).status).toBe(401);
    expect((await post(body, bad)).status).toBe(401);
    const file = path.join(dir, 'webhook-refused.json');
    expect(JSON.parse(readFileSync(file, 'utf-8')).count).toBe(2);
    expect((await post(body, good(body, 'd-ok'))).status).toBeLessThan(300);
    expect(() => readFileSync(file, 'utf-8')).toThrow();
  });
});

describe('repository identity (AISDLC-1349)', () => {
  const mkReceiver = async (repo: string | undefined, wk: Mock<() => void>) => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'webhook-id-'));
    const r = createReceiver({
      secret: SECRET,
      boardDir: d,
      port: 0,
      debounceMs: 20,
      ...(repo ? { repo } : {}),
      wake: wk,
    });
    await r.start();
    return { d, r };
  };
  const forRepo = (repo: string): string =>
    JSON.stringify({
      repository: { full_name: repo },
      check_run: { head_sha: SHA, pull_requests: [{ number: 7 }] },
    });
  const send = async (port: number, body: string, id: string): Promise<number> =>
    (
      await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATH}`, {
        method: 'POST',
        body,
        headers: good(body, id),
      })
    ).status;

  it('refuses a signed delivery for another repository and records it; accepts its own', async () => {
    const wa = vi.fn<() => void>();
    const a = await mkReceiver('o/a', wa);
    try {
      const foreign = forRepo('o/b');
      expect(await send(a.r.port, foreign, 'f-1')).toBe(200);
      expect(await send(a.r.port, foreign, 'f-2')).toBe(200);
      await new Promise((r) => setTimeout(r, 80));
      expect(() => readdirSync(path.join(a.d, 'events'))).toThrow();
      expect(wa).not.toHaveBeenCalled();
      expect(
        JSON.parse(readFileSync(path.join(a.d, 'webhook-foreign.json'), 'utf-8')),
      ).toMatchObject({ count: 2, repo: 'o/b' });
      expect(await send(a.r.port, forRepo('o/a'), 'g-1')).toBe(200);
      expect(readdirSync(path.join(a.d, 'events'))).toHaveLength(1);
      await vi.waitFor(() => expect(wa).toHaveBeenCalledTimes(1));
    } finally {
      await a.r.stop();
      removeFixtureDir(a.d);
    }
  });

  it('accepts every delivery when no repository is resolved, and /health names repo and board', async () => {
    const any = await mkReceiver(undefined, vi.fn<() => void>());
    const a = await mkReceiver('o/a', vi.fn<() => void>());
    try {
      expect(await send(any.r.port, forRepo('o/b'), 'u-1')).toBe(200);
      expect(readdirSync(path.join(any.d, 'events'))).toHaveLength(1);
      const h = await (await fetch(`http://127.0.0.1:${a.r.port}/health`)).json();
      expect(h).toMatchObject({ repo: 'o/a', boardDir: path.resolve(a.d) });
      const u = (await (await fetch(`http://127.0.0.1:${any.r.port}/health`)).json()) as {
        repo: unknown;
      };
      expect(u.repo).toBeNull();
    } finally {
      await any.r.stop();
      await a.r.stop();
      removeFixtureDir(any.d);
      removeFixtureDir(a.d);
    }
  });
});
