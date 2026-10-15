/**
 * Real `Synthesizer`: shells out to `claude -p --model <alias>` (AISDLC-729).
 * Subscription billed, like the other `claude -p` spawners. The note text goes
 * over stdin only; nothing is logged.
 *
 * @module memory-dream/claude-synthesizer
 */

import { spawn } from 'node:child_process';
import type { SynthesisResult, SynthesisUsage, Synthesizer } from './synthesis.js';

export type ExecFn = (
  cmd: string,
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export const execClaude: ExecFn = (cmd, args, stdin, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`could not start ${cmd}: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`)),
    );
    child.stdin.end(stdin);
  });

interface ClaudeJson {
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parseClaudeOutput(stdout: string, model: string): SynthesisResult {
  let parsed: ClaudeJson;
  try {
    parsed = JSON.parse(stdout) as ClaudeJson;
  } catch {
    throw new Error('claude output was not JSON');
  }
  if (typeof parsed.result !== 'string') throw new Error('claude output has no result text');
  const u = parsed.usage ?? {};
  const usage: SynthesisUsage = {
    model,
    calls: 1,
    inputTokens: num(u.input_tokens),
    cacheWrite5mTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
  };
  return { text: parsed.result, usage };
}

export class ClaudeSynthesizer implements Synthesizer {
  constructor(
    private readonly exec: ExecFn = execClaude,
    private readonly bin: string = process.env.AI_SDLC_CLAUDE_BIN || 'claude',
  ) {}

  async synthesize(prompt: string, model: string): Promise<SynthesisResult> {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const stdout = await this.exec(
      this.bin,
      ['-p', '--model', model, '--output-format', 'json', '--tools', ''],
      prompt,
      env,
    );
    return parseClaudeOutput(stdout, model);
  }
}
