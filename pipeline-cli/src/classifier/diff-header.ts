/**
 * Reading the paths out of a `diff --git a/<old> b/<new>` header without a backtracking
 * regex. `^diff --git a\/(.+) b\/(.+)$` has two greedy `.+` around ' b/', so a hostile header
 * built from many ' b/' repeats makes it backtrack polynomially. These helpers use string
 * searches only and run in linear time on any input.
 */

/**
 * The path of a header whose two sides name the same file (`a/<path> b/<path>`, the rest of
 * the line after `diff --git `), or undefined. Only such a header is unambiguous when a path
 * itself contains ' b/'.
 */
export function sameNameHeaderPath(rest: string): string | undefined {
  if (!rest.startsWith('a/')) return undefined;
  const pair = rest.length - 5; // 'a/' + path + ' b/' + path
  if (pair < 2 || pair % 2 !== 0) return undefined;
  const half = pair / 2;
  if (rest.slice(2 + half, 5 + half) !== ' b/') return undefined;
  const path = rest.slice(2, 2 + half);
  return path === rest.slice(5 + half) ? path : undefined;
}

/** Both paths of a header (see {@link diffHeaderPaths}). */
export interface DiffHeaderPaths {
  oldPath: string;
  newPath: string;
  /**
   * False when the header holds several ' b/' and its sides name different files: the split
   * is then a guess (the last ' b/' that leaves a non-empty new path, as the old regex chose),
   * and a caller that must not guess treats the header as unreadable.
   */
  exact: boolean;
}

/**
 * Both paths of the text after `diff --git `, or undefined when it is not `a/<old> b/<new>`
 * with two non-empty paths. A same-name header is exact whatever its paths contain; any
 * other header splits at the last ' b/' that leaves a non-empty new path.
 */
export function diffHeaderPaths(rest: string): DiffHeaderPaths | undefined {
  if (!rest.startsWith('a/')) return undefined;
  const same = sameNameHeaderPath(rest);
  if (same !== undefined) return { oldPath: same, newPath: same, exact: true };
  const split = rest.lastIndexOf(' b/', rest.length - 4);
  if (split < 3) return undefined;
  const first = rest.indexOf(' b/', 2);
  return {
    oldPath: rest.slice(2, split),
    newPath: rest.slice(split + 3),
    exact: first === split && rest.lastIndexOf(' b/') === split,
  };
}
