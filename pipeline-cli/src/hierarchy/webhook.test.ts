import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HierarchyDeps } from './types.js';
import {
  formatWebhookStatus,
  webhookDown,
  webhookServe,
  webhookStatus,
  webhookUp,
} from './webhook.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
let lines: string[];

const mk = (env: NodeJS.ProcessEnv, alive = true): HierarchyDeps =>
  ({
    boardDir: dir,
    cwd: dir,
    env,
    log: (l: string) => lines.push(l),
    isAlive: () => alive,
    binPath: '/bin/cli-hierarchy.mjs',
  }) as unknown as HierarchyDeps;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'wh-'));
  lines = [];
});
afterEach(() => removeFixtureDir(dir));

describe('cli-hierarchy webhook (AISDLC-880)', () => {
  it('reports off (no secret) without the secret and starts nothing', () => {
    const spawner = vi.fn();
    const deps = mk({});
    expect(formatWebhookStatus(webhookStatus(deps))).toBe('webhook: off (no secret)');
    webhookUp(deps, undefined, spawner);
    expect(spawner).not.toHaveBeenCalled();
  });

  it('spawns the serve process when the secret is set and nothing runs', () => {
    const spawner = vi.fn();
    const deps = mk({ AI_SDLC_WEBHOOK_SECRET: 'x', AI_SDLC_WEBHOOK_PORT: '9001' });
    expect(formatWebhookStatus(webhookStatus(deps))).toBe('webhook: off (not running)');
    webhookUp(deps, undefined, spawner);
    expect(spawner).toHaveBeenCalledWith(process.execPath, [
      '/bin/cli-hierarchy.mjs',
      'webhook',
      'serve',
      '--port',
      '9001',
      '--board-dir',
      dir,
    ]);
    expect(() => webhookUp(deps, '70000', spawner)).toThrow(/invalid webhook port/);
  });

  it('serves on 127.0.0.1, shows up with the port, and stops cleanly', async () => {
    const deps = mk({ AI_SDLC_WEBHOOK_SECRET: 'x' });
    const done = webhookServe(deps, '0');
    await vi.waitFor(() => expect(webhookStatus(deps).state).toBe('up'));
    const st = webhookStatus(deps);
    expect(formatWebhookStatus(st)).toMatch(/^webhook: up \(port \d+\)$/);
    const spawner = vi.fn();
    webhookUp(deps, undefined, spawner);
    expect(spawner).not.toHaveBeenCalled();
    process.emit('SIGTERM');
    await done;
    expect(existsSync(path.join(dir, 'webhook.json'))).toBe(false);
  });

  it('serve refuses without the secret; down handles absent and recorded receivers', () => {
    return expect(webhookServe(mk({})))
      .rejects.toThrow(/not set/)
      .then(() => {
        expect(webhookDown(mk({}))).toBe(false);
        writeFileSync(path.join(dir, 'webhook.json'), JSON.stringify({ pid: 99, port: 1 }));
        const kill = vi.fn();
        expect(webhookDown(mk({ AI_SDLC_WEBHOOK_SECRET: 'x' }), kill)).toBe(true);
        expect(kill).toHaveBeenCalledWith(99);
      });
  });
});
