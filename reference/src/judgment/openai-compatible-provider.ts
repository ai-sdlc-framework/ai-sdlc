/**
 * Generic OpenAI-compatible adapter for the judgment layer. Posts the redacted
 * state and every question to a chat-completions endpoint (Ollama, OpenAI,
 * compatible gateways) and maps the model's JSON self-report to `JudgmentAnswer`.
 *
 * Lower fidelity by design: the probabilities are a model self-report, so the
 * adapter declares `calibratedProbabilities: false` and the runtime keeps every
 * judgment on it in shadow mode. Thin `fetch` client: no vendor SDK.
 */

import { createHash } from 'node:crypto';
import { JudgmentProviderError } from './errors.js';
import type {
  JudgmentAnswer,
  JudgmentCapabilities,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentRequest,
  JudgmentResponse,
} from './types.js';

export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'openai-compatible';
const CHAT_PATH = '/chat/completions';
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

/** The only keys `providerOptions.openai-compatible` accepts. Anything else disables the provider. */
export const OPENAI_COMPATIBLE_ALLOWED_OPTION_KEYS = [
  'baseUrl',
  'model',
  'apiKeyEnv',
  'timeoutMs',
  'maxRetries',
  'maxResponseBytes',
  'maxStateTokens',
  'inputCostPer1MTokens',
  'outputCostPer1MTokens',
] as const;

export const DEFAULT_MAX_RETRIES = 2;
export const MAX_RETRIES_CAP = 5;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES_CAP = 8 * 1024 * 1024;

/** Secret-bearing env var names that are never provider keys. Compared upper-cased. */
const API_KEY_ENV_DENYLIST = new Set([
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'AI_SDLC_PAT',
  'ANTHROPIC_API_KEY',
  'TYPESAFE_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Configuration surface: exactly the allowlisted keys, nothing injectable. */
export interface OpenAICompatibleProviderOptions {
  /** Endpoint base, e.g. `http://localhost:11434/v1`. Required for the provider to be available. */
  baseUrl?: string;
  /** Model id sent to the endpoint. */
  model?: string;
  /** Name of the env var holding the API key. Optional for local endpoints; requires https. */
  apiKeyEnv?: string;
  /** Per-attempt timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Retries after the first attempt on 429/5xx. Default 2, max 5. */
  maxRetries?: number;
  /** Maximum response body size in bytes. Default 1 MiB, max 8 MiB. */
  maxResponseBytes?: number;
  maxStateTokens?: number;
  inputCostPer1MTokens?: number;
  outputCostPer1MTokens?: number;
}

/** Test/host seams. Never reachable from config. */
export interface OpenAICompatibleProviderDeps {
  /** Injectable fetch; tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep used for backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable environment for the key lookup. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Model used when the options carry none (the config's top-level `spec.model`). */
  defaultModel?: string;
  /** Warning sink for clamped values. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export type OpenAICompatibleOptionsValidation =
  | { ok: true; options: OpenAICompatibleProviderOptions; warnings: string[] }
  | { ok: false; errors: string[] };

interface RawResult {
  status: number;
  retryAfter: string | null;
  text: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown, fallback: number): number =>
  isFiniteNumber(v) && v >= 1 ? Math.floor(v) : fallback;
const nonNeg = (v: unknown): number => (isFiniteNumber(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Same predicate as `isLoopbackUrl` in evaluate.ts (localhost, ::1, 127.0.0.0/8). */
function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Own-property read so inherited / prototype-polluted values never leak in. */
const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;

/** Strict baseUrl check. Returns an error string or undefined. */
function baseUrlProblem(raw: string, hasKey: boolean): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'baseUrl is not a parseable URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'baseUrl must use http or https';
  }
  if (u.username || u.password || raw.includes('@') || raw.includes('\\')) {
    return 'baseUrl must not contain credentials or userinfo';
  }
  if (u.protocol === 'http:') {
    if (hasKey) return 'baseUrl must use https when apiKeyEnv is set';
    if (!isLoopbackHost(raw)) return 'baseUrl must use https for a non-loopback host';
  }
  return undefined;
}

/**
 * Validate raw parsed `providerOptions.openai-compatible` BEFORE any defaulting.
 * The single validator shared by the registry factory and direct construction.
 */
export function validateOpenAICompatibleOptions(raw: unknown): OpenAICompatibleOptionsValidation {
  if (raw === undefined) return { ok: true, options: {}, warnings: [] };
  if (!isRecord(raw)) return { ok: false, errors: ['providerOptions must be an object'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set<string>(OPENAI_COMPATIBLE_ALLOWED_OPTION_KEYS);
  for (const k of Reflect.ownKeys(raw)) {
    const name = typeof k === 'symbol' ? k.toString() : k;
    if (!allowed.has(name)) errors.push(`unknown providerOptions key '${name}'`);
  }

  const baseUrl = own(raw, 'baseUrl');
  const apiKeyEnv = own(raw, 'apiKeyEnv');
  if (baseUrl !== undefined && typeof baseUrl !== 'string') errors.push('baseUrl must be a string');
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') {
    errors.push('apiKeyEnv must be a string');
  }
  if (typeof apiKeyEnv === 'string' && apiKeyEnv) {
    if (!ENV_NAME_RE.test(apiKeyEnv)) {
      errors.push('apiKeyEnv is not a valid environment variable name');
    } else {
      const norm = apiKeyEnv.toUpperCase();
      if (norm === '__PROTO__' || API_KEY_ENV_DENYLIST.has(norm) || norm.endsWith('_PRIVATE_KEY')) {
        errors.push(`apiKeyEnv '${apiKeyEnv}' is a denylisted secret name`);
      }
    }
  }
  if (typeof baseUrl === 'string' && baseUrl) {
    const problem = baseUrlProblem(baseUrl, typeof apiKeyEnv === 'string' && apiKeyEnv !== '');
    if (problem) errors.push(problem);
  }
  if (errors.length > 0) return { ok: false, errors };

  const options: OpenAICompatibleProviderOptions = {};
  for (const k of OPENAI_COMPATIBLE_ALLOWED_OPTION_KEYS) {
    const v = own(raw, k);
    if (v !== undefined) (options as Record<string, unknown>)[k] = v;
  }
  if (isFiniteNumber(options.maxRetries) && options.maxRetries > MAX_RETRIES_CAP) {
    warnings.push(
      `maxRetries ${options.maxRetries} exceeds the cap; clamped to ${MAX_RETRIES_CAP}`,
    );
    options.maxRetries = MAX_RETRIES_CAP;
  }
  if (
    isFiniteNumber(options.maxResponseBytes) &&
    options.maxResponseBytes > MAX_RESPONSE_BYTES_CAP
  ) {
    warnings.push(
      `maxResponseBytes ${options.maxResponseBytes} exceeds the cap; clamped to ${MAX_RESPONSE_BYTES_CAP}`,
    );
    options.maxResponseBytes = MAX_RESPONSE_BYTES_CAP;
  }
  return { ok: true, options, warnings };
}

/** A provider that is permanently unavailable, carrying the reason (shown by doctor). */
function createDisabledProvider(reason: string): JudgmentProvider {
  const fail = (): never => {
    throw new JudgmentProviderError('validation', reason);
  };
  return {
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    modelId: '',
    capabilities: {
      maxStateTokens: 8000,
      maxRequestTokens: 16000,
      maxChoiceOptions: 50,
      maxScoreLevels: 10,
      billingModel: 'pay-per-token',
      inputCostPer1MTokens: 0,
      outputCostPer1MTokens: 0,
      calibratedProbabilities: false,
    },
    requires: { envVar: '' },
    async isAvailable() {
      return { available: false, reason };
    },
    async getAccountId() {
      return null;
    },
    evaluate: async () => fail(),
  };
}

/** Read a response body without ever holding more than `cap` bytes; abort on overflow. */
async function readCapped(
  res: Response,
  cap: number,
  controller: AbortController,
): Promise<string> {
  const tooBig = (): JudgmentProviderError => {
    controller.abort();
    return new JudgmentProviderError('bad-response', `Response exceeded maxResponseBytes (${cap})`);
  };
  const declared = res.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > cap) {
    void res.body?.cancel?.().catch(() => undefined);
    throw tooBig();
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > cap) throw tooBig();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      void reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOpenAICompatibleProvider(
  rawOpts: unknown = {},
  deps: OpenAICompatibleProviderDeps = {},
): JudgmentProvider {
  const validation = validateOpenAICompatibleOptions(rawOpts);
  if (!validation.ok) {
    return createDisabledProvider(`invalid providerOptions: ${validation.errors.join('; ')}`);
  }
  const opts = validation.options;
  const warn = deps.warn ?? ((m: string) => console.warn(`[judgment] openai-compatible: ${m}`));
  for (const w of validation.warnings) warn(w);
  const timeoutMs = posInt(opts.timeoutMs, 10_000);
  const maxRetries =
    isFiniteNumber(opts.maxRetries) && opts.maxRetries >= 0
      ? Math.floor(opts.maxRetries)
      : DEFAULT_MAX_RETRIES;
  const maxResponseBytes = posInt(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const env = deps.env ?? process.env;
  const model = str(opts.model) ?? str(deps.defaultModel) ?? '';
  const apiKeyEnv = str(opts.apiKeyEnv);

  // Strip trailing slashes with a linear scan (a `/\/+$/` regex is quadratic on long runs).
  let baseUrl = str(opts.baseUrl) ?? '';
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

  const capabilities: JudgmentCapabilities = {
    maxStateTokens: posInt(opts.maxStateTokens, 8000),
    maxRequestTokens: 16000,
    maxChoiceOptions: 50,
    maxScoreLevels: 10,
    billingModel: 'pay-per-token',
    inputCostPer1MTokens: nonNeg(opts.inputCostPer1MTokens),
    outputCostPer1MTokens: nonNeg(opts.outputCostPer1MTokens),
    calibratedProbabilities: false,
  };

  const getKey = (): string | undefined =>
    apiKeyEnv && Object.hasOwn(env, apiKeyEnv) ? env[apiKeyEnv] || undefined : undefined;

  /** Strip the key from any text that may end up in an error. */
  const redact = (text: string, key: string | undefined): string =>
    key ? text.split(key).join('[redacted]') : text;

  async function attempt(url: string, key: string | undefined, body: string): Promise<RawResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JudgmentProviderError('timeout', `Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const work = (async (): Promise<RawResult> => {
      // `manual`: a redirect is never followed, so the key cannot reach another origin.
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      return {
        status: res.status,
        retryAfter: res.headers?.get?.('retry-after') ?? null,
        text: await readCapped(res, maxResponseBytes, controller),
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
    validateRequest(req, capabilities);
    if (!baseUrl) throw new JudgmentProviderError('validation', 'No baseUrl configured');
    if (!model) throw new JudgmentProviderError('validation', 'No model configured');
    const key = getKey();
    if (apiKeyEnv && !key && !isLoopbackHost(baseUrl)) {
      throw new JudgmentProviderError('auth', `No API key found in ${apiKeyEnv}`);
    }
    const url = `${baseUrl}${CHAT_PATH}`;
    const started = Date.now();

    let useResponseFormat = true;
    let transient = 0;
    for (;;) {
      const body = JSON.stringify(buildWireRequest(req, model, useResponseFormat));
      const res = await attempt(url, key, body);
      if (res.status >= 200 && res.status < 300) {
        const parsed = parseWireResponse(res.text, req, model);
        return { ...parsed, latencyMs: Date.now() - started };
      }
      if (res.status === 400 && useResponseFormat) {
        useResponseFormat = false; // some endpoints reject response_format; retry once without it
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new JudgmentProviderError(
          'auth',
          `Authentication failed (${res.status})`,
          res.status,
        );
      }
      if (res.status === 400 || res.status === 422) {
        throw new JudgmentProviderError(
          'validation',
          `Request rejected by provider (${res.status})`,
          res.status,
        );
      }
      if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
        throw new JudgmentProviderError(
          'bad-response',
          `Endpoint redirected (${res.status}); redirects are not followed`,
          res.status,
        );
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new JudgmentProviderError(
          'bad-response',
          `Unexpected HTTP status ${res.status}`,
          res.status,
        );
      }
      if (transient >= maxRetries) {
        const kind = res.status === 429 ? 'rate-limited' : 'overloaded';
        throw new JudgmentProviderError(
          kind,
          `Provider returned ${res.status} after ${transient + 1} attempt(s)`,
          res.status,
        );
      }
      await sleep(retryDelayMs(res.retryAfter, transient));
      transient++;
    }
  }

  return {
    name: OPENAI_COMPATIBLE_PROVIDER_NAME,
    modelId: model,
    capabilities,
    requires: { envVar: apiKeyEnv ?? '' },
    baseUrl,
    async isAvailable() {
      if (!baseUrl) return { available: false, reason: 'baseUrl is not configured' };
      if (!model) return { available: false, reason: 'model is not configured' };
      if (apiKeyEnv && !getKey() && !isLoopbackHost(baseUrl)) {
        return { available: false, reason: `${apiKeyEnv} is not set` };
      }
      return { available: true };
    },
    async getAccountId() {
      const key = getKey();
      if (!key) return null;
      return createHash('sha256')
        .update(`${OPENAI_COMPATIBLE_PROVIDER_NAME}:${baseUrl}:${key}`)
        .digest('hex')
        .slice(0, 16);
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

function validateRequest(req: JudgmentRequest, caps: JudgmentCapabilities): void {
  const ids = Object.keys(req.questions);
  if (ids.length === 0) throw validationError('Request must contain at least one question');
  for (const id of ids) {
    const q = req.questions[id];
    if (q.type === 'choice') {
      const n = Object.keys(q.options).length;
      if (n < 2 || n > caps.maxChoiceOptions) {
        throw validationError(
          `Question '${id}': a choice needs 2 to ${caps.maxChoiceOptions} options (got ${n})`,
        );
      }
    } else if (q.type === 'score') {
      const n = q.levels.length;
      if (n < 2 || n > caps.maxScoreLevels) {
        throw validationError(
          `Question '${id}': a score needs 2 to ${caps.maxScoreLevels} levels (got ${n})`,
        );
      }
    } else if (q.type !== 'noul') {
      throw validationError(`Question '${id}': unsupported question type`);
    }
  }
}

const SYSTEM_PROMPT = [
  'You are a classification engine. You answer closed-set questions about the supplied state.',
  'Reply with a single JSON object and nothing else, keyed by question id.',
  'For a "choice" question: {"choice": "<one option key>", "probabilities": {"<option key>": <0..1>, ...}}.',
  'For a "score" question: {"score": <integer level index>, "probabilities": [<0..1> per level, in order]}.',
  'For a "noul" question: {"probability": <0..1 probability that the answer is yes>}.',
  'Probabilities for one question must be non-negative and sum to 1 (a noul is a single probability).',
  'Never reply with prose, explanations or any key other than the question ids.',
].join('\n');

function describeQuestion(q: JudgmentQuestion): Record<string, unknown> {
  switch (q.type) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, options: q.options };
    case 'score':
      return {
        type: 'score',
        instructions: q.instructions,
        levels: q.levels.map((description, index) => ({ index, description })),
      };
    case 'noul':
      return q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
  }
}

function buildWireRequest(
  req: JudgmentRequest,
  model: string,
  useResponseFormat: boolean,
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) questions[id] = describeQuestion(q);
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ state: req.state, questions }) },
    ],
    ...(useResponseFormat ? { response_format: { type: 'json_object' } } : {}),
  };
}

function badResponse(message: string): JudgmentProviderError {
  return new JudgmentProviderError('bad-response', message);
}

/** Strict parse first, then strip exactly one surrounding code fence and parse again. */
function parseModelJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // fall through to the fenced form
  }
  const trimmed = content.trim();
  if (trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length >= 6) {
    const inner = trimmed.slice(3, -3);
    const nl = inner.indexOf('\n');
    const body = nl >= 0 ? inner.slice(nl + 1) : inner;
    try {
      return JSON.parse(body);
    } catch {
      // fall through
    }
  }
  throw badResponse('Model reply is not valid JSON');
}

function parseWireResponse(
  text: string,
  req: JudgmentRequest,
  model: string,
): Omit<JudgmentResponse, 'latencyMs'> {
  let wire: unknown;
  try {
    wire = JSON.parse(text);
  } catch {
    throw badResponse('Response body is not valid JSON');
  }
  if (!isRecord(wire) || !Array.isArray(wire.choices) || !isRecord(wire.choices[0])) {
    throw badResponse('Response has no choices');
  }
  const message = wire.choices[0].message;
  if (!isRecord(message) || typeof message.content !== 'string') {
    throw badResponse('Response has no message content');
  }
  const reply = parseModelJson(message.content);
  if (!isRecord(reply)) throw badResponse('Model reply is not a JSON object');

  const usage = isRecord(wire.usage) ? wire.usage : {};
  const answers: Record<string, JudgmentAnswer> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    if (!Object.hasOwn(reply, id)) throw badResponse(`Missing answer for question '${id}'`);
    answers[id] = mapAnswer(id, q, reply[id]);
  }
  return {
    answers,
    modelVersion: typeof wire.model === 'string' && wire.model ? wire.model : model,
    usage: {
      inputTokens: isFiniteNumber(usage.prompt_tokens) ? usage.prompt_tokens : 0,
      outputTokens: isFiniteNumber(usage.completion_tokens) ? usage.completion_tokens : 0,
    },
  };
}

const inUnit = (n: unknown): n is number => isFiniteNumber(n) && n >= 0 && n <= 1;

/** Normalise non-negative weights to sum 1; a zero sum is a bad answer. */
function normalise(id: string, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) {
    throw badResponse(`Answer for '${id}' has probabilities that do not sum to a positive value`);
  }
  return weights.map((w) => w / sum);
}

/** Distribution over `n` slots from a reported confidence on `chosen`, remainder spread evenly. */
function fromConfidence(id: string, raw: Record<string, unknown>, n: number, chosen: number) {
  if (!inUnit(raw.confidence)) {
    throw badResponse(`Answer for '${id}' has neither probabilities nor a confidence`);
  }
  const rest = (1 - raw.confidence) / (n - 1);
  return Array.from({ length: n }, (_, i) => (i === chosen ? raw.confidence : rest)) as number[];
}

function checkWeight(id: string, v: unknown): number {
  if (!isFiniteNumber(v) || v < 0) {
    throw badResponse(`Answer for '${id}' has an invalid probability`);
  }
  return v;
}

function mapAnswer(id: string, q: JudgmentQuestion, raw: unknown): JudgmentAnswer {
  if (q.type === 'noul') {
    const p = isRecord(raw) ? raw.probability : raw;
    if (!inUnit(p)) throw badResponse(`Answer for '${id}' has no probability between 0 and 1`);
    return { type: 'noul', probability: p };
  }
  if (!isRecord(raw)) throw badResponse(`Answer for '${id}' is not an object`);

  if (q.type === 'choice') {
    const keys = Object.keys(q.options);
    if (typeof raw.choice !== 'string' || !Object.hasOwn(q.options, raw.choice)) {
      throw badResponse(`Answer for '${id}' names a choice outside the supplied options`);
    }
    const chosen = keys.indexOf(raw.choice);
    let dist: number[];
    if (raw.probabilities === undefined || raw.probabilities === null) {
      dist = fromConfidence(id, raw, keys.length, chosen);
    } else {
      if (!isRecord(raw.probabilities))
        throw badResponse(`Answer for '${id}' has bad probabilities`);
      for (const k of Object.keys(raw.probabilities)) {
        if (!Object.hasOwn(q.options, k)) {
          throw badResponse(`Answer for '${id}' has a probability for an unknown option`);
        }
      }
      const probs = raw.probabilities;
      dist = normalise(
        id,
        keys.map((k) => (Object.hasOwn(probs, k) ? checkWeight(id, probs[k]) : 0)),
      );
    }
    const probabilities: Record<string, number> = {};
    keys.forEach((k, i) => (probabilities[k] = dist[i]));
    return { type: 'choice', choice: raw.choice, probabilities, confidence: Math.max(...dist) };
  }

  const n = q.levels.length;
  const score = raw.score;
  if (!isFiniteNumber(score) || !Number.isInteger(score) || score < 0 || score >= n) {
    throw badResponse(`Answer for '${id}' has a level index outside the range`);
  }
  let dist: number[];
  if (raw.probabilities === undefined || raw.probabilities === null) {
    dist = fromConfidence(id, raw, n, score);
  } else if (Array.isArray(raw.probabilities)) {
    if (raw.probabilities.length !== n) {
      throw badResponse(`Answer for '${id}' has the wrong number of level probabilities`);
    }
    dist = normalise(
      id,
      raw.probabilities.map((v) => checkWeight(id, v)),
    );
  } else if (isRecord(raw.probabilities)) {
    const probs = raw.probabilities;
    for (const k of Object.keys(probs)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= n || String(i) !== k) {
        throw badResponse(`Answer for '${id}' has a probability for an unknown level`);
      }
    }
    dist = normalise(
      id,
      Array.from({ length: n }, (_, i) =>
        Object.hasOwn(probs, String(i)) ? checkWeight(id, probs[String(i)]) : 0,
      ),
    );
  } else {
    throw badResponse(`Answer for '${id}' has bad probabilities`);
  }
  return { type: 'score', score, probabilities: dist, confidence: Math.max(...dist) };
}
