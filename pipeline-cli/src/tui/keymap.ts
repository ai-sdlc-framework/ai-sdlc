/**
 * Keymap — single source of truth for footer + help screen
 * (RFC-0023 §7.6 / AISDLC-178.5 AC#3).
 *
 * Footer and help screen both render from this list, so they cannot drift.
 * The router (`modes/router.tsx`) consumes the same `keymap.key` values to
 * dispatch mode switches.
 */
export type ModeId =
  | 'overview'
  | 'blockers'
  | 'prs'
  | 'deps'
  | 'config'
  | 'analytics'
  | 'decisions'
  | 'help';

export interface KeyBinding {
  /** The keystroke (single character or sentinel like 'Esc'). */
  key: string;
  /** Short label shown in the footer. */
  footerLabel: string;
  /** Verbose description shown in the help screen. */
  description: string;
  /** Mode the keystroke switches to (when mode-switching), else null. */
  mode: ModeId | null;
}

export const KEYMAP: ReadonlyArray<KeyBinding> = [
  {
    key: 'b',
    footerLabel: 'blockers',
    description: 'Open Blockers full-screen — every actionable decision-pending item',
    mode: 'blockers',
  },
  {
    key: 'p',
    footerLabel: 'PRs',
    description: 'Open PRs full-screen — every open PR with diff preview, review history',
    mode: 'prs',
  },
  {
    key: 'd',
    footerLabel: 'deps',
    description: 'Open Dependency graph full-screen — ASCII tree of full dep graph',
    mode: 'deps',
  },
  {
    key: 'c',
    footerLabel: 'config',
    description:
      'Open Configuration browser — `.ai-sdlc/*.yaml` syntax-highlighted, validation errors annotated; `e` launches $EDITOR',
    mode: 'config',
  },
  {
    key: 'a',
    footerLabel: 'analytics',
    description: 'Open Analytics full-screen — operator throughput + pipeline metrics drill-down',
    mode: 'analytics',
  },
  {
    key: 'n',
    footerLabel: 'decisions',
    description:
      'Open Decisions-Pending pane — RFC-0035 Decision catalog; resolve pending items from TUI',
    mode: 'decisions',
  },
  {
    key: '/',
    footerLabel: 'search',
    description: 'Filter the active pane by substring match',
    mode: null,
  },
  {
    key: 'r',
    footerLabel: 'refresh',
    description: 'Refresh all data sources (invalidates caches and re-polls)',
    mode: null,
  },
  {
    key: '?',
    footerLabel: 'help',
    description: 'Open this help screen',
    mode: 'help',
  },
  {
    key: 'q',
    footerLabel: 'quit',
    description: 'Quit the TUI (Ctrl+C also works)',
    mode: null,
  },
];

/** Look up the mode-switching binding for a given key, or null when none. */
export function modeForKey(key: string): ModeId | null {
  const entry = KEYMAP.find((b) => b.key === key);
  return entry?.mode ?? null;
}

/** Whether this keystroke is a known mode-switch trigger. */
export function isModeKey(key: string): boolean {
  return KEYMAP.some((b) => b.key === key && b.mode !== null);
}
