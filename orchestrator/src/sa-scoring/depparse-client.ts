/**
 * TypeScript client for the `sidecar-depparse` HTTP service.
 *
 * Used by Layer 1 deterministic SA scoring (RFC-0008 §B.4.2) to detect
 * requirement constructions (`requires X`, `must have X`, `X required`,
 * passive + negation-aware) in issue text.
 *
 * The client is injectable — production code wires in `HttpDepparseClient`
 * pointing at the sidecar URL, tests inject a `FakeDepparseClient` to
 * avoid the Python dependency.
 *
 * Retry semantics: one retry on 5xx responses (network or transient),
 * typed failure on anything else. Fail-soft by default — caller can
 * treat a `DepparseUnavailable` failure as "no matches" when the
 * sidecar is optional.
 */

export interface DepparseMatch {
  pattern: string;
  matchedText: string;
  depPath: string[];
  construction: string;
}

export interface DepparseMatchRequest {
  text: string;
  patterns: string[];
}

export interface DepparseMatchResponse {
  matches: DepparseMatch[];
}

export interface DepparseHealth {
  status: string;
  model?: string;
  modelLoaded: boolean;
}

export interface DepparseClient {
  match(request: DepparseMatchRequest): Promise<DepparseMatchResponse>;
  healthz(): Promise<DepparseHealth>;
}

// ── Error types ──────────────────────────────────────────────────────

export type DepparseErrorKind =
  | 'network'
  | 'bad-request'
  | 'server-error'
  | 'model-unavailable'
  | 'timeout';

export class DepparseError extends Error {
  readonly kind: DepparseErrorKind;
  readonly status?: number;

  constructor(kind: DepparseErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DepparseError';
    this.kind = kind;
    this.status = status;
  }
}

// ── HTTP client ──────────────────────────────────────────────────────

export interface HttpDepparseClientOptions {
  baseUrl: string;
  /** Per-request timeout in ms. Default 5 000. */
  timeoutMs?: number;
  /** Number of retries on 5xx / network errors. Default 1. */
  retries?: number;
  /** Injectable fetch — lets tests stub without overriding globalThis. */
  fetchImpl?: typeof fetch;
}

export class HttpDepparseClient implements DepparseClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpDepparseClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 1;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async healthz(): Promise<DepparseHealth> {
    const res = await this.requestJson<{
      status: string;
      model?: string | null;
      model_loaded: boolean;
    }>('GET', '/healthz');
    return {
      status: res.status,
      model: res.model ?? undefined,
      modelLoaded: Boolean(res.model_loaded),
    };
  }

  async match(request: DepparseMatchRequest): Promise<DepparseMatchResponse> {
    const body = JSON.stringify(request);
    const res = await this.requestJson<{
      matches: Array<{
        pattern: string;
        matched_text: string;
        dep_path: string[];
        construction: string;
      }>;
    }>('POST', '/v1/match', body);
    return {
      matches: res.matches.map((m) => ({
        pattern: m.pattern,
        matchedText: m.matched_text,
        depPath: m.dep_path,
        construction: m.construction,
      })),
    };
  }

  // ── Internals ──────────────────────────────────────────────────

  private async requestJson<T>(method: string, path: string, body?: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let lastError: DepparseError | undefined;
    const attempts = this.retries + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.doFetch(url, method, body);
        if (res.ok) {
          return (await res.json()) as T;
        }
        if (res.status === 503) {
          // Model not yet loaded — permanent for this request window.
          const text = await safeText(res);
          throw new DepparseError('model-unavailable', text || `503 at ${url}`, 503);
        }
        if (res.status >= 500) {
          lastError = new DepparseError('server-error', `${res.status} at ${url}`, res.status);
          continue; // retry
        }
        const text = await safeText(res);
        throw new DepparseError('bad-request', text || `${res.status} at ${url}`, res.status);
      } catch (err) {
        if (err instanceof DepparseError) {
          if (err.kind === 'server-error' && attempt + 1 < attempts) {
            lastError = err;
            continue;
          }
          throw err;
        }
        // Network / abort / unknown — retry once
        lastError = new DepparseError(
          errIsAbort(err) ? 'timeout' : 'network',
          err instanceof Error ? err.message : String(err),
        );
        if (attempt + 1 >= attempts) throw lastError;
      }
    }
    throw lastError ?? new DepparseError('network', `No response from ${url}`);
  }

  private async doFetch(url: string, method: string, body?: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errIsAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: string }).name === 'AbortError'
  );
}

// ── Fake client for tests ────────────────────────────────────────────

/**
 * In-memory test double that matches patterns by exact substring —
 * sufficient for unit tests that don't care about dependency-parse
 * semantics. Real scoring tests use recorded fixtures.
 */
export class FakeDepparseClient implements DepparseClient {
  private responses: DepparseMatchResponse | undefined;
  private healthResponse: DepparseHealth = {
    status: 'ok',
    model: 'fake',
    modelLoaded: true,
  };
  callLog: DepparseMatchRequest[] = [];

  setResponse(response: DepparseMatchResponse): void {
    this.responses = response;
  }

  setHealth(health: DepparseHealth): void {
    this.healthResponse = health;
  }

  async match(request: DepparseMatchRequest): Promise<DepparseMatchResponse> {
    this.callLog.push(request);
    if (this.responses) return this.responses;
    // Fallback: return substring matches with no dep_path info.
    const matches: DepparseMatch[] = [];
    for (const pattern of request.patterns) {
      if (request.text.toLowerCase().includes(pattern.toLowerCase())) {
        matches.push({
          pattern,
          matchedText: pattern,
          depPath: [],
          construction: 'substring',
        });
      }
    }
    return { matches };
  }

  async healthz(): Promise<DepparseHealth> {
    return this.healthResponse;
  }
}
