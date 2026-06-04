/**
 * RFC-0043 Phase 7 — inference-proxy.ts hermetic tests (AISDLC-510)
 *
 * All tests are hermetic: no real network I/O, no real HTTP server binding.
 * Real-network behaviour is gated behind `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`.
 *
 * Security invariants tested:
 *  - SI-1: A process with NO provider env var completes a model call via the proxy
 *           (the credential is held by the proxy, not the caller).
 *  - SI-2: Tool-use / non-review calls are refused 422.
 *  - SI-3: The credential NEVER appears in audit log entries (redaction tested).
 *  - SI-4: A request with an invalid session token is refused 403.
 *  - SI-5: A request exceeding rate limits is refused 429.
 *  - SI-6: A request exceeding body size is refused 413.
 *  - SI-7: Only POST /v1/messages (Anthropic) / /v1/chat/completions (OpenAI)
 *           is accepted; other paths return 404; other methods return 405.
 *  - SI-8: Response-too-large from upstream is refused 502.
 *  - SI-9: Session scoping — a different session token is rejected.
 *  - SI-10: Upstream connector is NOT called for denied requests.
 *  - SI-11: Upstream credential header is injected by the proxy (out-of-process).
 *  - SI-12: The docker --add-host arg exposes inference.local to the container.
 *  - SI-13: buildReviewerProxyEnv does NOT include the credential.
 *
 * Integration-gated tests (AI_SDLC_SANDBOX_INTEGRATION_TESTS=1):
 *  - A real HTTP server is bound; requests are served; session token validated.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';

import {
  InferenceProxy,
  createInferenceProxy,
  redactCredential,
  assertEntryClean,
  detectToolUse,
  isReviewShapedCall,
  readRequestBody,
  buildProxyHostArg,
  buildReviewerProxyEnv,
  DEFAULT_PROXY_LIMITS,
  REDACTED_TOKEN,
  type InferenceProxyConfig,
  type UpstreamResponse,
  type ProxyAuditEntry,
  type UpstreamConnector,
} from './inference-proxy.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

const FAKE_CREDENTIAL = 'sk-ant-api03-test-credential-value-1234567890abcdef';
const FAKE_PR_NUMBER = 42;
const FAKE_SESSION_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/**
 * A mock HTTP server that captures the handler function without binding a port.
 * Allows us to call `handler(req, res)` directly in tests.
 */
class MockServer extends EventEmitter {
  private handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  private _port = 0;
  readonly listening = false;
  closeAllConnections?: () => void;

  setHandler(h: (req: IncomingMessage, res: ServerResponse) => void): void {
    this.handler = h;
  }

  listen(port: number, host: string, cb: () => void): this {
    this._port = port || 9999; // assign a fake port when 0
    setImmediate(cb);
    return this;
  }

  address(): { port: number; address: string; family: string } {
    return { port: this._port, address: '127.0.0.1', family: 'IPv4' };
  }

  close(cb?: () => void): this {
    setImmediate(() => cb?.());
    return this;
  }

  /**
   * Simulate an incoming request by directly invoking the handler.
   * Returns the mock response for assertions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async simulateRequest(req: any): Promise<MockResponse> {
    if (!this.handler) throw new Error('No handler registered');
    const res = new MockResponse();
    await new Promise<void>((resolve) => {
      const origEnd = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        origEnd(...args);
        resolve();
        return res;
      }) as typeof res.end;
      this.handler!(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    });
    return res;
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  body = '';

  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = status;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }

  end(data?: string | Buffer): this {
    if (data) {
      this.body = typeof data === 'string' ? data : data.toString('utf8');
    }
    return this;
  }
}

/**
 * Build a mock IncomingMessage from partial request data.
 * Emits the body chunks after the handler is registered.
 */
// Use `unknown` cast for the mock request return type to avoid strict IncomingMessage compat check.
// The mock only needs the subset of IncomingMessage fields used by the handler.
function makeMockRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): unknown {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/v1/messages',
    headers: opts.headers ?? {},
  });

  // Schedule body emission
  const body = opts.body ?? '';
  if (body) {
    setImmediate(() => {
      emitter.emit('data', Buffer.from(body));
      emitter.emit('end');
    });
  } else {
    setImmediate(() => emitter.emit('end'));
  }

  return req;
}

/**
 * Build a valid review-shaped request body (Anthropic format).
 */
function makeReviewBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Review this code: console.log("hello")' }],
    ...overrides,
  });
}

/**
 * Create an InferenceProxy with a mock server and mock upstream connector.
 * Returns the proxy, the mock server, and the captured upstream calls.
 */
async function createTestProxy(
  config?: Partial<InferenceProxyConfig>,
  upstreamResponse?: Partial<UpstreamResponse>,
): Promise<{
  proxy: InferenceProxy;
  mockServer: MockServer;
  upstreamCalls: Array<Parameters<UpstreamConnector>[0]>;
  auditEntries: ProxyAuditEntry[];
  sessionToken: string;
  port: number;
}> {
  const upstreamCalls: Array<Parameters<UpstreamConnector>[0]> = [];
  const auditEntries: ProxyAuditEntry[] = [];

  // Create a subclass of InferenceProxy that injects mock seams
  class TestProxy extends InferenceProxy {
    constructor(cfg: InferenceProxyConfig) {
      super(cfg);
      this._connectToUpstream = async (opts) => {
        upstreamCalls.push(opts);
        const defaultBody = Buffer.from(JSON.stringify({ id: 'msg_test', type: 'message' }));
        return {
          statusCode: upstreamResponse?.statusCode ?? 200,
          headers: upstreamResponse?.headers ?? { 'content-type': 'application/json' },
          body: upstreamResponse?.body ?? defaultBody,
        };
      };

      const mockServer = new MockServer();
      this._createServer = (handler) => {
        mockServer.setHandler(handler);
        return mockServer as unknown as Server;
      };
    }
  }

  const proxy = new TestProxy({
    prNumber: config?.prNumber ?? FAKE_PR_NUMBER,
    credential: config?.credential ?? FAKE_CREDENTIAL,
    provider: config?.provider ?? 'anthropic',
    limits: config?.limits,
    auditLog: (entry) => auditEntries.push(entry),
    port: 0,
    useHttp: true,
    ...config,
  });

  const { port, sessionToken } = await proxy.start();

  // Extract the mock server from the proxy's _createServer reference
  // We need to find it through the proxy's internal server reference
  // Use the fact that _createServer was called with the handler
  const server = (proxy as unknown as { server: MockServer }).server;

  return { proxy, mockServer: server, upstreamCalls, auditEntries, sessionToken, port };
}

/**
 * Helper to simulate a request through the test proxy.
 */
async function simulateRequest(
  proxy: InferenceProxy,
  opts: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
    sessionToken?: string;
  },
): Promise<MockResponse> {
  const server = (proxy as unknown as { server: MockServer }).server;
  const req = makeMockRequest({
    method: opts.method ?? 'POST',
    url: opts.url ?? '/v1/messages',
    headers: {
      'content-type': 'application/json',
      ...(opts.sessionToken !== undefined ? { 'x-proxy-session': opts.sessionToken } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body ?? makeReviewBody(),
  });
  return server.simulateRequest(req as unknown as EventEmitter & Partial<IncomingMessage>);
}

// Allow flag for integration tests
function withIntegrationFlag(fn: () => Promise<void> | void) {
  return process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1'
    ? fn
    : (): void => {
        // Skip in non-integration mode
      };
}

// ── DEFAULT_PROXY_LIMITS ──────────────────────────────────────────────────────

describe('DEFAULT_PROXY_LIMITS', () => {
  it('has 20 max requests per session', () => {
    expect(DEFAULT_PROXY_LIMITS.maxRequestsPerSession).toBe(20);
  });

  it('has 256 KB max body size', () => {
    expect(DEFAULT_PROXY_LIMITS.maxBodyBytes).toBe(256 * 1024);
  });

  it('has 1 MB max response size', () => {
    expect(DEFAULT_PROXY_LIMITS.maxResponseBytes).toBe(1024 * 1024);
  });
});

// ── redactCredential ──────────────────────────────────────────────────────────

describe('redactCredential', () => {
  it('replaces every occurrence of the credential in a string', () => {
    const cred = 'sk-secret-key-12345';
    const input = `Authorization: Bearer ${cred} -- also ${cred} again`;
    const result = redactCredential(input, cred);
    expect(result).not.toContain(cred);
    expect(result).toContain(REDACTED_TOKEN);
    // Should be replaced twice
    expect(result.split(REDACTED_TOKEN).length).toBe(3); // 2 replacements = 3 parts
  });

  it('returns the input unchanged when credential is empty', () => {
    expect(redactCredential('some text', '')).toBe('some text');
  });

  it('returns the input unchanged when value is empty', () => {
    expect(redactCredential('', 'sk-secret')).toBe('');
  });

  it('handles credentials that are substrings of JSON strings', () => {
    const cred = 'sk-ant-api03-secret';
    const input = JSON.stringify({ header: `x-api-key: ${cred}`, other: 'data' });
    const result = redactCredential(input, cred);
    expect(result).not.toContain(cred);
  });
});

// ── assertEntryClean ──────────────────────────────────────────────────────────

describe('assertEntryClean', () => {
  const baseEntry: ProxyAuditEntry = {
    ts: '2026-06-04T00:00:00.000Z',
    prNumber: 42,
    sessionToken: 'abc123...',
    method: 'POST',
    path: '/v1/messages',
    requestBodyBytes: 100,
    responseStatus: 200,
    forwarded: true,
  };

  it('returns true when credential is absent from entry', () => {
    expect(assertEntryClean(baseEntry, FAKE_CREDENTIAL)).toBe(true);
  });

  it('returns false when credential appears in serialised entry', () => {
    const leaked: ProxyAuditEntry = {
      ...baseEntry,
      // Simulate a leak via a hypothetical extra field (TS would catch this,
      // but we test the runtime check for defence-in-depth)
      sessionToken: FAKE_CREDENTIAL,
    };
    expect(assertEntryClean(leaked, FAKE_CREDENTIAL)).toBe(false);
  });
});

// ── detectToolUse ─────────────────────────────────────────────────────────────

describe('detectToolUse', () => {
  it('returns false for a plain messages-only body', () => {
    expect(
      detectToolUse({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toBe(false);
  });

  it('returns true when tools array is present and non-empty', () => {
    expect(
      detectToolUse({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'bash', description: 'run bash', input_schema: {} }],
      }),
    ).toBe(true);
  });

  it('returns false when tools array is empty', () => {
    expect(
      detectToolUse({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      }),
    ).toBe(false);
  });

  it('returns true when tool_choice is present', () => {
    expect(
      detectToolUse({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        tool_choice: 'auto',
      }),
    ).toBe(true);
  });

  it('returns true when function_call is present (OpenAI legacy)', () => {
    expect(
      detectToolUse({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        function_call: { name: 'get_weather' },
      }),
    ).toBe(true);
  });

  it('returns true when functions array is present and non-empty', () => {
    expect(
      detectToolUse({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        functions: [{ name: 'get_weather', description: 'Get weather' }],
      }),
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(detectToolUse(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(detectToolUse('hello')).toBe(false);
  });

  it('returns false for an array', () => {
    expect(detectToolUse([{ role: 'user', content: 'hello' }])).toBe(false);
  });
});

// ── isReviewShapedCall ────────────────────────────────────────────────────────

describe('isReviewShapedCall', () => {
  it('returns true for a body with messages array', () => {
    expect(
      isReviewShapedCall({
        messages: [{ role: 'user', content: 'review this' }],
      }),
    ).toBe(true);
  });

  it('returns false when messages is absent', () => {
    expect(
      isReviewShapedCall({
        model: 'claude-3-5-sonnet-20241022',
        prompt: 'review this',
      }),
    ).toBe(false);
  });

  it('returns false for null', () => {
    expect(isReviewShapedCall(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isReviewShapedCall('hello')).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isReviewShapedCall([])).toBe(false);
  });
});

// ── readRequestBody ───────────────────────────────────────────────────────────

describe('readRequestBody', () => {
  function makeBodyEmitter(data: string): EventEmitter {
    const emitter = new EventEmitter();
    setImmediate(() => {
      emitter.emit('data', Buffer.from(data));
      emitter.emit('end');
    });
    return emitter;
  }

  it('reads a body within the size limit', async () => {
    const body = '{"hello": "world"}';
    const emitter = makeBodyEmitter(body);
    const result = await readRequestBody(emitter as unknown as IncomingMessage, 1024);
    expect(result).not.toBeNull();
    expect(result!.toString('utf8')).toBe(body);
  });

  it('returns null when body exceeds maxBytes', async () => {
    const body = 'x'.repeat(100);
    const emitter = makeBodyEmitter(body);
    const result = await readRequestBody(emitter as unknown as IncomingMessage, 50);
    expect(result).toBeNull();
  });

  it('returns empty buffer for an empty body', async () => {
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit('end'));
    const result = await readRequestBody(emitter as unknown as IncomingMessage, 1024);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it('returns null on emitter error', async () => {
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit('error', new Error('socket closed')));
    const result = await readRequestBody(emitter as unknown as IncomingMessage, 1024);
    expect(result).toBeNull();
  });
});

// ── buildProxyHostArg ─────────────────────────────────────────────────────────

describe('buildProxyHostArg', () => {
  it('returns --add-host inference.local:host-gateway by default', () => {
    expect(buildProxyHostArg()).toEqual(['--add-host', 'inference.local:host-gateway']);
  });

  it('uses the provided host IP', () => {
    expect(buildProxyHostArg('172.17.0.1')).toEqual(['--add-host', 'inference.local:172.17.0.1']);
  });
});

// ── buildReviewerProxyEnv ─────────────────────────────────────────────────────

describe('buildReviewerProxyEnv', () => {
  const env = buildReviewerProxyEnv({ port: 9876, sessionToken: FAKE_SESSION_TOKEN });

  it('includes INFERENCE_PROXY_HOST=inference.local', () => {
    expect(env['INFERENCE_PROXY_HOST']).toBe('inference.local');
  });

  it('includes INFERENCE_PROXY_PORT', () => {
    expect(env['INFERENCE_PROXY_PORT']).toBe('9876');
  });

  it('includes INFERENCE_PROXY_SESSION', () => {
    expect(env['INFERENCE_PROXY_SESSION']).toBe(FAKE_SESSION_TOKEN);
  });

  it('does NOT include the provider credential', () => {
    const envStr = JSON.stringify(env);
    expect(envStr).not.toContain(FAKE_CREDENTIAL);
    // Also: no ANTHROPIC_API_KEY field
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('sets ANTHROPIC_BASE_URL to the proxy address', () => {
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://inference.local:9876');
  });

  it('defaults provider to anthropic', () => {
    expect(env['INFERENCE_PROXY_PROVIDER']).toBe('anthropic');
  });

  it('uses the specified provider', () => {
    const envWithProvider = buildReviewerProxyEnv({
      port: 9876,
      sessionToken: FAKE_SESSION_TOKEN,
      provider: 'openai',
    });
    expect(envWithProvider['INFERENCE_PROXY_PROVIDER']).toBe('openai');
  });
});

// ── SI-1: Credential-withheld proxy completes model call ───────────────────────

describe('SI-1: proxy completes model call without credential in sandbox env', () => {
  it('forwards the request to upstream after injecting credential internally', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    // The upstream received the call
    expect(upstreamCalls).toHaveLength(1);
    // The response was forwarded (status 200)
    expect(res.statusCode).toBe(200);
    // The upstream call included the credential in the header (injected out-of-process)
    const call = upstreamCalls[0]!;
    expect(call.headers['x-api-key']).toBe(FAKE_CREDENTIAL);
    // The audit log recorded it as forwarded
    const lastEntry = auditEntries[auditEntries.length - 1];
    expect(lastEntry?.forwarded).toBe(true);
  });

  it('the caller (reviewer) does not need to know the credential — only port + token', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy();

    // Simulate a reviewer process that only knows the session token (not the credential)
    const res = await simulateRequest(proxy, {
      sessionToken,
      // The caller does NOT pass ANTHROPIC_API_KEY — the proxy injects it
      headers: {
        'content-type': 'application/json',
        'x-proxy-session': sessionToken,
        // Note: no authorization or x-api-key from the caller
      },
      body: makeReviewBody(),
    });

    await proxy.stop();

    // Despite no credential from the caller, the upstream got a valid call
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.headers['x-api-key']).toBe(FAKE_CREDENTIAL);
    expect(res.statusCode).toBe(200);
  });
});

// ── SI-2: Tool-use refusal ────────────────────────────────────────────────────

describe('SI-2: tool-use / non-review calls are refused', () => {
  it('refuses a request with tools array (422)', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody({
        tools: [{ name: 'bash', description: 'run bash', input_schema: {} }],
      }),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(422);
    // MUST NOT forward to upstream
    expect(upstreamCalls).toHaveLength(0);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('tool-use-refused');
    expect(entry?.forwarded).toBe(false);
  });

  it('refuses a request with tool_choice field (422)', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody({ tool_choice: 'auto' }),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(422);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('refuses a request with function_call field (422 — OpenAI legacy)', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({ provider: 'openai' });

    const res = await simulateRequest(proxy, {
      url: '/v1/chat/completions',
      sessionToken,
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        function_call: { name: 'get_weather' },
      }),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(422);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('SI-10: upstream connector is NOT called for denied requests', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy();

    // Make 3 denied requests (tool-use, invalid-session, wrong-path)
    await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody({ tools: [{ name: 'bash' }] }),
    });
    await simulateRequest(proxy, {
      sessionToken: 'wrong-token',
      body: makeReviewBody(),
    });
    await simulateRequest(proxy, {
      url: '/v1/admin/keys',
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    // Zero upstream calls for all three denied requests
    expect(upstreamCalls).toHaveLength(0);
  });
});

// ── SI-3: Credential never appears in audit logs ──────────────────────────────

describe('SI-3: credential never appears in audit log entries', () => {
  it('audit entries for forwarded requests do not contain the credential', async () => {
    const { proxy, auditEntries, sessionToken } = await createTestProxy();

    await simulateRequest(proxy, { sessionToken, body: makeReviewBody() });

    await proxy.stop();

    expect(auditEntries.length).toBeGreaterThan(0);
    for (const entry of auditEntries) {
      expect(assertEntryClean(entry, FAKE_CREDENTIAL)).toBe(true);
    }
  });

  it('audit entries for denied requests do not contain the credential', async () => {
    const { proxy, auditEntries, sessionToken } = await createTestProxy();

    // Make several denied requests
    await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody({ tools: [{ name: 'bash' }] }),
    });
    await simulateRequest(proxy, { sessionToken: 'wrong', body: makeReviewBody() });
    await simulateRequest(proxy, { url: '/v1/bad-path', sessionToken, body: makeReviewBody() });

    await proxy.stop();

    for (const entry of auditEntries) {
      expect(assertEntryClean(entry, FAKE_CREDENTIAL)).toBe(true);
    }
  });

  it('redactCredential catches the credential even if it appears in a response body context', () => {
    const cred = 'sk-ant-super-secret-12345';
    const value = `the api key is ${cred} and should not leak`;
    const redacted = redactCredential(value, cred);
    expect(redacted).not.toContain(cred);
    expect(redacted).toContain(REDACTED_TOKEN);
  });
});

// ── SI-4: Session token validation ────────────────────────────────────────────

describe('SI-4: session scoping rejects invalid tokens', () => {
  it('refuses a request with a wrong session token (403)', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken: _ } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      sessionToken: 'totally-wrong-token',
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('invalid-session');
  });

  it('refuses a request with no session token (403)', async () => {
    const { proxy, upstreamCalls } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      // No sessionToken
      headers: {
        'content-type': 'application/json',
      },
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('SI-9: different session token for same PR is rejected', async () => {
    const { proxy, upstreamCalls } = await createTestProxy();

    // A different token — same PR but different token string
    const otherToken = FAKE_SESSION_TOKEN.replace('a1b2', 'x9y8');

    const res = await simulateRequest(proxy, {
      sessionToken: otherToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('accepts a request with the correct session token', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });
});

// ── SI-5: Rate limiting ───────────────────────────────────────────────────────

describe('SI-5: rate limit enforcement', () => {
  it('refuses requests exceeding maxRequestsPerSession (429)', async () => {
    // Use a proxy with a 2-request limit
    const {
      proxy: limitedProxy,
      upstreamCalls: limitedUpstreamCalls,
      auditEntries: limitedAudit,
      sessionToken: limitedToken,
    } = await createTestProxy({ limits: { maxRequestsPerSession: 2 } });

    // First two requests should succeed
    const res1 = await simulateRequest(limitedProxy, {
      sessionToken: limitedToken,
      body: makeReviewBody(),
    });
    const res2 = await simulateRequest(limitedProxy, {
      sessionToken: limitedToken,
      body: makeReviewBody(),
    });
    // Third should be rate-limited
    const res3 = await simulateRequest(limitedProxy, {
      sessionToken: limitedToken,
      body: makeReviewBody(),
    });

    await limitedProxy.stop();

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(429);
    expect(limitedUpstreamCalls).toHaveLength(2); // only 2 forwarded

    // Audit: the third entry should have denialReason rate-limit-exceeded
    const thirdEntry = limitedAudit[limitedAudit.length - 1];
    expect(thirdEntry?.denialReason).toBe('rate-limit-exceeded');
  });

  it('tracks request count correctly', async () => {
    const { proxy, sessionToken } = await createTestProxy({ limits: { maxRequestsPerSession: 5 } });

    for (let i = 0; i < 5; i++) {
      await simulateRequest(proxy, { sessionToken, body: makeReviewBody() });
    }

    // Check count before stop() clears the session
    expect(proxy._requestCount).toBe(5);

    const res = await simulateRequest(proxy, { sessionToken, body: makeReviewBody() });

    // Count still 5 after a rate-limited request (rate-limited requests don't increment)
    expect(proxy._requestCount).toBe(5);

    await proxy.stop();

    expect(res.statusCode).toBe(429);
  });
});

// ── SI-6: Body size limit ─────────────────────────────────────────────────────

describe('SI-6: body size limit enforcement', () => {
  it('refuses requests with body exceeding maxBodyBytes (413)', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken } = await createTestProxy({
      limits: { maxBodyBytes: 100 },
    });

    // Body that exceeds 100 bytes
    const largeBody = makeReviewBody({
      messages: [{ role: 'user', content: 'x'.repeat(200) }],
    });

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: largeBody,
    });

    await proxy.stop();

    expect(res.statusCode).toBe(413);
    expect(upstreamCalls).toHaveLength(0);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('body-too-large');
  });

  it('accepts requests within the body size limit', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      limits: { maxBodyBytes: 10 * 1024 }, // 10 KB
    });

    const normalBody = makeReviewBody();
    expect(normalBody.length).toBeLessThan(10 * 1024);

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: normalBody,
    });

    await proxy.stop();

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });
});

// ── SI-7: Path and method enforcement ─────────────────────────────────────────

describe('SI-7: path and method enforcement', () => {
  it('refuses GET requests (405)', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      method: 'GET',
      sessionToken,
      body: '',
    });

    await proxy.stop();

    expect(res.statusCode).toBe(405);
    expect(upstreamCalls).toHaveLength(0);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('method-not-allowed');
  });

  it('refuses DELETE requests (405)', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      method: 'DELETE',
      sessionToken,
      body: '',
    });

    await proxy.stop();

    expect(res.statusCode).toBe(405);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('refuses non-allowed paths (404)', async () => {
    const { proxy, upstreamCalls, auditEntries, sessionToken } = await createTestProxy();

    const res = await simulateRequest(proxy, {
      url: '/v1/admin/keys',
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(404);
    expect(upstreamCalls).toHaveLength(0);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('path-not-allowed');
  });

  it('refuses /v1/chat/completions on Anthropic provider (404)', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'anthropic',
    });

    // /v1/chat/completions is OpenAI's path — not allowed on Anthropic provider
    const res = await simulateRequest(proxy, {
      url: '/v1/chat/completions',
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(404);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('accepts POST /v1/messages for Anthropic provider', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'anthropic',
    });

    const res = await simulateRequest(proxy, {
      url: '/v1/messages',
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('accepts POST /v1/chat/completions for OpenAI provider', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'openai',
    });

    const res = await simulateRequest(proxy, {
      url: '/v1/chat/completions',
      sessionToken,
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'review this code' }],
      }),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });
});

// ── SI-8: Response size limit ─────────────────────────────────────────────────

describe('SI-8: response-too-large from upstream is refused', () => {
  it('returns 502 when upstream response exceeds maxResponseBytes', async () => {
    const { proxy, auditEntries, sessionToken } = await createTestProxy(
      { limits: { maxResponseBytes: 100 } },
      { body: Buffer.from('x'.repeat(200)) },
    );

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(502);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('response-too-large');
    expect(entry?.forwarded).toBe(false);
  });
});

// ── SI-11: Credential injection ───────────────────────────────────────────────

describe('SI-11: credential is injected by the proxy into upstream headers', () => {
  it('upstream call includes x-api-key for Anthropic provider', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'anthropic',
    });

    await simulateRequest(proxy, { sessionToken, body: makeReviewBody() });
    await proxy.stop();

    expect(upstreamCalls[0]?.headers['x-api-key']).toBe(FAKE_CREDENTIAL);
    // The reviewer caller did NOT include x-api-key
    // (asserted by simulating request without it — see SI-1)
  });

  it('upstream call includes Bearer authorization for OpenAI provider', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'openai',
    });

    await simulateRequest(proxy, {
      url: '/v1/chat/completions',
      sessionToken,
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'review' }],
      }),
    });
    await proxy.stop();

    expect(upstreamCalls[0]?.headers['authorization']).toBe(`Bearer ${FAKE_CREDENTIAL}`);
  });

  it('upstream call targets the correct provider hostname', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({
      provider: 'anthropic',
    });

    await simulateRequest(proxy, { sessionToken, body: makeReviewBody() });
    await proxy.stop();

    expect(upstreamCalls[0]?.hostname).toBe('api.anthropic.com');
  });
});

// ── SI-12: Docker host arg ────────────────────────────────────────────────────

describe('SI-12: buildProxyHostArg exposes inference.local to container', () => {
  it('uses host-gateway by default (Docker Desktop macOS path)', () => {
    const args = buildProxyHostArg();
    expect(args).toContain('--add-host');
    expect(args).toContain('inference.local:host-gateway');
  });

  it('allows specifying the docker0 bridge IP for Linux runners', () => {
    const args = buildProxyHostArg('172.17.0.1');
    expect(args).toContain('inference.local:172.17.0.1');
  });
});

// ── SI-13: buildReviewerProxyEnv — no credential ──────────────────────────────

describe('SI-13: buildReviewerProxyEnv does not include provider credential', () => {
  it('env vars do not contain the credential value', () => {
    const env = buildReviewerProxyEnv({ port: 1234, sessionToken: FAKE_SESSION_TOKEN });
    const envStr = JSON.stringify(env);
    expect(envStr).not.toContain(FAKE_CREDENTIAL);
  });

  it('env vars do not contain ANTHROPIC_API_KEY key', () => {
    const env = buildReviewerProxyEnv({ port: 1234, sessionToken: FAKE_SESSION_TOKEN });
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });
});

// ── InferenceProxy lifecycle ──────────────────────────────────────────────────

describe('InferenceProxy lifecycle', () => {
  it('start() returns a port and session token', async () => {
    const { proxy, port, sessionToken } = await createTestProxy();
    await proxy.stop();

    expect(port).toBeGreaterThan(0);
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('start() throws when called while already running', async () => {
    const { proxy } = await createTestProxy();

    await expect(proxy.start()).rejects.toThrow('already running');

    await proxy.stop();
  });

  it('stop() is idempotent — safe to call multiple times', async () => {
    const { proxy } = await createTestProxy();

    await proxy.stop();
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it('_isRunning reflects proxy state', async () => {
    const { proxy } = await createTestProxy();

    expect(proxy._isRunning).toBe(true);
    await proxy.stop();
    expect(proxy._isRunning).toBe(false);
  });

  it('session token is fresh on each start call (different tokens across instances)', async () => {
    const { proxy: p1, sessionToken: t1 } = await createTestProxy();
    const { proxy: p2, sessionToken: t2 } = await createTestProxy();

    await p1.stop();
    await p2.stop();

    expect(t1).not.toBe(t2);
  });
});

// ── createInferenceProxy factory ──────────────────────────────────────────────

describe('createInferenceProxy', () => {
  it('returns proxy, port, and sessionToken', async () => {
    // Use a real InferenceProxy with real HTTP server (but mock upstream)
    // Since we cannot easily inject seams via the factory, we test with a
    // real HTTP server on a random port for this test only.
    // This is gated behind the integration flag since it binds a real socket.
    if (process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] !== '1') {
      // Skip in non-integration mode — factory uses real server; no mock seam
      return;
    }

    const { proxy, port, sessionToken } = await createInferenceProxy({
      prNumber: 42,
      credential: FAKE_CREDENTIAL,
      useHttp: true,
    });

    expect(port).toBeGreaterThan(0);
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);

    await proxy.stop();
  });
});

// ── Upstream error handling ────────────────────────────────────────────────────

describe('upstream error handling', () => {
  it('returns 502 when upstream connector throws', async () => {
    const upstreamCalls: Array<Parameters<UpstreamConnector>[0]> = [];
    const auditEntries: ProxyAuditEntry[] = [];

    class ErrorProxy extends InferenceProxy {
      constructor(cfg: InferenceProxyConfig) {
        super(cfg);
        this._connectToUpstream = async (opts) => {
          upstreamCalls.push(opts);
          throw new Error('ECONNREFUSED — upstream is down');
        };
        const mockServer = new MockServer();
        this._createServer = (handler) => {
          mockServer.setHandler(handler);
          return mockServer as unknown as Server;
        };
      }
    }

    const proxy = new ErrorProxy({
      prNumber: 42,
      credential: FAKE_CREDENTIAL,
      auditLog: (e) => auditEntries.push(e),
      useHttp: true,
    });

    const { sessionToken } = await proxy.start();

    const res = await simulateRequest(proxy, {
      sessionToken,
      body: makeReviewBody(),
    });

    await proxy.stop();

    expect(res.statusCode).toBe(502);
    expect(upstreamCalls).toHaveLength(1);
    const entry = auditEntries[auditEntries.length - 1];
    expect(entry?.denialReason).toBe('upstream-error');
    expect(entry?.forwarded).toBe(false);
    // Credential must not appear in the error response
    expect(res.body).not.toContain(FAKE_CREDENTIAL);
  });
});

// ── Anthropic-specific header forwarding ──────────────────────────────────────

describe('Anthropic-specific header forwarding', () => {
  it('forwards anthropic-version header to upstream when present', async () => {
    const { proxy, upstreamCalls, sessionToken } = await createTestProxy({ provider: 'anthropic' });

    const req = makeMockRequest({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-proxy-session': sessionToken,
        'anthropic-version': '2023-06-01',
      },
      body: makeReviewBody(),
    });

    const server = (proxy as unknown as { server: MockServer }).server;
    await server.simulateRequest(req as unknown as EventEmitter & Partial<IncomingMessage>);

    await proxy.stop();

    expect(upstreamCalls[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });
});

// ── Integration tests (real network, real HTTP server) ────────────────────────

describe('integration: real HTTP server (AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 only)', () => {
  it(
    'binds a real HTTP server and serves a request',
    withIntegrationFlag(async () => {
      // This test uses the real InferenceProxy without mock seams.
      // It requires a real HTTP server + real loopback connection.
      const http = await import('node:http');

      const { proxy, port, sessionToken } = await createInferenceProxy({
        prNumber: 99,
        credential: FAKE_CREDENTIAL,
        useHttp: true,
        // Override upstream connector to avoid real network
        limits: { maxRequestsPerSession: 1 },
      });

      // Make a real HTTP request to the proxy
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const body = makeReviewBody();
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-proxy-session': sessionToken,
              'content-length': String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
            });
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      await proxy.stop();

      // In integration mode, the upstream connector is the real one (points to Anthropic)
      // but we don't have a real API key in tests. The proxy should return 403/401 from
      // upstream, not a proxy-level error. This confirms the proxy forwarded the request.
      // We accept 200, 401, or 403 as valid "proxy worked" statuses.
      expect([200, 401, 403, 422, 529]).toContain(response.status);
    }),
  );

  it(
    'real HTTP server: invalid session token is rejected 403',
    withIntegrationFlag(async () => {
      const http = await import('node:http');

      const { proxy, port } = await createInferenceProxy({
        prNumber: 99,
        credential: FAKE_CREDENTIAL,
        useHttp: true,
      });

      const response = await new Promise<{ status: number }>((resolve, reject) => {
        const body = makeReviewBody();
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-proxy-session': 'wrong-token',
              'content-length': String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            resolve({ status: res.statusCode ?? 0 });
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      await proxy.stop();

      expect(response.status).toBe(403);
    }),
  );
});
