/** Pure helpers for a parent checkout with tracked changes (AISDLC-1346); no I/O, safe to import anywhere. */

/** Cause code of a refusal because the parent has tracked changes; an environment cause, never a task fault. */
export const PARENT_DIRTY_CAUSE = 'parent-dirty';

/** File paths named by `git status --porcelain` output (renames report the new path). */
export function changedPathsOf(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const p = l.slice(3);
      const i = p.indexOf(' -> ');
      return i === -1 ? p : p.slice(i + 4);
    });
}

/** The one-line report for a dirty parent: names the files and says how to clear it. */
export function parentDirtyMessage(files: readonly string[]): string {
  const shown =
    files.slice(0, 10).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');
  return (
    `Step 0 parent check refused: the parent checkout has uncommitted changes to tracked ` +
    `file(s): ${shown || 'unknown'}. Commit the change through a pull request (or discard it) ` +
    `so the parent is clean; no task is claimed until then.`
  );
}
