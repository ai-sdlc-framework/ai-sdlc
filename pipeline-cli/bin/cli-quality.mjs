#!/usr/bin/env node
/**
 * Bin shim for `cli-quality` (AISDLC-307 / RFC-0025 §13 Phase 6 — OQ-5
 * upstream reporting + OQ-10 vendor-namespace enforcement).
 *
 * Forwards to the compiled CLI router. Compiled entry lives in
 * `dist/cli/quality.js` after `pnpm build`.
 *
 * The CLI provides the operator-initiated upstream reporting surface:
 * given a `framework-bug` capture id, it pre-generates a GitHub issue
 * body (anonymised repro, classifier output, suggested fix, related code
 * paths) and opens the browser to `<repoUrl>/issues/new?title=…&body=…`.
 * The operator reviews and submits manually — no telemetry pipeline.
 *
 * See `pipeline-cli/src/cli/quality.ts` for the full contract and
 * `spec/rfcs/RFC-0025-framework-quality-monitoring.md` §13 OQ-5 for the
 * resolution rationale.
 */
import { runQualityCli } from '../dist/cli/quality.js';

runQualityCli().catch((err) => {
  process.stderr.write(`[cli-quality] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
