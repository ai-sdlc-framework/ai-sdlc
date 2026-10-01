/**
 * Detached launcher for the usage ingester.
 *
 * Starts `cli-usage ingest` as an unref'd child with ignored stdio and a hard
 * time limit, so the caller is never delayed and a failure to start is
 * swallowed. Used by the orchestrator tick; the plugin hooks carry their own
 * copy of the same contract.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_SECONDS, isIngestSwitchedOff, isRemoteSandbox } from './ingest-claude.js';

export interface LaunchOptions {
  /** Hard time limit handed to the child. */
  maxSeconds?: number;
  /** Bin script to run. Defaults to this package's own `cli-usage.mjs`. */
  binPath?: string;
  env?: NodeJS.ProcessEnv;
}

function defaultBinPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli-usage.mjs');
}

/**
 * Launch ingestion in the background. Returns true when a child was started.
 * Never throws and never waits.
 */
export function launchUsageIngestDetached(opts: LaunchOptions = {}): boolean {
  try {
    const env = opts.env ?? process.env;
    if (isRemoteSandbox(env) || isIngestSwitchedOff(env)) return false;
    const bin = opts.binPath ?? defaultBinPath();
    if (!existsSync(bin)) return false;
    const child = spawn(
      process.execPath,
      [bin, 'ingest', '--max-seconds', String(opts.maxSeconds ?? DEFAULT_MAX_SECONDS)],
      { detached: true, stdio: 'ignore', env },
    );
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
