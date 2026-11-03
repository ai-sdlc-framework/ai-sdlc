import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { runDispatchTick, type LoopDeps } from './dispatch-loop.js';
import { appendDecisionEvent, makeDecisionOpenedEvent } from '../decisions/event-log.js';
import { listDecisions } from '../decisions/projection.js';
import {
  catalogWebhookEscalation,
  formatWebhookEscalationBody,
  runWebhookHealthTick,
  stallChannelNotifier,
  WEBHOOK_FIX_COMMAND,
} from './webhook-health.js';
import type { WebhookClass, WebhookHealth } from './webhook.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'whh-'));
});
afterEach(() => removeFixtureDir(dir));

const reading = (cls: WebhookClass, reason = 'no event'): WebhookHealth => ({
  class: cls,
  since: '2026-11-02T12:00:00.000Z',
  reasons: cls === 'healthy' ? [] : [reason],
  signals: {
    receiver: true,
    port: true,
    lastEventAgeMin: 45,
    prActivityWithoutEvent: cls !== 'healthy',
    prActivity: cls !== 'healthy',
    quiet: cls === 'healthy',
    forwarder: 'dead',
    feed: 'gh-forward',
  },
});

describe('webhook health tick (AISDLC-1157)', () => {
  it('drives healthy, degraded, down, healthy: reports on change only, one escalation per episode', async () => {
    const script: WebhookClass[] = [
      'healthy',
      'degraded',
      'degraded',
      'down',
      'down',
      'healthy',
      'healthy',
    ];
    let i = 0;
    const filed: { summary: string; body: string; since: string }[] = [];
    const closed: { id: string | undefined; note: string }[] = [];
    const notices: string[] = [];
    const deps = {
      boardDir: dir,
      now: () => new Date('2026-11-02T12:00:00Z'),
      health: () => reading(script[i++]!),
      escalate: (input: { summary: string; body: string; since: string }) => {
        filed.push(input);
        return 'DEC-0900';
      },
      closeEpisode: (id: string | undefined, note: string) => closed.push({ id, note }),
      notify: (m: string) => notices.push(m),
    };
    const reports = script.map(() => runWebhookHealthTick(deps).report?.text);
    expect(reports.map((r) => r !== undefined)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(reports[1]).toMatch(/healthy to degraded/);
    expect(reports[3]).toMatch(/degraded to down/);
    expect(reports[5]).toMatch(/healthy again/);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.body).toContain(WEBHOOK_FIX_COMMAND);
    expect(filed[0]!.body).toContain('operator only');
    expect(notices).toHaveLength(1);
    expect(closed).toEqual([{ id: 'DEC-0900', note: expect.stringContaining('recovered') }]);
    // A new episode files a new escalation.
    script.push('down');
    expect(runWebhookHealthTick({ ...deps, health: () => reading('down') }).report).toBeDefined();
    expect(filed).toHaveLength(2);
  });

  it('does nothing without a reading, and tolerates missing collaborators', () => {
    expect(
      runWebhookHealthTick({ boardDir: dir, now: () => new Date(), health: () => undefined }),
    ).toEqual({});
    const r = runWebhookHealthTick({
      boardDir: dir,
      now: () => new Date(),
      health: () => reading('down'),
    });
    expect(r.report?.text).toMatch(/healthy to down/);
    expect(
      runWebhookHealthTick({
        boardDir: dir,
        now: () => new Date(),
        health: () => reading('healthy'),
      }).report,
    ).toBeDefined();
  });

  it('formats the escalation body and the stall channel notifier', () => {
    expect(formatWebhookEscalationBody(reading('down', 'port dead'))).toContain('port dead');
    const run = vi.fn();
    stallChannelNotifier(dir, run, () => new Date('2026-11-02T12:00:00Z'))('webhook down');
    expect(run).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(dir, 'stall-digest.log'), 'utf-8')).toContain('webhook down');
  });

  it('the dispatch tick emits a webhook-health report on class change only', async () => {
    let cls: WebhookClass = 'healthy';
    const base = {
      boardDir: dir,
      now: () => new Date('2026-11-02T12:00:00Z'),
      webhookHealth: { health: () => reading(cls) },
    } as unknown as LoopDeps;
    const kinds = async (): Promise<string[]> =>
      (await runDispatchTick(base)).reports
        .filter((r) => r.kind === 'webhook-health')
        .map((r) => r.text);
    expect(await kinds()).toEqual([]);
    cls = 'degraded';
    expect(await kinds()).toHaveLength(1);
    expect(await kinds()).toEqual([]);
  });
});

describe('webhook escalation dedup (AISDLC-1167)', () => {
  const input = (since: string) => ({
    since,
    class: 'down' as WebhookClass,
    summary: 's',
    body: 'b',
  });
  const open = () =>
    listDecisions({ workDir: dir }).decisions.filter((d) => d.status.lifecycle !== 'answered');
  const prev = process.env.AI_SDLC_DECISIONS_NO_REMOTE;
  beforeEach(() => {
    process.env.AI_SDLC_DECISIONS_NO_REMOTE = '1';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_SDLC_DECISIONS_NO_REMOTE;
    else process.env.AI_SDLC_DECISIONS_NO_REMOTE = prev;
  });

  it('opens no second record while one is open, even with a different episode start', () => {
    const c = catalogWebhookEscalation(dir);
    const a = c.escalate!(input('2026-11-03T01:00:00Z'));
    const b = c.escalate!(input('2026-11-03T02:00:00Z'));
    expect(b).toBe(a);
    expect(open()).toHaveLength(1);
  });

  it('recovery answers every open webhook-health record', () => {
    for (const [id, scope] of [
      ['DEC-0001', 'webhook-health:2026-11-03T01:00:00Z'],
      ['DEC-0002', 'webhook-health'],
    ]) {
      appendDecisionEvent(
        makeDecisionOpenedEvent({
          decisionId: id,
          source: 'ad-hoc',
          scope,
          summary: 's',
          body: 'b',
          reversible: true,
          options: [{ id: 'restart-feed', description: 'x' }],
          by: 'operator-dispatch',
        }),
        { workDir: dir },
      );
    }
    expect(open()).toHaveLength(2);
    catalogWebhookEscalation(dir).closeEpisode!(undefined, 'recovered');
    expect(open()).toHaveLength(0);
  });
});
