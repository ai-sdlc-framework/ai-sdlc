import { redactSecrets } from '../security/secret-redact.js';
import type { JsonValue } from './types.js';

/** Redact secrets from every string (and object key) in a JSON value. */
export function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) out[redactSecrets(k)] = redactJsonValue(v);
    return out;
  }
  return value;
}
