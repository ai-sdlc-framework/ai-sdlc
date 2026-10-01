import { redactSecrets } from '../security/secret-redact.js';
import type { JsonValue } from './types.js';

/**
 * A string value stored under a key whose NAME contains `secret` and that is
 * exactly a 40-char base64-alphabet token is an AWS secret access key. The
 * string redactor cannot see the key name when it is handed the value alone,
 * so the structural walk supplies that adjacency here.
 */
const AWS_SECRET_VALUE = /^[A-Za-z0-9/+=]{40}$/;

function redactEntry(key: string, value: JsonValue): JsonValue {
  if (typeof value === 'string' && /secret/i.test(key) && AWS_SECRET_VALUE.test(value)) {
    return '[REDACTED:AWS_SECRET_KEY]';
  }
  return redactJsonValue(value);
}

/** Redact secrets from every string (and object key) in a JSON value. */
export function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) out[redactSecrets(k)] = redactEntry(k, v);
    return out;
  }
  return value;
}
