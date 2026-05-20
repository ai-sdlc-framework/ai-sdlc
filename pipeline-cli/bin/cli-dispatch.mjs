#!/usr/bin/env node
/**
 * Bin shim for `cli-dispatch` (RFC-0041 §4.4, AISDLC-377.1).
 *
 * Surfaces the Dispatch Board library to shell callers so the
 * `/ai-sdlc orchestrator-tick` and `/ai-sdlc dispatch-worker` slash
 * commands can drive the board from bash.
 *
 * Usage:
 *   node pipeline-cli/bin/cli-dispatch.mjs peek
 *   node pipeline-cli/bin/cli-dispatch.mjs claim --worker-kind in-session-agent
 *   node pipeline-cli/bin/cli-dispatch.mjs collect-verdicts --include-failed
 *   node pipeline-cli/bin/cli-dispatch.mjs help
 *
 * Compiled entry lives in `dist/cli/dispatch.js` after `pnpm build`.
 */
import { runDispatchCli } from '../dist/cli/dispatch.js';

runDispatchCli().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[cli-dispatch] error: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  },
);
