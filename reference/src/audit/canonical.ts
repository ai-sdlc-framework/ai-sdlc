/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer for audit entry hashing.
 *
 * Object keys are sorted by UTF-16 code units, numbers use the ECMAScript
 * shortest round-trip form (so `1.0` serializes as `1`), and strings are not
 * HTML-escaped. `undefined` object members are omitted.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Cannot canonicalize a non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const members = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new Error(`Cannot canonicalize a value of type ${typeof value}`);
  }
}
