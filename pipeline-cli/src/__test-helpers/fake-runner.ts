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
    return async (command, args, opts) => {
      this.calls.push({ command, args, opts });
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
