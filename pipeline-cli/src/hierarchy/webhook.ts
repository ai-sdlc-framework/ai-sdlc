/**
 * `cli-hierarchy webhook up|down|status|serve` (AISDLC-880): lifecycle of the local
 * GitHub webhook receiver. The secret comes from `AI_SDLC_WEBHOOK_SECRET` only; without
 * it nothing starts and dispatch stays poll-only.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createReceiver } from '../dispatch/webhook-receiver.js';
import { DEFAULT_WEBHOOK_PORT, loadPrLifecycleConfig } from './pr-lifecycle-config.js';
import type { HierarchyDeps } from './types.js';

export const WEBHOOK_SECRET_ENV = 'AI_SDLC_WEBHOOK_SECRET';
export const WEBHOOK_PORT_ENV = 'AI_SDLC_WEBHOOK_PORT';
export { DEFAULT_WEBHOOK_PORT };
const STATE_FILE = 'webhook.json';

/** What `status` reports about the receiver. */
export type WebhookStatus =
  | { state: 'up'; port: number; pid: number }
  | { state: 'off'; reason: 'no secret' | 'not running' };

interface WebhookState {
  pid: number;
  port: number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stateFile = (boardDir: string): string => path.join(boardDir, STATE_FILE);

function readState(boardDir: string): WebhookState | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(boardDir), 'utf-8')) as Partial<WebhookState>;
    return typeof s.pid === 'number' && typeof s.port === 'number'
      ? { pid: s.pid, port: s.port }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a live receiver is recorded, and whether a secret is set. */
export function webhookStatus(deps: HierarchyDeps): WebhookStatus {
  if (!deps.env[WEBHOOK_SECRET_ENV]) return { state: 'off', reason: 'no secret' };
  const s = readState(deps.boardDir);
  if (s && (deps.isAlive ?? defaultIsAlive)(s.pid)) return { state: 'up', ...s };
  return { state: 'off', reason: 'not running' };
}

/** The status line, `webhook: up (port N)` or `webhook: off (no secret)`. */
export function formatWebhookStatus(w: WebhookStatus): string {
  return w.state === 'up' ? `webhook: up (port ${w.port})` : `webhook: off (${w.reason})`;
}

function resolvePort(deps: HierarchyDeps, flag: string | undefined): number {
  const raw = flag ?? deps.env[WEBHOOK_PORT_ENV];
  if (raw === undefined || raw === '') return loadPrLifecycleConfig(deps.cwd).webhook.port;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid webhook port '${raw}'`);
  return n;
}

export type Spawner = (file: string, args: readonly string[]) => void;

const spawnDetached: Spawner = (file, args) => {
  spawn(file, [...args], { detached: true, stdio: 'ignore' }).unref();
};

/** Start the receiver in a detached process. No secret: a no-op (poll-only mode). */
export function webhookUp(
  deps: HierarchyDeps,
  portFlag?: string,
  spawner: Spawner = spawnDetached,
): WebhookStatus {
  const before = webhookStatus(deps);
  if (before.state === 'up') {
    deps.log(`webhook already running on 127.0.0.1:${before.port}`);
    return before;
  }
  if (before.reason === 'no secret') {
    deps.log(`webhook off: ${WEBHOOK_SECRET_ENV} is not set (poll-only mode)`);
    return before;
  }
  const port = resolvePort(deps, portFlag);
  spawner(process.execPath, [
    deps.binPath ?? process.argv[1] ?? '',
    'webhook',
    'serve',
    '--port',
    String(port),
    '--board-dir',
    deps.boardDir,
  ]);
  deps.log(`webhook starting on 127.0.0.1:${port}`);
  return before;
}

/** Stop a recorded receiver. */
export function webhookDown(
  deps: HierarchyDeps,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM'),
): boolean {
  const s = readState(deps.boardDir);
  if (!s) {
    deps.log('webhook not running');
    return false;
  }
  if ((deps.isAlive ?? defaultIsAlive)(s.pid)) kill(s.pid);
  rmSync(stateFile(deps.boardDir), { force: true });
  deps.log(`webhook stopped (port ${s.port})`);
  return true;
}

/** Run the receiver in the foreground until SIGTERM or SIGINT. Needs the secret. */
export async function webhookServe(deps: HierarchyDeps, portFlag?: string): Promise<void> {
  const secret = deps.env[WEBHOOK_SECRET_ENV];
  if (!secret) throw new Error(`${WEBHOOK_SECRET_ENV} is not set`);
  const receiver = createReceiver({
    secret,
    boardDir: deps.boardDir,
    port: resolvePort(deps, portFlag),
    debounceMs: loadPrLifecycleConfig(deps.cwd).webhook.debounceMs,
  });
  await receiver.start();
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(
    stateFile(deps.boardDir),
    JSON.stringify({ pid: process.pid, port: receiver.port }) + '\n',
  );
  deps.log(`webhook listening on 127.0.0.1:${receiver.port}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await receiver.stop();
  rmSync(stateFile(deps.boardDir), { force: true });
}
