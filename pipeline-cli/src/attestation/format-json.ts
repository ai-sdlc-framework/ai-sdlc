/**
 * TS port of ai-sdlc-plugin/scripts/format-envelope-json.mjs (keep in sync).
 * Serialize a JSON value exactly as prettier (this repo's .prettierrc,
 * printWidth 100) formats a .json file, so a freshly signed envelope passes
 * `pnpm format:check` (AISDLC-732). Dependency-free on purpose: the signer
 * runs in adopter repos where prettier may not be resolvable.
 *
 * Rules mirrored from prettier's JSON printer: non-empty objects always
 * expand; an array expands when it holds a non-empty object, when it has
 * more than one element and every element is a non-empty object/array, or
 * when it does not fit in the print width (including the trailing comma).
 */
const PRINT_WIDTH = 100;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : isObj(v) && Object.keys(v).length > 0;

function flat(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[${v.map(flat).join(', ')}]`;
  if (isObj(v)) {
    const ks = Object.keys(v);
    return ks.length === 0
      ? '{}'
      : `{ ${ks.map((k) => `${JSON.stringify(k)}: ${flat(v[k])}`).join(', ')} }`;
  }
  return JSON.stringify(v);
}

function mustBreak(arr: unknown[]): boolean {
  if (arr.some(isObj) && arr.some((e) => isObj(e) && isNonEmpty(e))) return true;
  return arr.length > 1 && arr.every((e) => isNonEmpty(e) && (Array.isArray(e) || isObj(e)));
}

function fmt(v: unknown, indent: number, trailing: number): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (
      !mustBreak(v) &&
      !v.some(isNonEmpty) &&
      pad.length + flat(v).length + trailing <= PRINT_WIDTH
    ) {
      return flat(v);
    }
    const items = v.map((e, i) => `${pad}  ${fmt(e, indent + 1, i < v.length - 1 ? 1 : 0)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (isObj(v)) {
    const ks = Object.keys(v);
    if (ks.length === 0) return '{}';
    const items = ks.map(
      (k, i) => `${pad}  ${JSON.stringify(k)}: ${fmt(v[k], indent + 1, i < ks.length - 1 ? 1 : 0)}`,
    );
    return `{\n${items.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(v);
}

export function formatEnvelopeJson(value: unknown): string {
  // Round-trip first so undefined keys/toJSON behave exactly as JSON.stringify.
  return fmt(JSON.parse(JSON.stringify(value)), 0, 0) + '\n';
}
