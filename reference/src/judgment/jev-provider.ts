/**
 * Jev (typesafe.ai) adapter for the judgment layer. Thin `fetch` client: no vendor
 * SDK, typed error kinds, per-attempt timeout, retry with backoff on 429/5xx.
 */

import { createHash } from 'node:crypto';
import { JudgmentProviderError } from './errors.js';
import type {
  Entry,
  JudgmentAnswer,
  JudgmentCapabilities,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentRequest,
  JudgmentResponse,
} from './types.js';

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-1.13.0';
const JEV_PATH = '/v1/systemone';
const API_KEY_ENV = 'TYPESAFE_API_KEY';
const BASE_URL_ENV = 'TYPESAFE_BASE_URL';
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export interface JevProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Per-attempt timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Retries after the first attempt on 429/5xx. Default 2. */
  maxRetries?: number;
  /** Injectable fetch; tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep used for backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const JEV_CAPABILITIES: JudgmentCapabilities = {
  maxStateTokens: 32000,
  maxRequestTokens: 64000,
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  billingModel: 'pay-per-token',
  inputCostPer1MTokens: 0.042,
  outputCostPer1MTokens: 0,
  calibratedProbabilities: true,
};

interface RawResult {
  status: number;
  retryAfter: string | null;
  text: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createJevProvider(opts: JevProviderOptions = {}): JudgmentProvider {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRetries = opts.maxRetries ?? 2;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const model = opts.model ?? JEV_DEFAULT_MODEL;

  const getKey = (): string | undefined => opts.apiKey || process.env[API_KEY_ENV] || undefined;
  const getBaseUrl = (): string => {
    // Strip trailing slashes with a linear scan (a `/\/+$/` regex is quadratic on long runs).
    let url = opts.baseUrl || process.env[BASE_URL_ENV] || JEV_DEFAULT_BASE_URL;
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  };

  /** Strip the key from any text that may end up in an error. */
  const redact = (text: string, key: string): string =>
    key ? text.split(key).join('[redacted]') : text;

  async function attempt(url: string, key: string, body: string): Promise<RawResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JudgmentProviderError('timeout', `Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const work = (async (): Promise<RawResult> => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      return {
        status: res.status,
        retryAfter: res.headers?.get?.('retry-after') ?? null,
        text: await res.text(),
      };
    })();
    work.catch(() => undefined); // a late rejection after the timeout won must not be unhandled
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      if (err instanceof JudgmentProviderError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      throw new JudgmentProviderError('network', `Network error: ${redact(raw, key)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function evaluate(req: JudgmentRequest): Promise<JudgmentResponse> {
    validateRequest(req);
    const key = getKey();
    if (!key) {
      throw new JudgmentProviderError(
        'auth',
        `No API key configured (set ${API_KEY_ENV} or pass apiKey)`,
      );
    }
    const url = `${getBaseUrl()}${JEV_PATH}`;
    const body = JSON.stringify(buildWireRequest(req, model));
    const started = Date.now();

    for (let n = 0; ; n++) {
      const res = await attempt(url, key, body);
      if (res.status >= 200 && res.status < 300) {
        const answers = parseWireResponse(res.text, req);
        return { ...answers, latencyMs: Date.now() - started };
      }
      if (res.status === 401) {
        throw new JudgmentProviderError('auth', 'Authentication failed (401)', 401);
      }
      if (res.status === 422) {
        throw new JudgmentProviderError('validation', 'Request rejected by provider (422)', 422);
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new JudgmentProviderError(
          'bad-response',
          `Unexpected HTTP status ${res.status}`,
          res.status,
        );
      }
      if (n >= maxRetries) {
        const kind = res.status === 429 ? 'rate-limited' : 'overloaded';
        throw new JudgmentProviderError(
          kind,
          `Provider returned ${res.status} after ${n + 1} attempt(s)`,
          res.status,
        );
      }
      await sleep(retryDelayMs(res.retryAfter, n));
    }
  }

  return {
    name: 'jev',
    modelId: model,
    capabilities: JEV_CAPABILITIES,
    requires: { envVar: API_KEY_ENV },
    get baseUrl() {
      return getBaseUrl();
    },
    async isAvailable() {
      return getKey()
        ? { available: true }
        : { available: false, reason: `${API_KEY_ENV} is not set` };
    },
    async getAccountId() {
      const key = getKey();
      if (!key) return null;
      return createHash('sha256').update(`jev:${key}`).digest('hex').slice(0, 16);
    },
    evaluate,
  };
}

function retryDelayMs(retryAfter: string | null, attemptIndex: number): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return BACKOFF_BASE_MS * 2 ** attemptIndex;
}

function validationError(message: string): JudgmentProviderError {
  return new JudgmentProviderError('validation', message);
}

function validateRequest(req: JudgmentRequest): void {
  const ids = Object.keys(req.questions);
  if (ids.length === 0) throw validationError('Request must contain at least one question');
  for (const id of ids) {
    const q = req.questions[id];
    if (q.type === 'choice') {
      const n = Object.keys(q.options).length;
      if (n < 2 || n > 255) {
        throw validationError(`Question '${id}': a choice needs 2 to 255 options (got ${n})`);
      }
    } else if (q.type === 'score') {
      const n = q.levels.length;
      if (n < 2 || n > 10) {
        throw validationError(`Question '${id}': a score needs 2 to 10 levels (got ${n})`);
      }
    } else if (q.type !== 'noul') {
      throw validationError(`Question '${id}': unsupported question type`);
    }
  }
}

function buildWireRequest(req: JudgmentRequest, model: string): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    questions[id] = toWireQuestion(q);
  }
  return { state: req.state, model, questions };
}

function toWireQuestion(q: JudgmentQuestion): Record<string, unknown> {
  switch (q.type) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.options };
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.levels };
    case 'noul':
      return q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
  }
}

function badResponse(message: string): JudgmentProviderError {
  return new JudgmentProviderError('bad-response', message);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseWireResponse(
  text: string,
  req: JudgmentRequest,
): Omit<JudgmentResponse, 'latencyMs'> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badResponse('Response body is not valid JSON');
  }
  if (!isRecord(json) || !isRecord(json.answers)) throw badResponse('Response has no answers');
  if (typeof json.model !== 'string') throw badResponse('Response has no model');
  const usage = isRecord(json.usage) ? json.usage : {};
  const inputTokens = isFiniteNumber(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = isFiniteNumber(usage.output_tokens) ? usage.output_tokens : 0;

  const answers: Record<string, JudgmentAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const raw = (json.answers as Record<string, unknown>)[id];
    if (!isRecord(raw)) throw badResponse(`Missing answer for question '${id}'`);
    if (raw.type !== q.type) {
      throw badResponse(`Answer for '${id}' has type '${String(raw.type)}', expected '${q.type}'`);
    }
    answers[id] = mapAnswer(id, q, raw);
  }
  return { answers, modelVersion: json.model, usage: { inputTokens, outputTokens } };
}

function mapAnswer(id: string, q: JudgmentQuestion, raw: Record<string, unknown>): JudgmentAnswer {
  if (q.type === 'noul') {
    if (!isFiniteNumber(raw.noul)) throw badResponse(`Answer for '${id}' has a non-numeric noul`);
    return { type: 'noul', probability: raw.noul };
  }
  if (!isFiniteNumber(raw.confidence)) {
    throw badResponse(`Answer for '${id}' has a non-numeric confidence`);
  }
  if (!isRecord(raw.probabilities)) throw badResponse(`Answer for '${id}' has no probabilities`);
  const probs = raw.probabilities;
  if (q.type === 'choice') {
    if (typeof raw.choice !== 'string' || !Object.hasOwn(q.options, raw.choice)) {
      throw badResponse(`Answer for '${id}' names a choice outside the supplied options`);
    }
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(probs)) {
      if (!isFiniteNumber(v)) throw badResponse(`Answer for '${id}' has a non-finite probability`);
      probabilities[k] = v;
    }
    return { type: 'choice', choice: raw.choice, probabilities, confidence: raw.confidence };
  }
  if (!isFiniteNumber(raw.score)) throw badResponse(`Answer for '${id}' has a non-numeric score`);
  const probabilities: number[] = [];
  for (let i = 0; i < (q.levels as Entry[]).length; i++) {
    const v = probs[String(i)];
    if (!isFiniteNumber(v))
      throw badResponse(`Answer for '${id}' has a bad probability at level ${i}`);
    probabilities.push(v);
  }
  return { type: 'score', score: raw.score, probabilities, confidence: raw.confidence };
}
