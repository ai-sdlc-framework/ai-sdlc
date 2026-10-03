/**
 * Unified-diff reader for the risk map: files, hunks with their line ranges,
 * and added/removed line counts. Pure; never throws.
 *
 * Hunk bodies are consumed by the line counts in the hunk header, so a body line
 * that happens to start with `+++` or `diff --git` is never mistaken for a header.
 *
 * @module review-risk-map/diff
 */

export interface DiffHunk {
  /** The `@@ ... @@ context` line. */
  header: string;
  /** First line on the new side, at least 1. */
  startLine: number;
  /** Last line on the new side, at least `startLine`. */
  endLine: number;
  /** The hunk body, one line per entry joined with newlines. */
  text: string;
  /** True for a placeholder standing in for a file with no textual hunk. */
  synthetic: boolean;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  /** True when the file header could not be read as a plain path. */
  unparseable: boolean;
  hunks: DiffHunk[];
}

export const UNPARSEABLE_PATH = '<unparseable>';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const isQuoted = (p: string): boolean => p.startsWith('"');

interface OpenHunk {
  header: string;
  startLine: number;
  newLines: number;
  oldRemain: number;
  newRemain: number;
  body: string[];
}

function closeHunk(file: DiffFile, open: OpenHunk): void {
  const endLine = Math.max(open.startLine, open.startLine + open.newLines - 1);
  file.hunks.push({
    header: open.header,
    startLine: open.startLine,
    endLine,
    text: open.body.join('\n'),
    synthetic: false,
  });
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let open: OpenHunk | undefined;

  const finishFile = (): void => {
    if (!file) return;
    if (open) {
      closeHunk(file, open);
      open = undefined;
    }
    // A binary file, a pure rename or a mode change has no textual hunk. A placeholder
    // keeps it in the map, unjudged, so it is ranked as high risk instead of vanishing.
    if (file.hunks.length === 0) {
      file.hunks.push({
        header: file.binary ? '(binary file)' : '(no textual hunk)',
        startLine: 1,
        endLine: 1,
        text: '',
        synthetic: true,
      });
    }
    files.push(file);
    file = undefined;
  };

  for (const line of diff.split('\n')) {
    if (open && file) {
      if (line.startsWith('\\')) continue;
      const kind = line[0];
      if (kind === ' ' || line === '') {
        open.oldRemain--;
        open.newRemain--;
        open.body.push(line);
      } else if (kind === '-') {
        open.oldRemain--;
        file.removed++;
        open.body.push(line);
      } else if (kind === '+') {
        open.newRemain--;
        file.added++;
        open.body.push(line);
      } else {
        // Not a body line: the hunk ended early. Fall through to header handling.
        closeHunk(file, open);
        open = undefined;
      }
      if (open && open.oldRemain <= 0 && open.newRemain <= 0) {
        closeHunk(file, open);
        open = undefined;
      }
      if (open) continue;
      if (kind === ' ' || kind === '-' || kind === '+' || line === '') continue;
    }

    if (line.startsWith('diff --git ')) {
      finishFile();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const unparseable = !m || isQuoted(m[1]) || isQuoted(m[2]) || line.includes(' "b/');
      file = {
        path: unparseable || !m ? UNPARSEABLE_PATH : m[2],
        added: 0,
        removed: 0,
        binary: false,
        unparseable,
        hunks: [],
      };
      continue;
    }
    if (!file) continue;

    const hm = HUNK_HEADER.exec(line);
    if (hm) {
      const oldLines = hm[2] === undefined ? 1 : Number(hm[2]);
      const newLines = hm[4] === undefined ? 1 : Number(hm[4]);
      open = {
        header: line,
        startLine: Math.max(1, Number(hm[3])),
        newLines,
        oldRemain: oldLines,
        newRemain: newLines,
        body: [],
      };
      if (oldLines <= 0 && newLines <= 0) {
        closeHunk(file, open);
        open = undefined;
      }
      continue;
    }
    if (/^(?:Binary files .* differ|GIT binary patch)$/.test(line)) {
      file.binary = true;
      continue;
    }
    const rename = /^rename to (.+)$/.exec(line);
    if (rename && !file.unparseable) {
      if (isQuoted(rename[1])) file.unparseable = true;
      else file.path = rename[1];
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && !isQuoted(plus[1])) {
      file.path = plus[1];
      file.unparseable = false;
    }
  }
  finishFile();
  return files;
}
