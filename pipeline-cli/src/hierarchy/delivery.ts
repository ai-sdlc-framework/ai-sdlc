/**
 * Cross-session delivery evidence for `cli-hierarchy status` (AISDLC-1464, DEC-0455 a).
 *
 * The dispatch hooks module records each `$.session.send` it makes in `<board>/handoff/sent-<to>.json`; the
 * receiving module writes `<board>/handoff/receipt-<name>.json` once it consumed the message or passed it
 * to the model; every module rotation attempt appends a line to `<board>/log/rotations.jsonl`. Health is
 * read from those records, never from whether a socket file exists: a socket that is present while a send
 * past the grace has no receipt is a session that is not receiving.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** How long a send may wait for its receipt before the session is shown unhealthy. */
export const RECEIPT_GRACE_MS = 2 * 60 * 1000;

export const ROTATION_LOG = path.join('log', 'rotations.jsonl');

export interface SendRecord {
  to: string;
  from?: string;
  text: string;
  ok: boolean;
  at: string;
}

export interface ReceiptRecord {
  session: string;
  from: string;
  text: string;
  outcome: 'consumed' | 'forwarded';
  consumed?: string;
  at: string;
}

export interface RotationRecord {
  at: string;
  role: string;
  session: string;
  tokens: number | null;
  handoffOk: boolean;
  clearOk: boolean;
  fallback: 'none' | 'compact' | 'exit';
}

/** `received`: a receipt from the same sender at or after the send; `pending`: within the grace; `missing`: past it; `refused`: the host dropped the send. */
export type ReceiptState = 'received' | 'pending' | 'missing' | 'refused';

export interface DeliveryState {
  lastSend?: SendRecord;
  receipt?: ReceiptRecord;
  receiptState?: ReceiptState;
  /** Whether the session's socket file exists; informational only. */
  socket?: 'present' | 'absent';
  /** False when a send has no receipt past the grace, or the host refused it. */
  healthy: boolean;
  lastRotation?: RotationRecord;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

export function readLastSend(boardDir: string, name: string): SendRecord | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const r = readJson(path.join(boardDir, 'handoff', `sent-${name}.json`)) as Record<
    string,
    unknown
  >;
  if (!r || !isString(r.to) || !isString(r.at) || typeof r.ok !== 'boolean') return undefined;
  return {
    to: r.to,
    ...(isString(r.from) ? { from: r.from } : {}),
    text: isString(r.text) ? r.text : '',
    ok: r.ok,
    at: r.at,
  };
}

export function readReceipt(boardDir: string, name: string): ReceiptRecord | undefined {
  if (!SAFE_NAME.test(name)) return undefined;
  const r = readJson(path.join(boardDir, 'handoff', `receipt-${name}.json`)) as Record<
    string,
    unknown
  >;
  if (!r || !isString(r.at) || !isString(r.from)) return undefined;
  if (r.outcome !== 'consumed' && r.outcome !== 'forwarded') return undefined;
  return {
    session: isString(r.session) ? r.session : name,
    from: r.from,
    text: isString(r.text) ? r.text : '',
    outcome: r.outcome,
    ...(isString(r.consumed) ? { consumed: r.consumed } : {}),
    at: r.at,
  };
}

/** The newest rotation log line per session; an unreadable line is skipped. */
export function readLastRotations(boardDir: string): Map<string, RotationRecord> {
  const out = new Map<string, RotationRecord>();
  let text: string;
  try {
    text = readFileSync(path.join(boardDir, ROTATION_LOG), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RotationRecord;
      if (isString(r.session) && isString(r.at)) out.set(r.session, r);
    } catch {
      /* a torn line contributes nothing */
    }
  }
  return out;
}

/**
 * A receipt answers the send only when it names the same sender: the roster name the sender recorded, or a
 * receipt sender ending in `-<from>` (the recorded `operator-dispatch` fallback beside `<project>-operator-dispatch`).
 */
function sameSender(send: SendRecord, receipt: ReceiptRecord): boolean {
  if (!send.from) return true;
  return receipt.from === send.from || receipt.from.endsWith(`-${send.from}`);
}

/** Strip C0/C1 control characters (ANSI and OSC escapes) from board text before it reaches a terminal. */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/** The receipt state of the last send, or undefined when nothing was sent. */
export function receiptStateOf(
  send: SendRecord | undefined,
  receipt: ReceiptRecord | undefined,
  nowMs: number,
): ReceiptState | undefined {
  if (!send) return undefined;
  if (!send.ok) return 'refused';
  const sentAt = Date.parse(send.at);
  if (receipt && Date.parse(receipt.at) >= sentAt && sameSender(send, receipt)) return 'received';
  return nowMs - sentAt > RECEIPT_GRACE_MS ? 'missing' : 'pending';
}

export function deliveryState(
  boardDir: string,
  name: string,
  nowMs: number,
  socketPath: string | undefined,
  rotations: Map<string, RotationRecord>,
): DeliveryState {
  const lastSend = readLastSend(boardDir, name);
  const receipt = readReceipt(boardDir, name);
  const receiptState = receiptStateOf(lastSend, receipt, nowMs);
  const lastRotation = rotations.get(name);
  return {
    ...(lastSend ? { lastSend } : {}),
    ...(receipt ? { receipt } : {}),
    ...(receiptState ? { receiptState } : {}),
    ...(socketPath !== undefined
      ? { socket: existsSync(socketPath) ? ('present' as const) : ('absent' as const) }
      : {}),
    healthy: receiptState !== 'missing' && receiptState !== 'refused',
    ...(lastRotation ? { lastRotation } : {}),
  };
}

/** The status lines for one session: its last send with the receipt state, and its last logged rotation. */
export function formatDelivery(name: string, d: DeliveryState | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.lastSend) {
    const receipt =
      d.receiptState === 'received' && d.receipt
        ? `receipt ${d.receipt.outcome}${d.receipt.consumed ? ` (${printable(d.receipt.consumed)})` : ''} at ${printable(d.receipt.at)}`
        : `receipt ${d.receiptState}`;
    const unhealthy = d.healthy
      ? ''
      : d.receiptState === 'refused'
        ? '; UNHEALTHY: the host refused the send'
        : `; UNHEALTHY: ${d.socket === 'present' ? 'socket exists but' : 'the session'} returned no receipt`;
    out.push(
      `delivery to ${name}: last send "${printable(d.lastSend.text)}" at ${printable(d.lastSend.at)}, ${receipt}${unhealthy}`,
    );
  }
  if (d.lastRotation) {
    const r = d.lastRotation;
    out.push(
      `last rotation of ${name}: ${printable(r.at)} tokens ${r.tokens ?? 'unknown'}, handoff ${r.handoffOk ? 'ok' : 'refused'}, clear ${r.clearOk ? 'ok' : 'refused'}, fallback ${printable(String(r.fallback))}`,
    );
  }
  return out;
}
