import { redactSecrets } from '../security/secret-redact.js';
import type { JsonValue } from './types.js';

/**
 * A string that is exactly a 40-char base64-alphabet token (and not a 40-char
 * hex SHA, matching the string redactor) is an AWS secret access key when it
 * sits under a key whose NAME contains `secret`, or next to an AKIA/ASIA access
 * key id in the same object or array. The string redactor cannot see the key
 * name or the sibling when it is handed the value alone, so the structural walk
 * supplies that adjacency here.
 */
const AWS_SECRET_VALUE = /^[A-Za-z0-9/+=]{40}$/;
const HEX_40 = /^[0-9a-f]{40}$/i;
const ACCESS_KEY_ID = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/;
const MARKER = '[REDACTED:AWS_SECRET_KEY]';

function isAwsSecret(value: JsonValue): boolean {
  return typeof value === 'string' && AWS_SECRET_VALUE.test(value) && !HEX_40.test(value);
}

function holdsAccessKeyId(items: readonly JsonValue[]): boolean {
  return items.some((i) => typeof i === 'string' && ACCESS_KEY_ID.test(i));
}

function redactEntry(key: string, value: JsonValue, idAdjacent: boolean): JsonValue {
  const secretKey = /secret/i.test(key);
  if (isAwsSecret(value) && (secretKey || idAdjacent)) return MARKER;
  if (secretKey && Array.isArray(value)) {
    return value.map((v) => (isAwsSecret(v) ? MARKER : redactJsonValue(v)));
  }
  return redactJsonValue(value);
}

/** Redact secrets from every string (and object key) in a JSON value. */
export function redactJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) {
    const idAdjacent = holdsAccessKeyId(value);
    return value.map((v) => (idAdjacent && isAwsSecret(v) ? MARKER : redactJsonValue(v)));
  }
  if (value !== null && typeof value === 'object') {
    const idAdjacent = holdsAccessKeyId(Object.values(value));
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      // defineProperty keeps an own key such as `__proto__` as plain data
      // (assignment would set the prototype). Two keys that redact to the same
      // text collide: the later one wins.
      Object.defineProperty(out, redactSecrets(k), {
        value: redactEntry(k, v, idAdjacent),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
