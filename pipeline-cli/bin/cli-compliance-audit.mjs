#!/usr/bin/env node
/**
 * Bin shim for `cli-compliance-audit` (RFC-0022 §9 Phase 4 / AISDLC-325).
 * Forwards to the compiled router in `dist/cli/compliance-audit.js`.
 *
 * Invoke via: node pipeline-cli/bin/cli-compliance-audit.mjs <subcommand> [options]
 * NEVER via: pnpm --filter @ai-sdlc/pipeline-cli exec cli-compliance-audit
 *   (pnpm exec does not resolve workspace own-bins — AISDLC-156)
 */
import { runComplianceAuditCli } from '../dist/cli/compliance-audit.js';

runComplianceAuditCli().catch((err) => {
  process.stderr.write(`[cli-compliance-audit] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
