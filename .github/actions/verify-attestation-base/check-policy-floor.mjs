#!/usr/bin/env node
/**
 * check-policy-floor.mjs (AISDLC-757)
 *
 * Optional consumer-workflow guard: the `required-independence-tier` workflow
 * input is a FLOOR on the BASE-branch `.ai-sdlc/independence-policy.yaml`
 * `requiredTier`. It does not evaluate the envelope (that is
 * `cli-attestation independence-policy`'s job) and never parses `verify`
 * output; it only stops a consumer policy file from being weaker than the
 * floor the workflow caller asked for.
 *
 * Usage: node check-policy-floor.mjs --repo-root <dir> --floor <none|attested|isolated>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TIER_ORDER = ['none', 'attested', 'isolated'];

export function readRequiredTier(policyText) {
  const m = /^\s*requiredTier\s*:\s*['"]?([A-Za-z]+)['"]?\s*(?:#.*)?$/m.exec(policyText);
  return m ? m[1] : 'none';
}

export function checkFloor({ policyText, floor }) {
  if (!TIER_ORDER.includes(floor))
    return { ok: false, message: `unknown floor tier ${JSON.stringify(floor)}` };
  const actual = policyText == null ? 'none' : readRequiredTier(policyText);
  if (!TIER_ORDER.includes(actual))
    return { ok: false, message: `unknown requiredTier ${JSON.stringify(actual)}` };
  if (TIER_ORDER.indexOf(actual) < TIER_ORDER.indexOf(floor)) {
    return {
      ok: false,
      message: `base policy requiredTier=${actual} is below the required floor ${floor}`,
    };
  }
  return { ok: true, message: `base policy requiredTier=${actual} satisfies floor ${floor}` };
}

const isMain =
  process.argv[1] != null && new URL(import.meta.url).pathname === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (k) => argv[argv.indexOf(`--${k}`) + 1];
  const policyPath = join(resolve(get('repo-root') ?? '.'), '.ai-sdlc', 'independence-policy.yaml');
  const policyText = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : null;
  const res = checkFloor({ policyText, floor: get('floor') ?? 'none' });
  process.stdout.write(`[policy-floor] ${res.message}\n`);
  process.exit(res.ok ? 0 : 1);
}
