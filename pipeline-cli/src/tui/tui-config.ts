/**
 * `.ai-sdlc/tui-config.yaml` loader — RFC-0023 §15 OQ-9 / AISDLC-178.5 AC#7.
 *
 * Optional file. When absent the TUI uses RFC defaults. When present its
 * fields override the defaults (additive — missing fields fall through).
 *
 * Surface today is the OQ-9 empty-state copy override. Future fields
 * (kanban base URL, custom keymap remaps, etc.) extend this same shape.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

export interface TuiConfig {
  /** Override OQ-9 affirming empty-state copy on the Blockers pane. */
  blockersEmptyState?: string;
  /** Override the backlog.md kanban base URL (RFC §11 / OQ-5). */
  kanbanBaseUrl?: string;
}

/** RFC §15 OQ-9 default. */
export const DEFAULT_BLOCKERS_EMPTY_STATE = '✓ No decisions pending — pipeline self-driving';

export interface LoadTuiConfigOpts {
  /** Project root (used to find `.ai-sdlc/tui-config.yaml`). Defaults `process.cwd()`. */
  workDir?: string;
  /** Inject reader (tests). Throws ENOENT on missing → returns defaults. */
  reader?: (path: string) => string;
}

/**
 * Load the TUI config. Missing file → empty object (defaults apply). A
 * malformed YAML payload is treated as missing (logs a stderr warning so
 * the operator notices). The returned shape is intentionally flat — every
 * field is independently optional.
 */
export function loadTuiConfig(opts: LoadTuiConfigOpts = {}): TuiConfig {
  const workDir = opts.workDir ?? process.cwd();
  const reader = opts.reader ?? ((p: string): string => readFileSync(p, 'utf8'));
  const path = join(workDir, '.ai-sdlc', 'tui-config.yaml');

  let raw: string;
  try {
    raw = reader(path);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return {};
    }
    process.stderr.write(`[cli-tui] could not read ${path}: ${(err as Error)?.message ?? err}\n`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    process.stderr.write(
      `[cli-tui] tui-config.yaml is not valid YAML: ${(err as Error)?.message ?? err}\n`,
    );
    return {};
  }

  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const config: TuiConfig = {};
  if (typeof obj.blockersEmptyState === 'string') {
    config.blockersEmptyState = obj.blockersEmptyState;
  }
  if (typeof obj.kanbanBaseUrl === 'string') {
    config.kanbanBaseUrl = obj.kanbanBaseUrl;
  }
  return config;
}
