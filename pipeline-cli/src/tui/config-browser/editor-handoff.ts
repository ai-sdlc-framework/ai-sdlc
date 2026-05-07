/**
 * External `$EDITOR` handoff — RFC-0023 §9 / OQ-2 / AISDLC-178.5 AC#6.
 *
 * Per OQ-2 the TUI does NOT embed a YAML editor. The `e` keystroke
 * launches the operator's `$EDITOR` (vim / nvim / code / etc.) on the
 * selected file, blocks until the editor exits, then signals the caller
 * to re-validate.
 *
 * Implementation:
 *   - Launches via `sh -c "$EDITOR \"$1\"" -- <path>` so editors with
 *     embedded flags (`code -w`, `subl -w`, etc.) work without extra
 *     parsing.
 *   - `stdio: 'inherit'` so the editor takes over the TTY. Ink's
 *     render must be paused (`useApp().exit()` not appropriate; instead
 *     the caller wraps with `withFullScreen` or unmounts then re-mounts).
 *   - Returns `EDITOR_NOT_SET` when neither $EDITOR nor $VISUAL is in
 *     the environment — caller surfaces "set $EDITOR to edit".
 *   - Returns `EDITOR_FAILED` when the spawn itself errored (editor
 *     missing on PATH, etc.). Editor exit-code != 0 is treated as
 *     `EDITOR_OK` since vim's `:cq` is a legitimate quit-without-save.
 */

import { spawnSync } from 'node:child_process';

export type EditorHandoffOutcome = 'EDITOR_OK' | 'EDITOR_NOT_SET' | 'EDITOR_FAILED';

export interface LaunchEditorResult {
  outcome: EditorHandoffOutcome;
  /** The editor command resolved (`$EDITOR` value), or null. */
  editor: string | null;
  /** Spawn error message when outcome === 'EDITOR_FAILED'. */
  error?: string;
}

export interface LaunchEditorOpts {
  /** Absolute path of the file to open. */
  filePath: string;
  /** Override the env (tests). Defaults `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Inject the spawn callable (tests). Mirrors `child_process.spawnSync`
   * shape — receives (cmd, args, options). Defaults to the real
   * `spawnSync` with `stdio: 'inherit'`.
   */
  spawnFn?: (cmd: string, args: string[]) => { status: number | null; error?: Error };
}

/**
 * Launch `$EDITOR` on the given file. Blocks until the editor exits.
 *
 * Returns the outcome the caller uses to drive the post-edit re-validation.
 */
export function launchEditor(opts: LaunchEditorOpts): LaunchEditorResult {
  const env = opts.env ?? process.env;
  const editor = env.EDITOR ?? env.VISUAL ?? null;
  if (!editor) {
    return { outcome: 'EDITOR_NOT_SET', editor: null };
  }

  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[]): { status: number | null; error?: Error } => {
      const result = spawnSync(cmd, args, { stdio: 'inherit' });
      return { status: result.status, error: result.error };
    });

  // Wrap in `sh -c` so the editor command can include flags like `code -w`.
  const result = spawnFn('sh', ['-c', `${editor} "$1"`, '--', opts.filePath]);
  if (result.error) {
    return { outcome: 'EDITOR_FAILED', editor, error: result.error.message };
  }
  // Non-zero exit codes (vim :cq, etc.) still count as "edit complete" —
  // the caller decides whether to re-read the file.
  return { outcome: 'EDITOR_OK', editor };
}
