/**
 * Child-process hygiene shared by the CLI agent runners (AISDLC-1396).
 *
 * - `buildRunnerEnv` gives a spawned agent CLI an allow-listed environment
 *   instead of the orchestrator's whole `process.env`, so a third-party CLI
 *   never receives GitHub tokens or other providers' API keys it does not need.
 * - `TailBuffer` caps how much of the child's output a runner holds in memory,
 *   keeping the tail (where the final result lives) and counting what it drops.
 *
 * Operator guide: docs/operations/adapter-authoring.md, "Runner child process".
 */

/** Comma-separated extra variable names the operator passes through to every runner child. */
export const RUNNER_ENV_PASSTHROUGH_VAR = 'AI_SDLC_RUNNER_ENV_PASSTHROUGH';

/** Byte cap override for each buffered child stream. */
export const RUNNER_OUTPUT_CAP_VAR = 'AI_SDLC_RUNNER_OUTPUT_CAP_BYTES';

/** Default cap per buffered stream: 8 MiB. */
export const DEFAULT_RUNNER_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Variables every child receives when the parent has them: process basics,
 * locale, temp dirs, proxy and CA settings, and the Windows system variables.
 * Compared case-insensitively (Windows env names are case-insensitive).
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMDATA',
];

/** Name prefixes every child receives (`AI_SDLC_*` minus secret-looking names). */
const BASE_ENV_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'AI_SDLC_'];

/** `AI_SDLC_*` names matching this stay with the orchestrator (signing keys, webhook secrets). */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

/** The credential and config variables each runner's own CLI reads. */
export const RUNNER_CREDENTIAL_ENV = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
} as const satisfies Record<string, readonly string[]>;

function parsePassthrough(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Build the environment for a runner's child process: the base allow-list,
 * the runner's own credential variables, and any names listed in
 * `AI_SDLC_RUNNER_ENV_PASSTHROUGH`. Everything else is dropped.
 */
export function buildRunnerEnv(
  credentialVars: readonly string[],
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base = new Set(BASE_ENV_ALLOWLIST);
  const explicit = new Set([
    ...credentialVars,
    ...parsePassthrough(parent[RUNNER_ENV_PASSTHROUGH_VAR]),
  ]);
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const allowed =
      explicit.has(name) ||
      base.has(upper) ||
      BASE_ENV_PREFIXES.some(
        (prefix) => upper.startsWith(prefix) && !(prefix === 'AI_SDLC_' && SECRET_NAME.test(upper)),
      );
    if (allowed) env[name] = value;
  }
  return env;
}

/** Resolve the per-stream output cap from `AI_SDLC_RUNNER_OUTPUT_CAP_BYTES`. */
export function resolveOutputCapBytes(parent: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(parent[RUNNER_OUTPUT_CAP_VAR] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNNER_OUTPUT_CAP_BYTES;
}

/**
 * Holds at most `capBytes` of a child stream, keeping the most recent bytes.
 * Memory stays bounded by the cap regardless of how much the child writes.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Bytes discarded from the front because the stream exceeded the cap. */
  droppedBytes = 0;

  constructor(readonly capBytes: number = resolveOutputCapBytes()) {}

  push(chunk: Buffer): void {
    if (chunk.length >= this.capBytes) {
      this.droppedBytes += this.size + chunk.length - this.capBytes;
      this.chunks = [chunk.subarray(chunk.length - this.capBytes)];
      this.size = this.capBytes;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.capBytes) {
      const head = this.chunks[0];
      const excess = this.size - this.capBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
        this.droppedBytes += head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
        this.droppedBytes += excess;
      }
    }
  }

  /** Bytes currently held (never more than `capBytes`). */
  get heldBytes(): number {
    return this.size;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }
}

/** Human-readable note a runner puts in its result when output was truncated. */
export function truncationNote(droppedBytes: number, capBytes: number): string {
  return `[output truncated: dropped the first ${droppedBytes} bytes, kept the last ${capBytes}]`;
}
