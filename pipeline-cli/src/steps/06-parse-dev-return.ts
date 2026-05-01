/**
 * Step 6 — Parse the developer subagent's return JSON and apply gates.
 *
 * Mirrors `execute-orchestrator.md` Step 6:
 *
 *  - If `commitSha` is null → developer-failed.
 *  - If any of `verifications.{build,test,lint,format}` is `failed` → developer-failed.
 *  - Otherwise the structured return is validated and returned.
 *
 * Inputs accepted as either a JSON string or an already-parsed object so
 * the same function works for Tier 1 (CLI receives a `--return <json>` flag)
 * and Tier 2 (TypeScript service hands in the parsed `SubagentResult.parsed`).
 *
 * @module steps/06-parse-dev-return
 */

import type { DeveloperReturn, ParseDeveloperReturnResult, VerificationStatus } from '../types.js';

const VALID_VERIFICATION_STATUSES: VerificationStatus[] = ['passed', 'failed', 'skipped'];

export interface ParseDeveloperReturnOptions {
  /** Either a JSON string or a parsed object. */
  developerReturn: string | unknown;
}

export async function parseDeveloperReturn(
  opts: ParseDeveloperReturnOptions,
): Promise<ParseDeveloperReturnResult> {
  let parsed: unknown = opts.developerReturn;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      return { ok: false, reason: `failed to parse developer JSON: ${(err as Error).message}` };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'developer return is not an object' };
  }
  const obj = parsed as Record<string, unknown>;

  // Required keys
  for (const key of [
    'summary',
    'filesChanged',
    'commitSha',
    'verifications',
    'acceptanceCriteriaMet',
  ]) {
    if (!(key in obj)) {
      return { ok: false, reason: `developer return missing required key '${key}'` };
    }
  }

  if (!Array.isArray(obj.filesChanged)) {
    return { ok: false, reason: "developer return field 'filesChanged' must be an array" };
  }
  if (!Array.isArray(obj.acceptanceCriteriaMet)) {
    return { ok: false, reason: "developer return field 'acceptanceCriteriaMet' must be an array" };
  }
  const v = obj.verifications;
  if (!v || typeof v !== 'object') {
    return { ok: false, reason: "developer return field 'verifications' must be an object" };
  }
  const vObj = v as Record<string, unknown>;
  for (const key of ['build', 'test', 'lint', 'format']) {
    const val = vObj[key];
    if (
      typeof val !== 'string' ||
      !VALID_VERIFICATION_STATUSES.includes(val as VerificationStatus)
    ) {
      return {
        ok: false,
        reason: `developer return verifications.${key} must be one of ${VALID_VERIFICATION_STATUSES.join('/')}`,
      };
    }
  }

  // Treat null commitSha as developer failure (RFC §5.4 + execute-orchestrator Step 6).
  if (obj.commitSha === null || obj.commitSha === undefined) {
    return {
      ok: false,
      reason: `developer reported null commitSha — task could not be completed${
        typeof obj.notes === 'string' && obj.notes ? ': ' + obj.notes : ''
      }`,
      developer: obj as unknown as DeveloperReturn,
    };
  }

  for (const key of ['build', 'test', 'lint', 'format'] as const) {
    if (vObj[key] === 'failed') {
      return {
        ok: false,
        reason: `developer reported verifications.${key} = failed`,
        developer: obj as unknown as DeveloperReturn,
      };
    }
  }

  return { ok: true, developer: obj as unknown as DeveloperReturn };
}
