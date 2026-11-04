#!/usr/bin/env node
/**
 * scripts/list-coverage-packages.mjs — AISDLC-1185
 *
 * Prints, as a JSON array on stdout, the workspace packages whose instrumentable files differ
 * between origin/main and HEAD: the same selection the pre-push patch-coverage hook uses
 * (`packagesToCover`). Machine verify calls it to run those packages under `test:coverage`.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listChangedFiles } from './check-pr-patch-coverage.mjs';
import { gitSafeEnv, packagesToCover } from './pre-push-patch-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function listPackages({ base = 'origin/main', head, cwd = ROOT } = {}) {
  const sha =
    head ??
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      env: gitSafeEnv(),
    }).trim();
  return packagesToCover(listChangedFiles({ base, head: sha, cwd }));
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) console.log(JSON.stringify(listPackages()));
