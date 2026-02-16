/**
 * Generic HTTP webhook server using `node:http`.
 * Provider-agnostic with pluggable signature verification and event routing.
 * <!-- Source: PRD Section 9 -->
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

// ── Types ────────────────────────────────────────────────────────────

export interface WebhookProviderConfig {
  /** URL path prefix for this provider (e.g. '/webhooks/github'). */
  path: string;
  /** Verify the incoming request signature. Return true if valid. */
  verifySignature: (headers: Record<string, string | undefined>, body: Buffer) => boolean;
  /** Handle the verified webhook payload. */
  onEvent: (headers: Record<string, string | undefined>, body: unknown) => void;
}

export interface WebhookServerConfig {
  /** Port to listen on. */
  port: number;
  /** Hostname to bind to (defaults to '0.0.0.0'). */
  host?: string;
}

export interface WebhookServer {
  /** Start listening. */
  start(): Promise<void>;
  /** Stop the server. */
  stop(): Promise<void>;
  /** Register a provider. */
  registerProvider(config: WebhookProviderConfig): void;
  /** Number of registered providers. */
  readonly providerCount: number;
  /** The port the server is listening on (may differ from config if 0). */
  readonly port: number;
}

// ── Implementation ───────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}

export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const providers: WebhookProviderConfig[] = [];
  let server: Server | null = null;
  let actualPort = config.port;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';

    // Health check endpoint
    if (path === '/health' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', providers: providers.length }));
      return;
    }

    // Only accept POST for webhook routes
    if (method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Find matching provider
    const provider = providers.find((p) => path.startsWith(p.path));
    if (!provider) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const body = await readBody(req);
    const headers = normalizeHeaders(req.headers);

    // Verify signature
    if (!provider.verifySignature(headers, body)) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    // Parse and dispatch
    try {
      const payload = JSON.parse(body.toString('utf-8'));
      provider.onEvent(headers, payload);
      res.writeHead(200);
      res.end('OK');
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
    }
  };

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handler(req, res).catch(() => {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end('Internal Server Error');
            }
          });
        });
        server.on('error', reject);
        server.listen(config.port, config.host ?? '0.0.0.0', () => {
          const addr = server!.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },

    registerProvider(providerConfig: WebhookProviderConfig): void {
      providers.push(providerConfig);
    },

    get providerCount(): number {
      return providers.length;
    },

    get port(): number {
      return actualPort;
    },
  };
}
