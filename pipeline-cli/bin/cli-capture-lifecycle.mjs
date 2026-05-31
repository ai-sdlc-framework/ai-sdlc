#!/usr/bin/env node
/**
 * Bin shim for `cli-capture-lifecycle` (RFC-0024 Refit Phase 6 / AISDLC-278).
 * Forwards to the compiled lifecycle CLI router in `dist/cli/capture-lifecycle.js`.
 */
import { runCaptureLifecycleCli } from '../dist/cli/capture-lifecycle.js';

runCaptureLifecycleCli().catch((err) => {
  process.stderr.write(`[cli-capture-lifecycle] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
