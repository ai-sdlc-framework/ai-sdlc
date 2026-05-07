/**
 * TUI startup banner — telemetry disclosure (RFC-0023 §10 / OQ-8 / AC#4 /
 * AISDLC-178.6).
 *
 * Per OQ-8 the operator MUST see the path the TUI writes telemetry to
 * AND the opt-out env var on every launch. We print to stderr (so it
 * doesn't tangle with Ink's stdout-driven render loop) before the Ink
 * App mounts; the operator scrolls back to read it if they want to.
 *
 * When `AI_SDLC_TUI_TELEMETRY=off` is set we still print a short line
 * noting the writers are disabled — useful for operators verifying their
 * opt-out actually took effect.
 */

import { interactionsPath } from './analytics/paths.js';
import { isTelemetryEnabled, TUI_TELEMETRY_FLAG } from './analytics/feature-flag.js';

export interface BannerOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override the env predicate (tests). */
  isEnabled?: () => boolean;
  /** Inject the writer (tests). Defaults `process.stderr.write`. */
  writer?: (line: string) => void;
}

/**
 * Build the banner text. Exported pure so tests can assert on the
 * exact phrasing without intercepting stderr.
 */
export function buildBanner(opts: BannerOpts = {}): string {
  const enabled = (opts.isEnabled ?? isTelemetryEnabled)();
  const path = interactionsPath(opts.artifactsDir);
  if (enabled) {
    return (
      `[cli-tui] Self-observability events writing to ${path}\n` +
      `[cli-tui] Disable with ${TUI_TELEMETRY_FLAG}=off (RFC-0023 §10 / OQ-8)\n`
    );
  }
  return (
    `[cli-tui] Self-observability disabled via ${TUI_TELEMETRY_FLAG}\n` +
    `[cli-tui] No events written to ${path}\n`
  );
}

/** Print the banner to stderr (default writer). */
export function printBanner(opts: BannerOpts = {}): void {
  const writer =
    opts.writer ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  writer(buildBanner(opts));
}
