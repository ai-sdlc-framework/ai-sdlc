#!/usr/bin/env node
/**
 * Bin shim for `cli-dispatch-supervisor` (RFC-0041 §4.5, AISDLC-377.3).
 *
 * Drives the Worker Supervisor daemon — polls the Dispatch Board, spawns
 * `env -u CLAUDECODE claude -p` subprocesses for `claude-p-shell` manifests,
 * sweeps stale heartbeats. Operators run this under launchd/systemd or in
 * a tmux pane (see `docs/operations/dispatch-supervisor-install.md`).
 *
 * Usage:
 *   node pipeline-cli/bin/cli-dispatch-supervisor.mjs start
 *   node pipeline-cli/bin/cli-dispatch-supervisor.mjs status
 *   node pipeline-cli/bin/cli-dispatch-supervisor.mjs stop
 *   node pipeline-cli/bin/cli-dispatch-supervisor.mjs help
 *
 * Compiled entry lives in `dist/cli/dispatch-supervisor.js` after `pnpm build`.
 */
import { runDispatchSupervisorCli } from '../dist/cli/dispatch-supervisor.js';

runDispatchSupervisorCli().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[cli-dispatch-supervisor] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
