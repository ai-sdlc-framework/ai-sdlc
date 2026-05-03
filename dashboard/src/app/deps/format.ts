/**
 * Pure formatting helpers for the dependency-graph page (AISDLC-167.4).
 *
 * Lives in a sibling file rather than inside `page.tsx` because Next.js
 * App Router only allows a curated set of exports from page modules
 * (`default`, `metadata`, `dynamic`, `generateMetadata`, etc.) — re-exporting
 * helpers from there fails the build with "X is not a valid Page export
 * field".
 */

/**
 * Map a backlog frontmatter `status:` value to a hex color per RFC-0014 §7.2.
 * Case-insensitive + trims whitespace so author typos don't break the
 * coloring.
 */
export function colorForStatus(status: string): string {
  const s = status.trim().toLowerCase();
  if (s === 'to do' || s === 'todo' || s === 'open') return '#2563eb'; // blue
  if (s === 'in progress' || s === 'wip') return '#ca8a04'; // yellow
  if (s === 'needs clarification' || s === 'needs-clarification' || s === 'blocked')
    return '#dc2626'; // red
  if (s === 'done' || s === 'completed' || s === 'shipped') return '#16a34a'; // green
  return '#64748b'; // neutral gray fallback
}

/**
 * Map numeric priority weight (1-4) to the human-friendly bucket name. Used
 * for the per-task card label.
 */
export function priorityBucketLabel(weight: number): string {
  switch (weight) {
    case 1:
      return 'low';
    case 2:
      return 'medium';
    case 3:
      return 'high';
    case 4:
      return 'critical';
    default:
      return '?';
  }
}
