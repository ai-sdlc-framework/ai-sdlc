#!/usr/bin/env node
/**
 * Create or update the CodeQL repository ruleset idempotently (AISDLC-705).
 *
 * Usage: node scripts/apply-codeql-ruleset.mjs [--repo owner/name] [--dry-run]
 *
 * Reads .github/rulesets/codeql-main.json, finds a ruleset with the same name,
 * PUTs it if present, POSTs otherwise, then re-exports the applied ruleset to the
 * same file so drift is reviewable. A 403/404 means the token lacks repository
 * Administration (write); the script stops and reports it, no alternative path.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RULESET_FILE = '.github/rulesets/codeql-main.json';

export function pickExisting(rulesets, name) {
  return rulesets.find((r) => r.name === name);
}

export function exportable(applied) {
  const { name, target, enforcement, conditions, rules, bypass_actors } = applied;
  return { name, target, enforcement, conditions, rules, bypass_actors: bypass_actors ?? [] };
}

export function missingPermissionMessage(stderr) {
  return /403|404|Must have admin|Resource not accessible/i.test(stderr)
    ? 'OPERATOR-ONLY: token lacks repository "Administration: write" (admin) permission; not trying another route.'
    : null;
}

function gh(args, input) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', input });
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--repo');
  const repo = i >= 0 ? argv[i + 1] : 'ai-sdlc-framework/ai-sdlc';
  const dry = argv.includes('--dry-run');
  const desired = JSON.parse(readFileSync(RULESET_FILE, 'utf8'));
  try {
    const existing = pickExisting(JSON.parse(gh([`repos/${repo}/rulesets`])), desired.name);
    if (dry) {
      console.log(existing ? `would update ruleset ${existing.id}` : 'would create ruleset');
      return 0;
    }
    const body = JSON.stringify(desired);
    const out = existing
      ? gh(['-X', 'PUT', `repos/${repo}/rulesets/${existing.id}`, '--input', '-'], body)
      : gh(['-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], body);
    const applied = JSON.parse(gh([`repos/${repo}/rulesets/${JSON.parse(out).id}`]));
    writeFileSync(RULESET_FILE, JSON.stringify(exportable(applied), null, 2) + '\n');
    console.log(`${existing ? 'updated' : 'created'} ruleset ${applied.id}`);
    return 0;
  } catch (err) {
    const msg = missingPermissionMessage(String(err.stderr ?? err.message));
    console.error(msg ?? String(err.stderr ?? err.message));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
