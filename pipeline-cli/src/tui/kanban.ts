/**
 * Backlog.md kanban link-out — RFC-0023 §11 / OQ-5 (AISDLC-178.5 AC#8).
 *
 * Per OQ-5 the TUI does NOT embed kanban; pressing `b` on a task row opens
 * backlog.md in the operator's browser, filtered to that task. Resolution:
 * "macOS `open <url>`, Linux `xdg-open`, fallback `pbcopy`/`xclip`".
 *
 * Fallback chain (each tried in order until one succeeds):
 *   1. `gh browse --no-browser <url>` (when inside a repo with gh)  — copies URL to clipboard
 *   2. `open <url>` (macOS)
 *   3. `xdg-open <url>` (Linux)
 *   4. `start <url>` (Windows)
 *   5. `pbcopy` (macOS clipboard fallback)
 *   6. `xclip -selection clipboard` (Linux clipboard fallback)
 *
 * If every step fails, the helper returns the URL so the caller can render
 * "open this in your browser:" copy and let the operator take over.
 */

import { execFileSync } from 'node:child_process';

/** Outcome of a kanban-launch attempt — recorded for logging + tests. */
export interface KanbanLaunchResult {
  /** The URL that was launched (or attempted). */
  url: string;
  /**
   * The mechanism that succeeded, or 'none' when every fallback failed.
   * 'browser' = launched in browser; 'clipboard' = copied to clipboard;
   * 'none' = caller should display the URL.
   */
  outcome: 'browser' | 'clipboard' | 'none';
  /** The specific tool invoked (e.g. 'open', 'xdg-open', 'pbcopy'). */
  tool: string | null;
}

export interface BuildKanbanUrlOpts {
  /** Base URL of the kanban (defaults `http://localhost:6420`). */
  baseUrl?: string;
  /** Task ID to deep-link to (e.g. 'AISDLC-178.5'). */
  taskId: string;
}

/**
 * Construct the kanban URL for a task. backlog.md does not currently expose
 * deep-link semantics; the URL is constructed defensively (`?task=<id>`)
 * so when the upstream kanban gains query-param support the link "just
 * works" without TUI changes. Falls through harmlessly today (kanban
 * ignores unknown query params).
 */
export function buildKanbanUrl(opts: BuildKanbanUrlOpts): string {
  const baseUrl = opts.baseUrl ?? 'http://localhost:6420';
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/?task=${encodeURIComponent(opts.taskId)}`;
}

/** Inject a runner for tests. Defaults to the real `execFileSync`. */
export interface LaunchKanbanOpts {
  url: string;
  /** Override platform detection (tests). */
  platform?: NodeJS.Platform;
  /** Inject runner (tests). Throws → tool unavailable. */
  runner?: (cmd: string, args: string[]) => void;
  /**
   * Inject clipboard runner that accepts stdin (tests). Defaults to
   * spawning the real CLI with the URL on stdin.
   */
  clipboardRunner?: (cmd: string, args: string[], stdin: string) => void;
}

/**
 * Launch the kanban URL through the most-appropriate tool for the host
 * platform, falling back through the chain when individual tools are
 * absent. Returns a result describing what (if anything) succeeded — the
 * caller renders a status line / banner accordingly.
 */
export function launchKanban(opts: LaunchKanbanOpts): KanbanLaunchResult {
  const platform = opts.platform ?? process.platform;
  const runner =
    opts.runner ??
    ((cmd, args): void => {
      execFileSync(cmd, args, { stdio: 'ignore' });
    });
  const clipboardRunner =
    opts.clipboardRunner ??
    ((cmd, args, stdin): void => {
      execFileSync(cmd, args, { input: stdin, stdio: ['pipe', 'ignore', 'ignore'] });
    });

  // Per platform, try the native opener first.
  const browserCandidates: Array<[string, string[]]> = [];
  if (platform === 'darwin') {
    browserCandidates.push(['open', [opts.url]]);
  } else if (platform === 'win32') {
    browserCandidates.push(['cmd', ['/c', 'start', '', opts.url]]);
  } else {
    browserCandidates.push(['xdg-open', [opts.url]]);
  }

  for (const [cmd, args] of browserCandidates) {
    try {
      runner(cmd, args);
      return { url: opts.url, outcome: 'browser', tool: cmd };
    } catch {
      // Try next candidate.
    }
  }

  // Browser-launch failed — fall back to clipboard so the operator can paste.
  const clipboardCandidates: Array<[string, string[]]> =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : platform === 'win32'
        ? [['clip', []]]
        : [
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  for (const [cmd, args] of clipboardCandidates) {
    try {
      clipboardRunner(cmd, args, opts.url);
      return { url: opts.url, outcome: 'clipboard', tool: cmd };
    } catch {
      // Try next candidate.
    }
  }

  return { url: opts.url, outcome: 'none', tool: null };
}
