/**
 * ClaudeCodeAdapter — wraps Claude Code CLI behind the HarnessAdapter contract.
 * Uses the local `claude` CLI in `-p --output-format stream-json` mode, authenticating
 * via whatever credential the CLI is logged into (Pro/Max subscription or API key).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { probeVersion } from '../version-probe.js';
import type {
  HarnessAdapter,
  HarnessAvailability,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInput,
  HarnessName,
  HarnessRequires,
  HarnessResult,
  HarnessResultStatus,
} from '../types.js';

const DEFAULT_AVAILABLE_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
];

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ClaudeCodeAdapterDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the actual invocation path; tests inject a stub. */
  invoke?: (input: HarnessInput, onEvent?: (e: HarnessEvent) => void) => Promise<HarnessResult>;
  /** Override version probe for tests. */
  probe?: () => Promise<HarnessAvailability>;
  /** Override the spawn function (tests inject a fake child process). */
  spawn?: typeof spawn;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name: HarnessName = 'claude-code';

  readonly capabilities: HarnessCapabilities = {
    freshContext: true,
    customTools: true,
    streaming: true,
    worktreeAwareCwd: true,
    skills: true,
    artifactWrites: true,
    maxContextTokens: 1_000_000,
  };

  readonly requires: HarnessRequires = {
    binary: 'claude',
    versionRange: '>=2.0.0',
    versionProbe: {
      args: ['--version'],
      parse: (stdout) => stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? '',
    },
  };

  private cachedAvailability: HarnessAvailability | null = null;

  constructor(private readonly deps: ClaudeCodeAdapterDeps = {}) {}

  async getAccountId(): Promise<string | null> {
    const env = this.deps.env ?? process.env;
    const tokenSources = [env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_API_KEY, env.ANTHROPIC_AUTH_TOKEN];
    for (const source of tokenSources) {
      if (source && source.length > 0) {
        return createHash('sha256').update(`claude-code:${source}`).digest('hex').slice(0, 16);
      }
    }
    return null;
  }

  async isAvailable(): Promise<HarnessAvailability> {
    if (this.cachedAvailability) return this.cachedAvailability;
    const result = this.deps.probe ? await this.deps.probe() : await probeVersion(this.requires);
    this.cachedAvailability = result;
    return result;
  }

  async invoke(input: HarnessInput, onEvent?: (e: HarnessEvent) => void): Promise<HarnessResult> {
    if (this.deps.invoke) return this.deps.invoke(input, onEvent);
    return runClaudeCli(input, this.deps.spawn ?? spawn, onEvent);
  }

  async availableModels(): Promise<string[]> {
    return DEFAULT_AVAILABLE_MODELS;
  }
}

function runClaudeCli(
  input: HarnessInput,
  spawnFn: typeof spawn,
  onEvent?: (e: HarnessEvent) => void,
): Promise<HarnessResult> {
  const timeoutMs = parseDurationMs(input.timeout) ?? DEFAULT_TIMEOUT_MS;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', input.model];

  return new Promise((resolve) => {
    const startTs = Date.now();
    onEvent?.({ type: 'started', timestamp: new Date().toISOString() });

    let child: ChildProcess;
    try {
      child = spawnFn('claude', args, {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        timeout: timeoutMs,
      });
    } catch (err) {
      resolve({
        status: 'unavailable',
        exitCode: -1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        artifactPaths: [],
        errorDetail: `failed to spawn 'claude': ${(err as Error).message}`,
      });
      return;
    }

    let resultText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let lineBuf = '';
    const errBuf: Buffer[] = [];

    const heartbeat = setInterval(() => {
      onEvent?.({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        message: `${Math.round((Date.now() - startTs) / 1000)}s elapsed`,
      });
    }, HEARTBEAT_INTERVAL_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf-8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as Record<string, unknown>;
          if (ev.type === 'result') {
            resultText = (ev.result as string) ?? '';
            costUsd = (ev.total_cost_usd as number) ?? 0;
            const modelUsage = ev.modelUsage as Record<string, Record<string, unknown>> | undefined;
            if (modelUsage) {
              const firstModel = Object.keys(modelUsage)[0];
              if (firstModel) {
                const usage = modelUsage[firstModel];
                inputTokens = (usage.inputTokens as number) ?? 0;
                outputTokens = (usage.outputTokens as number) ?? 0;
              }
            }
          }
        } catch {
          // Non-JSON line (claude occasionally emits status text); ignore.
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      errBuf.push(chunk);
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      resolve({
        status: 'unavailable',
        exitCode: -1,
        costUsd,
        inputTokens,
        outputTokens,
        artifactPaths: [],
        errorDetail: `claude spawn error: ${err.message}`,
      });
    });

    child.on('close', (code, signal) => {
      clearInterval(heartbeat);
      const stderr = Buffer.concat(errBuf).toString('utf-8');
      const status: HarnessResultStatus =
        code === 0
          ? 'success'
          : signal === 'SIGTERM' || signal === 'SIGKILL'
            ? 'timeout'
            : 'failure';
      onEvent?.({
        type: 'completed',
        timestamp: new Date().toISOString(),
        status,
      });
      resolve({
        status,
        exitCode: code ?? -1,
        costUsd,
        inputTokens,
        outputTokens,
        artifactPaths: [],
        outputText: resultText,
        errorDetail: status === 'success' ? undefined : stderr.slice(-500) || undefined,
      });
    });

    child.stdin?.write(input.prompt);
    child.stdin?.end();
  });
}

function parseDurationMs(duration: string | undefined): number | null {
  if (!duration) return null;
  const m = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const days = Number.parseInt(m[1] ?? '0', 10);
  const hours = Number.parseInt(m[2] ?? '0', 10);
  const minutes = Number.parseInt(m[3] ?? '0', 10);
  const seconds = Number.parseInt(m[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}
