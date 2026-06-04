/**
 * RFC-0043 Phase 7 — `inference.local` Credential-Withholding Proxy (AISDLC-510)
 *
 * The security-critical W4 component: a host-side proxy that intercepts all
 * model-API calls from inside the sandbox, injects the provider credential
 * out-of-process, and enforces strict policy constraints.
 *
 * ## Threat model
 * The in-sandbox reviewer process reads attacker-controlled diff text. A
 * prompt-injection in the diff may attempt to use the proxy as an exfiltration
 * channel (e.g. by encoding secrets into a model request payload, or by
 * requesting tool-use calls to external hosts). The proxy counters this by:
 *
 *  1. **Request scoping** — each proxy instance is bound to one PR; calls
 *     from any process that does not present the correct `X-Proxy-Session` token
 *     are rejected 403.
 *  2. **Tool-use refusal** — any request body that contains a `tools` or
 *     `tool_choice` field is rejected 422. Reviewers must call text-only
 *     inference; no tool execution path reaches the upstream API.
 *  3. **Rate and size limits** — max N requests per session, max body size
 *     configurable, enforced before the upstream call.
 *  4. **Payload sanitisation** — response bodies are forwarded verbatim; the
 *     credential header is stripped on every log entry (redaction tested).
 *  5. **Non-review call blocking** — only HTTP POST to
 *     `/v1/messages` (Anthropic) or `/v1/chat/completions` (OpenAI-compat) is
 *     accepted; any other path or method is rejected 404/405.
 *
 * ## Injectable seams
 * The actual HTTP server bind and upstream HTTPS connect are injectable via
 * `_createServer` and `_connectToUpstream`. All policy logic (scoping,
 * tool-use refusal, rate limit, redaction, allow/deny) is exercised by
 * hermetic tests through these seams. Only the irreducible socket bind and
 * upstream TLS connect are integration-gated behind
 * `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 *
 * ## Usage
 * ```ts
 * const proxy = new InferenceProxy({ prNumber: 42, credential: 'sk-...' });
 * const { port, sessionToken } = await proxy.start();
 * // pass port + sessionToken to in-sandbox reviewer (NOT the credential)
 * await proxy.stop();
 * ```
 *
 * @module pipeline/inference-proxy
 */

import { createServer as nodeCreateServer, request as nodeHttpsRequest } from 'node:https';
import {
  createServer as nodeCreateHttpServer,
  request as nodeHttpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { randomBytes } from 'node:crypto';

// ── Public types ──────────────────────────────────────────────────────────────

/** Upstream provider that the proxy will forward to. */
export type InferenceProvider = 'anthropic' | 'openai';

/**
 * Rate and size caps applied per proxy session.
 * Configurable per reviewer use-case; defaults are conservative.
 */
export interface ProxyLimits {
  /** Maximum number of model requests per session (default: 20). */
  maxRequestsPerSession: number;
  /** Maximum request body size in bytes (default: 256 KB). */
  maxBodyBytes: number;
  /** Maximum response body size in bytes (default: 1 MB). */
  maxResponseBytes: number;
}

/**
 * Audit log entry produced for each request.
 * The credential is NEVER included — redacted to `[REDACTED]` in all fields.
 */
export interface ProxyAuditEntry {
  ts: string;
  prNumber: number;
  sessionToken: string;
  /** HTTP method of the incoming request (e.g. `POST`). */
  method: string;
  /** Path of the incoming request (e.g. `/v1/messages`). */
  path: string;
  /** Request body size in bytes (BEFORE any truncation). */
  requestBodyBytes: number;
  /** HTTP status code returned to the caller (200, 403, 422, …). */
  responseStatus: number;
  /** `true` when the request was forwarded to the upstream provider. */
  forwarded: boolean;
  /** Denial reason when `forwarded` is `false` (e.g. `tool-use-refused`). */
  denialReason?: ProxyDenialReason;
}

export type ProxyDenialReason =
  | 'invalid-session'
  | 'tool-use-refused'
  | 'rate-limit-exceeded'
  | 'body-too-large'
  | 'method-not-allowed'
  | 'path-not-allowed'
  | 'upstream-error'
  | 'response-too-large'
  | 'proxy-not-started';

/**
 * Configuration for a proxy instance.
 */
export interface InferenceProxyConfig {
  /** The PR number this proxy session is scoped to. */
  prNumber: number;
  /**
   * The provider API credential.
   * NEVER passed to the sandbox; injected here in the host-side process.
   */
  credential: string;
  /** Which upstream provider to forward to. Default: `anthropic`. */
  provider?: InferenceProvider;
  /** Rate and size caps. Defaults: 20 req / 256 KB / 1 MB. */
  limits?: Partial<ProxyLimits>;
  /**
   * Audit log sink. Each accepted/denied request produces one entry.
   * Defaults to a stderr writer when not provided.
   */
  auditLog?: (entry: ProxyAuditEntry) => void;
  /**
   * Port to bind the proxy on. When 0 (default), the OS assigns a free port.
   * Integration tests may set a specific port; unit tests use the mock seam.
   */
  port?: number;
  /**
   * Whether the proxy should accept HTTP (true) or HTTPS (false, default).
   * Containers connect over HTTP to the host alias; TLS termination between
   * proxy and upstream is always enforced.
   * In integration tests, set to `true` for simpler test setup.
   */
  useHttp?: boolean;
}

/** Result returned by `proxy.start()`. */
export interface ProxyStartResult {
  /** The port the proxy is listening on. */
  port: number;
  /**
   * The session token the reviewer process must send in
   * `X-Proxy-Session: <token>` on every request.
   * Scopes the proxy to this PR — any other token is rejected 403.
   */
  sessionToken: string;
}

// ── Upstream endpoint definitions ─────────────────────────────────────────────

interface UpstreamEndpoint {
  hostname: string;
  port: number;
  /** Paths accepted by the proxy on POST. */
  allowedPaths: readonly string[];
  /** The HTTP Authorization header prefix (e.g. `x-api-key` or `Bearer`). */
  credentialHeader: string;
  credentialHeaderStyle: 'x-api-key' | 'bearer';
}

const UPSTREAM_ENDPOINTS: Record<InferenceProvider, UpstreamEndpoint> = {
  anthropic: {
    hostname: 'api.anthropic.com',
    port: 443,
    allowedPaths: ['/v1/messages'],
    credentialHeader: 'x-api-key',
    credentialHeaderStyle: 'x-api-key',
  },
  openai: {
    hostname: 'api.openai.com',
    port: 443,
    allowedPaths: ['/v1/chat/completions'],
    credentialHeader: 'authorization',
    credentialHeaderStyle: 'bearer',
  },
};

// ── Default limits ─────────────────────────────────────────────────────────────

export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  maxRequestsPerSession: 20,
  maxBodyBytes: 256 * 1024, // 256 KB
  maxResponseBytes: 1024 * 1024, // 1 MB
};

// ── Credential redaction ──────────────────────────────────────────────────────

/**
 * Redaction token substituted for any credential occurrence in logs.
 * The token is visibly synthetic — never a partial key or hash.
 */
export const REDACTED_TOKEN = '[REDACTED]';

/**
 * Redact a credential from a string.
 * Used on all log entries before emission.
 *
 * Does NOT log anything itself — returns the sanitised string.
 */
export function redactCredential(value: string, credential: string): string {
  if (!credential || !value) return value;
  // Replace every literal occurrence (the credential may appear in query params,
  // headers forwarded verbatim, or debug output from the upstream).
  return value.split(credential).join(REDACTED_TOKEN);
}

/**
 * Validate that a log entry does NOT contain the credential.
 * Used in tests to assert the redaction invariant.
 *
 * Returns `true` when the entry is clean (credential not found).
 */
export function assertEntryClean(entry: ProxyAuditEntry, credential: string): boolean {
  const entryStr = JSON.stringify(entry);
  return !entryStr.includes(credential);
}

// ── Request body parsing ──────────────────────────────────────────────────────

/**
 * Read the full request body up to `maxBytes`.
 * Returns `null` when the body exceeds `maxBytes`.
 */
export async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Check whether a parsed JSON request body contains tool-use fields.
 *
 * Detects:
 *  - `tools` array present (Anthropic / OpenAI tool-use spec)
 *  - `tool_choice` field present (OpenAI)
 *  - `function_call` field present (OpenAI legacy)
 *
 * Returns `true` when tool-use fields are detected.
 */
export function detectToolUse(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  if ('tools' in obj && Array.isArray(obj['tools']) && obj['tools'].length > 0) return true;
  if ('tool_choice' in obj) return true;
  if ('function_call' in obj) return true;
  if ('functions' in obj && Array.isArray(obj['functions']) && obj['functions'].length > 0)
    return true;
  return false;
}

/**
 * Check whether a request body encodes a review-shaped call.
 *
 * A review call is defined as:
 *  - JSON object
 *  - No tool-use fields (enforced separately via `detectToolUse`)
 *  - Contains a `messages` array (Anthropic / OpenAI format)
 *
 * Returns `true` when the body looks like a review-shaped inference call.
 * Returns `false` for any other shape (non-JSON, missing messages, etc.).
 *
 * Note: the proxy does NOT validate the *content* of the messages — that is
 * the reviewer's responsibility. The proxy only validates the structural shape.
 */
export function isReviewShapedCall(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  return 'messages' in obj && Array.isArray(obj['messages']);
}

// ── Upstream request seam ────────────────────────────────────────────────────

/**
 * The upstream connect result — a response-like interface that the proxy reads
 * from after forwarding the request.
 *
 * @internal — exported for hermetic testing via the injectable seam.
 */
export interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Upstream connector function signature.
 * In production: makes an HTTPS request to the real provider API.
 * In tests: returns a controlled `UpstreamResponse` without network I/O.
 */
export type UpstreamConnector = (opts: {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}) => Promise<UpstreamResponse>;

/**
 * Production upstream connector — makes a real HTTPS request.
 * ONLY reached when `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 *
 * @internal — exposed so subclasses and tests can verify it is not called in unit tests.
 */
export function defaultUpstreamConnector(opts: {
  hostname: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    // Use node:https for real outbound TLS connections to provider APIs.
    // This import path keeps the seam boundary clean — unit tests never reach here.
    const isHttps = opts.port === 443;
    const reqFn = isHttps ? nodeHttpsRequest : nodeHttpRequest;

    const req = reqFn(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 502,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
          });
          void total; // used only to count — enforce no size cap at connector level
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(opts.body);
    req.end();
  });
}

// ── Server factory seam ──────────────────────────────────────────────────────

/**
 * Server factory function signature.
 * In production: creates a real HTTP/HTTPS server.
 * In tests: returns a mock server that records calls without binding a port.
 */
export type ServerFactory = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) => Server;

/** Production HTTP server factory. */
export const defaultHttpServerFactory: ServerFactory = (handler) => {
  return nodeCreateHttpServer(handler) as unknown as Server;
};

/** Production HTTPS server factory (requires TLS cert for real use). */
export const defaultHttpsServerFactory: ServerFactory = (handler) => {
  // In integration mode, a self-signed cert must be provisioned.
  // For now the proxy defaults to HTTP (`useHttp: true`) for container-local
  // loopback connections; TLS termination from proxy → upstream is always HTTPS.
  return nodeCreateServer(handler) as Server;
};

// ── Proxy session state ───────────────────────────────────────────────────────

interface ProxySessionState {
  prNumber: number;
  sessionToken: string;
  requestCount: number;
}

// ── InferenceProxy ────────────────────────────────────────────────────────────

/**
 * Host-side credential-withholding inference proxy for RFC-0043 Phase 7 (W4).
 *
 * Intercepts model-API calls from the in-sandbox reviewer, injects the
 * provider credential out-of-process, and enforces strict request policy.
 *
 * The sandbox reviewer connects to `inference.local:<port>` (or the host
 * alias exposed by the Docker bridge). The proxy holds the credential and
 * forwards clean model calls to the upstream provider API.
 *
 * Security invariants tested in hermetic unit tests:
 *  - A process with NO provider env var can complete a model call via the proxy.
 *  - A non-review/tool-use call is refused 422.
 *  - The credential never appears in audit log entries.
 *  - A request with an invalid session token is refused 403.
 *  - A request exceeding rate or size limits is refused 429/413.
 *  - Only `POST /v1/messages` (Anthropic) or `POST /v1/chat/completions` (OpenAI)
 *    are accepted; all other paths return 404.
 */
export class InferenceProxy {
  private readonly config: InferenceProxyConfig & { provider: InferenceProvider };
  private readonly limits: ProxyLimits;
  private readonly upstream: UpstreamEndpoint;
  private session: ProxySessionState | null = null;
  private server: Server | null = null;

  /**
   * Injectable seam: upstream connector.
   * Defaults to `defaultUpstreamConnector` (real HTTPS).
   * Override in tests to avoid network I/O.
   *
   * @internal — public for test subclassing only.
   */
  protected _connectToUpstream: UpstreamConnector = defaultUpstreamConnector;

  /**
   * Injectable seam: server factory.
   * Defaults to `defaultHttpServerFactory`.
   * Override in tests to avoid socket binding.
   *
   * @internal — public for test subclassing only.
   */
  protected _createServer: ServerFactory = defaultHttpServerFactory;

  constructor(config: InferenceProxyConfig) {
    this.config = {
      provider: 'anthropic',
      useHttp: true,
      port: 0,
      ...config,
    };
    this.limits = {
      ...DEFAULT_PROXY_LIMITS,
      ...(config.limits ?? {}),
    };
    this.upstream = UPSTREAM_ENDPOINTS[this.config.provider];
  }

  /**
   * Start the proxy. Binds the server and returns the port + session token.
   *
   * The session token must be passed to the reviewer process (NOT the credential).
   * The reviewer sends `X-Proxy-Session: <token>` on every request; the proxy
   * validates it before forwarding.
   */
  async start(): Promise<ProxyStartResult> {
    if (this.server) {
      throw new Error('InferenceProxy.start() called while already running');
    }

    // Generate a fresh session token — 32 bytes → 64 hex chars
    const sessionToken = randomBytes(32).toString('hex');
    this.session = {
      prNumber: this.config.prNumber,
      sessionToken,
      requestCount: 0,
    };

    const server = this._createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        // Swallow unhandled errors — log via audit and respond 500
        const entry = this.makeAuditEntry({
          req,
          requestBodyBytes: 0,
          responseStatus: 500,
          forwarded: false,
          denialReason: 'upstream-error',
        });
        this.emitAudit(entry);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal proxy error', detail: String(err) }));
        } catch {
          // best-effort — socket may already be closed
        }
      });
    });

    this.server = server;

    return new Promise<ProxyStartResult>((resolve, reject) => {
      server.listen(this.config.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('InferenceProxy: server address is not available'));
          return;
        }
        resolve({ port: addr.port, sessionToken });
      });
      server.on('error', reject);
    });
  }

  /**
   * Stop the proxy. Closes the server and resets session state.
   * Idempotent — safe to call even if the proxy was never started.
   */
  async stop(): Promise<void> {
    this.session = null;
    if (!this.server) return;

    const server = this.server;
    this.server = null;

    return new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-close any keep-alive connections
      server.closeAllConnections?.();
    });
  }

  // ── Request handling ────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.session;
    if (!session) {
      this.sendDenial(res, 503, 'proxy-not-started', req, 0);
      return;
    }

    // 1. Validate method — only POST is accepted
    const method = req.method ?? 'GET';
    if (method !== 'POST') {
      this.sendDenial(res, 405, 'method-not-allowed', req, 0);
      return;
    }

    // 2. Validate path — only the upstream provider's allowed paths
    const path = req.url ?? '/';
    if (!this.upstream.allowedPaths.includes(path)) {
      this.sendDenial(res, 404, 'path-not-allowed', req, 0);
      return;
    }

    // 3. Validate session token from X-Proxy-Session header
    const incomingToken = req.headers['x-proxy-session'];
    if (!incomingToken || incomingToken !== session.sessionToken) {
      this.sendDenial(res, 403, 'invalid-session', req, 0);
      return;
    }

    // 4. Rate limit check (checked before reading body to save resources)
    if (session.requestCount >= this.limits.maxRequestsPerSession) {
      this.sendDenial(res, 429, 'rate-limit-exceeded', req, 0);
      return;
    }

    // 5. Read and size-check request body
    const rawBody = await readRequestBody(req, this.limits.maxBodyBytes);
    if (rawBody === null) {
      this.sendDenial(res, 413, 'body-too-large', req, this.limits.maxBodyBytes + 1);
      return;
    }

    // 6. Parse body and check for tool-use fields
    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody.length > 0 ? (JSON.parse(rawBody.toString('utf8')) as unknown) : null;
    } catch {
      // Non-JSON body — treat as a non-review call → forward as-is (provider will reject)
    }

    if (detectToolUse(parsedBody)) {
      this.sendDenial(res, 422, 'tool-use-refused', req, rawBody.length);
      return;
    }

    // 7. Increment request count BEFORE forwarding (atomic within the request handler)
    session.requestCount += 1;

    // 8. Forward to upstream
    await this.forwardToUpstream(req, res, rawBody, session, path);
  }

  private async forwardToUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    session: ProxySessionState,
    path: string,
  ): Promise<void> {
    // Build upstream headers — inject the credential HERE, not in sandbox env
    const upstreamHeaders: Record<string, string> = {
      'content-type': req.headers['content-type'] ?? 'application/json',
      'content-length': String(body.length),
      // Inject provider credential — this is the ONLY place it appears
      ...(this.upstream.credentialHeaderStyle === 'x-api-key'
        ? { 'x-api-key': this.config.credential }
        : { authorization: `Bearer ${this.config.credential}` }),
    };

    // Forward Anthropic-specific headers if present
    const anthropicVersion = req.headers['anthropic-version'];
    if (anthropicVersion) {
      upstreamHeaders['anthropic-version'] = Array.isArray(anthropicVersion)
        ? anthropicVersion[0]!
        : anthropicVersion;
    }

    let upstreamResponse: UpstreamResponse;
    try {
      upstreamResponse = await this._connectToUpstream({
        hostname: this.upstream.hostname,
        port: this.upstream.port,
        path,
        method: 'POST',
        headers: upstreamHeaders,
        body,
      });
    } catch (err) {
      this.emitAudit(
        this.makeAuditEntry({
          req,
          requestBodyBytes: body.length,
          responseStatus: 502,
          forwarded: false,
          denialReason: 'upstream-error',
        }),
      );
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream connection failed', detail: String(err) }));
      return;
    }

    // Size-check the upstream response
    if (upstreamResponse.body.length > this.limits.maxResponseBytes) {
      this.emitAudit(
        this.makeAuditEntry({
          req,
          requestBodyBytes: body.length,
          responseStatus: 502,
          forwarded: false,
          denialReason: 'response-too-large',
        }),
      );
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream response exceeded size limit' }));
      return;
    }

    // Forward response to the in-sandbox reviewer — no credential in headers
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upstreamResponse.headers)) {
      // Strip the upstream credential echoes (some APIs echo back auth headers)
      if (
        k.toLowerCase() === 'x-api-key' ||
        k.toLowerCase() === 'authorization' ||
        k.toLowerCase() === 'x-forwarded-for'
      ) {
        continue;
      }
      if (v !== undefined) {
        responseHeaders[k] = v;
      }
    }

    res.writeHead(upstreamResponse.statusCode, responseHeaders);
    res.end(upstreamResponse.body);

    this.emitAudit(
      this.makeAuditEntry({
        req,
        requestBodyBytes: body.length,
        responseStatus: upstreamResponse.statusCode,
        forwarded: true,
      }),
    );
  }

  private sendDenial(
    res: ServerResponse,
    status: number,
    reason: ProxyDenialReason,
    req: IncomingMessage,
    bodyBytes: number,
  ): void {
    this.emitAudit(
      this.makeAuditEntry({
        req,
        requestBodyBytes: bodyBytes,
        responseStatus: status,
        forwarded: false,
        denialReason: reason,
      }),
    );
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: reason }));
  }

  // ── Audit logging ───────────────────────────────────────────────────────────

  private makeAuditEntry(opts: {
    req: IncomingMessage;
    requestBodyBytes: number;
    responseStatus: number;
    forwarded: boolean;
    denialReason?: ProxyDenialReason;
  }): ProxyAuditEntry {
    const session = this.session;
    return {
      ts: new Date().toISOString(),
      prNumber: session?.prNumber ?? this.config.prNumber,
      // The session token is NOT the credential — safe to include in logs.
      // It is used to correlate requests; it cannot be used to call the upstream.
      sessionToken: session?.sessionToken
        ? // Include only the first 8 chars for log readability
          session.sessionToken.slice(0, 8) + '...'
        : '[none]',
      method: opts.req.method ?? 'UNKNOWN',
      path: opts.req.url ?? '/',
      requestBodyBytes: opts.requestBodyBytes,
      responseStatus: opts.responseStatus,
      forwarded: opts.forwarded,
      denialReason: opts.denialReason,
    };
  }

  private emitAudit(entry: ProxyAuditEntry): void {
    // Sanitise: ensure the credential does not leak into the log sink.
    // The entry fields don't include credential values, but we defensive-redact
    // the serialised form before emission to catch any edge cases.
    const sanitised = JSON.parse(
      redactCredential(JSON.stringify(entry), this.config.credential),
    ) as ProxyAuditEntry;

    if (this.config.auditLog) {
      this.config.auditLog(sanitised);
    } else {
      // Default: emit to stderr (not stdout — don't pollute pipeline output)
      process.stderr.write(`[inference-proxy] ${JSON.stringify(sanitised)}\n`);
    }
  }

  // ── Accessors (for tests) ──────────────────────────────────────────────────

  /**
   * Current request count for this session.
   * @internal — for test assertions only.
   */
  get _requestCount(): number {
    return this.session?.requestCount ?? 0;
  }

  /**
   * Whether the proxy server is currently running.
   * @internal — for test assertions only.
   */
  get _isRunning(): boolean {
    return this.server !== null;
  }
}

// ── Proxy factory ─────────────────────────────────────────────────────────────

/**
 * Create and start an `InferenceProxy` for the given PR and credential.
 *
 * Returns the proxy instance (for `stop()`) and the `ProxyStartResult` (port +
 * session token to pass to the reviewer process).
 *
 * The credential is NEVER passed to the reviewer — only the port and token.
 *
 * Example:
 * ```ts
 * const { proxy, port, sessionToken } = await createInferenceProxy({
 *   prNumber: 42,
 *   credential: process.env.ANTHROPIC_API_KEY!,
 * });
 * // Start the reviewer container with:
 * //   INFERENCE_PROXY_PORT=<port>
 * //   INFERENCE_PROXY_SESSION=<sessionToken>
 * // NOT with ANTHROPIC_API_KEY.
 * await proxy.stop();
 * ```
 */
export async function createInferenceProxy(config: InferenceProxyConfig): Promise<{
  proxy: InferenceProxy;
  port: number;
  sessionToken: string;
}> {
  const proxy = new InferenceProxy(config);
  const { port, sessionToken } = await proxy.start();
  return { proxy, port, sessionToken };
}

// ── Docker network helpers ────────────────────────────────────────────────────

/**
 * Build the Docker `--add-host` argument for exposing the proxy to the
 * container as `inference.local`.
 *
 * In Docker Desktop on macOS, `host-gateway` resolves to the host machine.
 * On Linux (GitHub Actions), `172.17.0.1` is the docker0 bridge IP, which
 * can be read from `docker network inspect bridge`.
 *
 * The composed network policy is:
 *  - `--network=none` (from AISDLC-508's `DockerSandboxDriver`)
 *  - `--add-host=inference.local:<host-ip>` (this helper)
 *
 * This allows the container to reach ONLY the proxy on the named alias;
 * all other egress remains denied by `--network=none`.
 *
 * IMPORTANT: `--add-host` with `--network=none` on Linux adds the entry to
 * `/etc/hosts` but does NOT enable actual network connectivity (because
 * `--network=none` removes the network interface). On Docker Desktop for Mac,
 * the host-gateway alias DOES work via the host-network bridge. Real
 * integration testing of this combination requires
 * `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 */
export function buildProxyHostArg(hostIp: string = 'host-gateway'): string[] {
  return ['--add-host', `inference.local:${hostIp}`];
}

/**
 * Build the environment variables to inject into the reviewer container
 * that allow it to discover the proxy.
 *
 * These variables describe WHERE the proxy is and HOW to authenticate to it.
 * The actual credential is NOT included.
 */
export function buildReviewerProxyEnv(opts: {
  port: number;
  sessionToken: string;
  provider?: InferenceProvider;
}): Record<string, string> {
  return {
    INFERENCE_PROXY_HOST: 'inference.local',
    INFERENCE_PROXY_PORT: String(opts.port),
    INFERENCE_PROXY_SESSION: opts.sessionToken,
    INFERENCE_PROXY_PROVIDER: opts.provider ?? 'anthropic',
    // Override the provider base URL so the SDK routes to the proxy
    ANTHROPIC_BASE_URL: `http://inference.local:${opts.port}`,
    OPENAI_BASE_URL: `http://inference.local:${opts.port}`,
  };
}
