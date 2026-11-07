/**
 * Test helper — a `Runner` (see `src/runtime/exec.ts`) that returns
 * deterministic, scripted responses keyed by `command + args`. Lets
 * step unit tests assert on git/gh behaviour without touching the
 * real filesystem or network.
 */

import type { ExecOptions, ExecResult, Runner } from '../runtime/exec.js';

export interface FakeRunnerCall {
  command: string;
  args: string[];
  opts?: ExecOptions;
  /** The argv as received, including leading `git -c k=v` overrides (AISDLC-731). */
  rawArgs?: string[];
}

/** Drop the leading `-c key=value` pairs the trusted push builder prepends (AISDLC-731). */
function stripGitConfigOverrides(command: string, args: string[]): string[] {
  if (command !== 'git' || !args[1]?.startsWith('core.hooksPath=')) return args;
  let i = 0;
  while (args[i] === '-c' && i + 1 < args.length) i += 2;
  return args.slice(i);
}

export interface FakeRunnerHandler {
  match: (command: string, args: string[]) => boolean;
  result: ExecResult | ((args: string[]) => ExecResult);
}

export class FakeRunner {
  public readonly calls: FakeRunnerCall[] = [];
  private handlers: FakeRunnerHandler[] = [];

  on(
    matcher: RegExp | ((command: string, args: string[]) => boolean),
    result: ExecResult | ((args: string[]) => ExecResult),
  ): this {
    const match =
      typeof matcher === 'function'
        ? matcher
        : (command: string, args: string[]) => matcher.test(`${command} ${args.join(' ')}`);
    this.handlers.push({ match, result });
    return this;
  }

  /**
   * Returns the underlying Runner for injection into step functions.
   */
  toRunner(): Runner {
    return async (command, rawArgs, opts) => {
      const args = stripGitConfigOverrides(command, rawArgs);
      this.calls.push({ command, args, opts, rawArgs });
      for (const h of this.handlers) {
        if (h.match(command, args)) {
          const r = typeof h.result === 'function' ? h.result(args) : h.result;
          return r;
        }
      }
      // Default: success with empty stdout
      return { stdout: '', stderr: '', code: 0 };
    };
  }
}

export function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0 };
}

export function fail(stderr = '', code = 1): ExecResult {
  return { stdout: '', stderr, code };
}
