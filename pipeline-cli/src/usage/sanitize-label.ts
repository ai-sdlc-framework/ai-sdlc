/**
 * Display sanitizer for strings that come from the usage ledger (model ids,
 * window keys, limit-event fields). Terminal control sequences, bidirectional
 * overrides and line breaks in a label could rewrite the screen, hijack the
 * clipboard or title, or forge extra rows, so every such string passes through
 * here before it is rendered. The ledger itself is never modified.
 *
 * @module usage/sanitize-label
 */

/** C0 and C1 controls (includes ESC, BEL, CR, LF, U+009B), bidi marks and overrides, isolates. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const DEFAULT_LABEL_MAX = 64;

/**
 * Replace unsafe characters with `?` and cap the length at `max` characters
 * (with an ellipsis). Pass `Infinity` to sanitize without capping.
 */
export function sanitizeLabel(value: unknown, max: number = DEFAULT_LABEL_MAX): string {
  const clean = String(value ?? '')
    .replace(UNSAFE, '?')
    .replace(LONE_SURROGATE, '?');
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
