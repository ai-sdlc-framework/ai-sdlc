/**
 * Parsing of one Claude Code transcript line into a usage fact.
 *
 * Transcript files are untrusted input: every field is type-checked and
 * length-capped before use. Message text is inspected ONLY to classify a
 * synthetic limit notice into a short fixed category; the text itself is never
 * returned, stored or logged.
 */

import type { ModelCallTokens } from '@ai-sdlc/reference';

/** The model name the harness uses for lines that are not real model calls. */
export const SYNTHETIC_MODEL = '<synthetic>';

const MAX_ID_LEN = 256;
const MAX_MODEL_LEN = 200;
const MAX_CWD_LEN = 4096;
const MAX_BRANCH_LEN = 256;
const MAX_COUNT = 1e12;
/** Only this much of a synthetic notice is scanned for a limit phrase. */
const MAX_NOTICE_SCAN = 2000;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type LimitCategory = 'usage-limit' | 'rate-limit';

export interface ParsedCall {
  callId: string;
  requestId?: string;
  /** Normalised ISO timestamp. */
  ts: string;
  model: string;
  tokens: ModelCallTokens;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  isSidechain: boolean;
}

export type ParsedLine =
  | { kind: 'call'; call: ParsedCall }
  | { kind: 'limit'; ts: string; sessionId?: string; category: LimitCategory }
  | { kind: 'ignore' }
  | { kind: 'error' };

const IGNORE: ParsedLine = { kind: 'ignore' };
const ERROR: ParsedLine = { kind: 'error' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A bounded string without control characters, or undefined. */
function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return undefined;
  return CONTROL_CHARS.test(v) ? undefined : v;
}

/** A non-negative integer count, or undefined when absent or not a number. */
function count(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(Math.floor(v), MAX_COUNT);
}

function normaliseTimestamp(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 64) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Map `message.usage` to the ledger token classes. When only the combined
 * cache-creation count is present it is booked as the 5-minute class.
 */
export function mapUsageTokens(usage: Record<string, unknown>): ModelCallTokens {
  const combined = count(usage['cache_creation_input_tokens']) ?? 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  const split = usage['cache_creation'];
  if (isRecord(split)) {
    cacheWrite5m = count(split['ephemeral_5m_input_tokens']) ?? 0;
    cacheWrite1h = count(split['ephemeral_1h_input_tokens']) ?? 0;
  }
  if (cacheWrite5m + cacheWrite1h === 0) cacheWrite5m = combined;

  const tokens: ModelCallTokens = {
    input: count(usage['input_tokens']) ?? 0,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: count(usage['cache_read_input_tokens']) ?? 0,
    output: count(usage['output_tokens']) ?? 0,
  };
  const details = usage['output_tokens_details'];
  if (isRecord(details)) {
    const thinking = count(details['thinking_tokens']);
    if (thinking !== undefined) tokens.reasoning = thinking;
  }
  return tokens;
}

/**
 * Classify a synthetic notice into a fixed category. Returns undefined for
 * anything that is not a usage or rate limit notice. The text is read here and
 * goes nowhere else.
 */
function classifyLimitNotice(message: Record<string, unknown>): LimitCategory | undefined {
  const content = message['content'];
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && typeof part['text'] === 'string') {
        text += `${part['text']}\n`;
        if (text.length >= MAX_NOTICE_SCAN) break;
      }
    }
  }
  const lower = text.slice(0, MAX_NOTICE_SCAN).toLowerCase();
  if (/rate[\s_-]?limit|too many requests/.test(lower)) return 'rate-limit';
  if (/usage limit|limit reached|hit your limit|reached your .{0,40}limit/.test(lower)) {
    return 'usage-limit';
  }
  return undefined;
}

/** The working directory named by a line of any type, or undefined. Never throws. */
export function peekCwd(line: string): string | undefined {
  try {
    const obj: unknown = JSON.parse(line);
    return isRecord(obj) ? cleanString(obj['cwd'], MAX_CWD_LEN) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse one transcript line. Never throws. */
export function parseTranscriptLine(line: string): ParsedLine {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return ERROR;
  }
  if (!isRecord(obj) || obj['type'] !== 'assistant') return IGNORE;
  const message = obj['message'];
  if (!isRecord(message)) return IGNORE;

  const ts = normaliseTimestamp(obj['timestamp']);
  const sessionId = cleanString(obj['sessionId'], MAX_ID_LEN);

  if (message['model'] === SYNTHETIC_MODEL) {
    const category = classifyLimitNotice(message);
    if (!category || !ts) return IGNORE;
    return { kind: 'limit', ts, ...(sessionId ? { sessionId } : {}), category };
  }

  const usage = message['usage'];
  if (!isRecord(usage)) return IGNORE;
  const model = cleanString(message['model'], MAX_MODEL_LEN);
  const requestId = cleanString(obj['requestId'], MAX_ID_LEN);
  const callId = cleanString(message['id'], MAX_ID_LEN);
  if (!model || !callId || !ts) return ERROR;

  const agentId = cleanString(obj['agentId'], MAX_ID_LEN);
  const cwd = cleanString(obj['cwd'], MAX_CWD_LEN);
  const gitBranch = cleanString(obj['gitBranch'], MAX_BRANCH_LEN);
  const entrypoint = cleanString(obj['entrypoint'], 64);

  return {
    kind: 'call',
    call: {
      callId,
      ...(requestId ? { requestId } : {}),
      ts,
      model,
      tokens: mapUsageTokens(usage),
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      isSidechain: obj['isSidechain'] === true,
    },
  };
}

/**
 * Billing pool from the transcript's entrypoint marker. Only an entrypoint the
 * harness states outright decides it; anything else is `unknown`.
 */
export function billingPoolFor(
  entrypoint: string | undefined,
): 'subscription-interactive' | 'agent-sdk-credit' | 'unknown' {
  switch (entrypoint) {
    case 'cli':
      return 'subscription-interactive';
    case 'sdk-cli':
    case 'sdk-ts':
    case 'sdk-py':
      return 'agent-sdk-credit';
    default:
      return 'unknown';
  }
}
