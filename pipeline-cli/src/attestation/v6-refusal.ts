/**
 * Named refusal of the v6 attestation envelope (RFC-0061 phase 3, OQ-3 hard cut).
 *
 * The signed-envelope gate was replaced by the review verdict check. No signer or
 * verifier remains, so a v6 envelope handed to `cli-attestation verify` is refused
 * with {@link V6_REFUSED_CODE} rather than silently verified or ignored.
 *
 * @module attestation/v6-refusal
 */

import { existsSync, readFileSync } from 'node:fs';

/** The named error every `cli-attestation verify` call reports. */
export const V6_REFUSED_CODE = 'attestation-schema-v6-refused';

/** Read the schema version a DSSE envelope's payload declares, or null when unreadable. */
function declaredSchemaVersion(path: string): string | null {
  try {
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { payload?: unknown };
    if (typeof envelope.payload !== 'string') return null;
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as {
      predicate?: { schemaVersion?: unknown };
    };
    const v = statement.predicate?.schemaVersion;
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  } catch {
    return null;
  }
}

/**
 * The reason line for a refused envelope. Names the schema the file declared when it
 * can be read; every outcome carries {@link V6_REFUSED_CODE}.
 */
export function refuseAttestationEnvelope(envelopePath?: string): string {
  const why =
    'v6 is no longer a signed or verified format; the merge gate reads the review verdict ' +
    '(cli-attestation verdict-check)';
  if (envelopePath === undefined) return `${V6_REFUSED_CODE}: ${why}`;
  if (!existsSync(envelopePath)) {
    return `${V6_REFUSED_CODE}: envelope not found at ${envelopePath}; ${why}`;
  }
  const version = declaredSchemaVersion(envelopePath);
  const declared = version === null ? 'unreadable schema' : `schema ${version}`;
  return `${V6_REFUSED_CODE}: ${envelopePath} declares ${declared}; ${why}`;
}
