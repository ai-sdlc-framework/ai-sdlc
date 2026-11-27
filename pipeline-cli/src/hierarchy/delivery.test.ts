import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RECEIPT_GRACE_MS,
  deliveryState,
  formatDelivery,
  readLastSend,
  readReceipt,
  receiptStateOf,
} from './delivery.js';

const AT = '2026-11-27T00:00:00.000Z';
const T = Date.parse(AT);

describe('delivery evidence (AISDLC-1464)', () => {
  it('classifies the receipt of the last send', () => {
    const send = { to: 'p', text: 'rotate', ok: true, at: AT };
    const receipt = {
      session: 'p',
      from: 'd',
      text: 'rotate',
      outcome: 'consumed' as const,
      at: AT,
    };
    expect(receiptStateOf(undefined, undefined, T)).toBeUndefined();
    expect(receiptStateOf({ ...send, ok: false }, undefined, T)).toBe('refused');
    expect(receiptStateOf(send, receipt, T)).toBe('received');
    expect(receiptStateOf(send, undefined, T + 1000)).toBe('pending');
    expect(
      receiptStateOf(
        send,
        { ...receipt, at: '2026-11-26T00:00:00.000Z' },
        T + RECEIPT_GRACE_MS + 1,
      ),
    ).toBe('missing');
  });

  it('counts a receipt only when it names the sender of the send', () => {
    const send = { to: 'p', from: 'operator-dispatch', text: 'rotate', ok: true, at: AT };
    const receipt = { session: 'p', text: 'x', outcome: 'forwarded' as const, at: AT };
    const late = T + RECEIPT_GRACE_MS + 1;
    expect(receiptStateOf(send, { ...receipt, from: 'proj-executor-1' }, late)).toBe('missing');
    expect(receiptStateOf(send, { ...receipt, from: 'proj-operator-dispatch' }, late)).toBe(
      'received',
    );
    expect(receiptStateOf(send, { ...receipt, from: 'operator-dispatch' }, late)).toBe('received');
  });

  it('prints board text with control characters replaced', () => {
    const lines = formatDelivery('p', {
      lastSend: { to: 'p', text: 'hi\u001b]0;x\u0007', ok: true, at: AT },
      receiptState: 'pending',
      healthy: true,
      lastRotation: {
        at: `${AT}\u001b[2J`,
        role: 'planner',
        session: 'p',
        tokens: 1,
        handoffOk: true,
        clearOk: true,
        fallback: 'none',
      },
    });
    for (const line of lines) expect([...line].every((c) => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(lines[0]).toContain('"hi?]0;x?"');
  });

  it('reads nothing for unsafe names or malformed records, and formats a refused send', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'delivery-'));
    mkdirSync(path.join(dir, 'handoff'));
    writeFileSync(path.join(dir, 'handoff', 'sent-a.json'), '{"to":"a"}');
    writeFileSync(
      path.join(dir, 'handoff', 'receipt-a.json'),
      '{"from":"d","at":"x","outcome":"other"}',
    );
    expect(readLastSend(dir, '../x')).toBeUndefined();
    expect(readReceipt(dir, '../x')).toBeUndefined();
    expect(readLastSend(dir, 'a')).toBeUndefined();
    expect(readReceipt(dir, 'a')).toBeUndefined();
    writeFileSync(
      path.join(dir, 'handoff', 'sent-b.json'),
      JSON.stringify({ to: 'b', ok: false, at: AT }),
    );
    const d = deliveryState(dir, 'b', T, path.join(dir, 'missing.sock'), new Map());
    expect(d).toMatchObject({ receiptState: 'refused', healthy: false, socket: 'absent' });
    expect(formatDelivery('b', d)[0]).toContain('UNHEALTHY: the host refused the send');
    writeFileSync(
      path.join(dir, 'handoff', 'sent-c.json'),
      JSON.stringify({ to: 'c', text: 'x', ok: true, at: AT }),
    );
    const c = deliveryState(dir, 'c', T + RECEIPT_GRACE_MS + 1, undefined, new Map());
    expect(formatDelivery('c', c)[0]).toContain('UNHEALTHY: the session returned no receipt');
    expect(formatDelivery('c', undefined)).toEqual([]);
    expect(
      formatDelivery(
        'z',
        deliveryState(
          dir,
          'z',
          T,
          undefined,
          new Map([
            [
              'z',
              {
                at: AT,
                role: 'executor',
                session: 'z',
                tokens: null,
                handoffOk: false,
                clearOk: true,
                fallback: 'none' as const,
              },
            ],
          ]),
        ),
      ),
    ).toEqual([
      `last rotation of z: ${AT} tokens unknown, handoff refused, clear ok, fallback none`,
    ]);
  });
});
