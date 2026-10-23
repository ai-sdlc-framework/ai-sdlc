/**
 * Shared types for the operator TUI data sources (RFC-0023 Phase 2 /
 * AISDLC-178.2).
 *
 * Each source module exposes a pure fetcher (for unit tests) and a React
 * hook that wraps the fetcher with a `useEffect`-driven poll loop. The
 * hook return shape is uniform so consumer panes (Phases 3-6) can render
 * a banner whenever `error` is non-null per RFC §12 graceful-degradation.
 */

import { join } from 'node:path';

/**
 * Distinguished error kinds the data sources surface to consumer panes.
 * Per RFC §12 a missing / unreadable / un-parseable source MUST NOT crash
 * the TUI; the hook returns the sentinel so the pane can render a banner
 * instead. Adding new variants is a non-breaking change for consumers
 * that switch on the union exhaustively.
 */
export type SourceErrorKind =
  'source-unavailable' | 'source-permission-denied' | 'source-corrupt' | 'source-timeout';

/**
 * Uniform return shape for every TUI data-source hook. `data` is the
 * parsed payload (shape depends on the source); `error` is non-null when
 * the source is unavailable / unreadable / partly corrupt; `lastFetched`
 * is the wall-clock timestamp of the most-recent successful refresh
 * (null on cold start).
 */
export interface SourceState<T> {
  data: T;
  error: SourceErrorKind | null;
  lastFetched: Date | null;
}

/**
 * Resolve the artifacts directory the TUI sources read from. Mirrors
 * the convention `pipeline-cli/src/orchestrator/events.ts` and the
 * `cli-deps snapshot` writer use: explicit override > $ARTIFACTS_DIR >
 * `<workDir>/artifacts`. Exported so every source module shares one
 * resolution rule.
 */
export function resolveArtifactsDir(
  opts: { artifactsDir?: string; workDir?: string } = {},
): string {
  if (opts.artifactsDir) return opts.artifactsDir;
  if (process.env.ARTIFACTS_DIR) return process.env.ARTIFACTS_DIR;
  const workDir = opts.workDir ?? process.cwd();
  return join(workDir, 'artifacts');
}

/**
 * Map a Node.js fs error code to a SourceErrorKind. Centralised so every
 * source module classifies ENOENT / EACCES / EPERM identically.
 */
export function classifyFsError(err: unknown): SourceErrorKind {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return 'source-unavailable';
    if (code === 'EACCES' || code === 'EPERM') return 'source-permission-denied';
  }
  return 'source-unavailable';
}
