#!/usr/bin/env node
/**
 * materialize-head-data.mjs (AISDLC-757)
 *
 * Copies ONLY the attestation envelope(s) and transcript leaves from a PR head
 * commit into the BASE checkout, as untrusted DATA. Nothing from the head is
 * ever checked out or executed: bytes are read straight from git objects
 * (`git ls-tree` / `git cat-file`), so a head-controlled symlink, script or
 * workflow file can never land in the trusted working tree.
 *
 * Allowed destinations (whitelist, everything else is ignored):
 *   .ai-sdlc/attestations/<name>.dsse.json
 *   .ai-sdlc/transcript-leaves.jsonl
 *   .ai-sdlc/transcript-leaves/<40-hex>.jsonl
 *
 * Fail closed (exit 1) when an entry under those locations is a symlink,
 * submodule or other non-regular mode, when a path has an unsafe component, or
 * when a destination parent resolves through a symlink / outside the repo root.
 *
 * Usage: node materialize-head-data.mjs --repo-root <dir> --head-sha <40-hex>
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const ENVELOPE_RE = /^\.ai-sdlc\/attestations\/[A-Za-z0-9][A-Za-z0-9._-]*\.dsse\.json$/;
const LEAVES_FILE = '.ai-sdlc/transcript-leaves.jsonl';
const LEAVES_DIR_RE = /^\.ai-sdlc\/transcript-leaves\/[0-9a-f]{40}\.jsonl$/;
const ROOTS = ['.ai-sdlc/attestations', '.ai-sdlc/transcript-leaves', LEAVES_FILE];
const MAX_BYTES = 8 * 1024 * 1024;

export class MaterializeError extends Error {}

function git(root, args, opts = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: MAX_BYTES * 2,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...opts,
  });
}

function assertSafePath(path) {
  for (const part of path.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new MaterializeError(`unsafe path component in ${JSON.stringify(path)}`);
    }
  }
}

/** Refuse a destination whose existing parents are symlinks or escape root. */
function assertDestinationInside(realRoot, rel) {
  const parts = rel.split('/');
  let cur = realRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // not yet created; the remainder is created by us
    }
    if (st.isSymbolicLink()) {
      throw new MaterializeError(
        `destination ${rel} traverses a symlink at ${parts.slice(0, i + 1).join('/')}`,
      );
    }
  }
  const full = resolve(realRoot, rel);
  if (!full.startsWith(realRoot + sep)) {
    throw new MaterializeError(`destination ${rel} escapes the repo root`);
  }
}

export function materializeHeadData({ repoRoot, headSha }) {
  if (!SHA_RE.test(headSha ?? '')) {
    throw new MaterializeError('--head-sha must be exactly 40 lowercase hex characters');
  }
  const realRoot = realpathSync(resolve(repoRoot));
  const listing = git(realRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    headSha,
    '--',
    ...ROOTS,
  ]).toString('utf8');
  const copied = [];
  for (const entry of listing.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, objSha] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    assertSafePath(path);
    if (mode !== '100644' && mode !== '100755') {
      throw new MaterializeError(
        `refusing non-regular entry (mode ${mode}, type ${type}): ${path}`,
      );
    }
    if (!(ENVELOPE_RE.test(path) || path === LEAVES_FILE || LEAVES_DIR_RE.test(path))) {
      process.stderr.write(`[materialize] ignoring non-whitelisted head path: ${path}\n`);
      continue;
    }
    const data = git(realRoot, ['cat-file', 'blob', objSha]);
    if (data.length > MAX_BYTES) {
      throw new MaterializeError(`${path} exceeds ${MAX_BYTES} bytes`);
    }
    assertDestinationInside(realRoot, path);
    const dest = join(realRoot, path);
    mkdirSync(dirname(dest), { recursive: true });
    assertDestinationInside(realRoot, path);
    writeFileSync(dest, data, { flag: 'w', mode: 0o644 });
    copied.push(path);
  }
  return copied;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new MaterializeError(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const isMain =
  process.argv[1] != null && new URL(import.meta.url).pathname === resolve(process.argv[1]);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const copied = materializeHeadData({
      repoRoot: args['repo-root'] ?? '.',
      headSha: args['head-sha'],
    });
    process.stdout.write(
      `[materialize] copied ${copied.length} file(s) from head as untrusted data\n`,
    );
    for (const p of copied) process.stdout.write(`  ${p}\n`);
  } catch (err) {
    process.stderr.write(
      `::error::[materialize] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
