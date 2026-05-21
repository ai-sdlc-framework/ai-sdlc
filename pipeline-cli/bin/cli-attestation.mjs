#!/usr/bin/env node
/**
 * Bin shim for `cli-attestation` (RFC-0042 / AISDLC-383.1 Phase 1).
 *
 * Provides operator surfaces for inspecting and managing transcript files
 * captured by reviewer subagents during the proof-of-execution attestation
 * workflow.
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts
 *
 * Compiled entry lives in `dist/cli/attestation.js` after `pnpm build`.
 *
 * See docs/operations/transcript-management.md for retention + GC runbook.
 */
import { runAttestationCli } from '../dist/cli/attestation.js';

runAttestationCli().catch((err) => {
  process.stderr.write(`[cli-attestation] error: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
