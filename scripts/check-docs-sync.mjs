#!/usr/bin/env node
/**
 * check-docs-sync.mjs — fail if ai-sdlc/docs and ai-sdlc-io/content/docs diverge.
 *
 * Decision context: backlog/decisions/AISDLC-68-documentation-consolidation.md
 *
 * Strategy:
 *   1. Run the conversion (`docs-sync.mjs`) into a temporary directory.
 *   2. For each `.mdx` produced, compare to the corresponding file under the
 *      published tree.
 *   3. Report any of:
 *        - source file with no published counterpart        (missing-published)
 *        - published file with no source counterpart        (orphaned-published)
 *          ... excluding `meta.json` and synthesized `index.mdx` siblings,
 *          which are Fumadocs scaffolding that have no source equivalent
 *          by design.
 *        - byte mismatch between regenerated and published   (drift)
 *   4. Exit 0 if nothing reported, exit 1 otherwise.
 *
 * The whole point is to make drift loud: if you edit the published `.mdx`
 * directly without updating the source `.md`, this check fails. If you edit
 * the source `.md` and forget to regenerate, this check fails. Either way,
 * `pnpm docs:sync` fixes it.
 *
 * Invoked from `pnpm test` via `pnpm docs:check` (defined in root package.json).
 *
 * Usage:
 *   node scripts/check-docs-sync.mjs                    # default paths
 *   node scripts/check-docs-sync.mjs --src docs --dst /path/to/published
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDocs } from './docs-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_SRC = resolve(REPO_ROOT, 'docs');
const DEFAULT_DST = resolve(REPO_ROOT, '..', 'ai-sdlc-io', 'content', 'docs');

/**
 * Files in the published tree that never have a source counterpart.
 * - `meta.json` — Fumadocs navigation config
 * - `index.mdx` — synthesized navigation page; the source is `README.md`
 *   under the same directory but the published tree keeps both.
 */
const PUBLISHED_ONLY_ALLOWLIST = new Set(['meta.json', 'index.mdx']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function listMdxRel(root) {
  const out = [];
  for await (const f of walk(root)) {
    if (f.endsWith('.mdx')) out.push(relative(root, f));
  }
  return out.sort();
}

async function listAllRel(root) {
  const out = [];
  for await (const f of walk(root)) out.push(relative(root, f));
  return out.sort();
}

/**
 * Run the divergence check. Returns 0 (clean) or 1 (drift).
 */
export async function runCheck({ src = DEFAULT_SRC, dst = DEFAULT_DST } = {}) {
  if (!existsSync(src)) {
    console.error(`[docs-check] source dir not found: ${src}`);
    return 1;
  }
  if (!existsSync(dst)) {
    console.error(`[docs-check] published dir not found: ${dst}`);
    console.error(
      `[docs-check] this is expected when running CI without the sibling repo checked out.`,
    );
    console.error(`[docs-check] skipping (treating as pass).`);
    return 0;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'ai-sdlc-docs-check-'));
  try {
    await syncDocs({ src, dst: tmp });
    const generated = await listMdxRel(tmp);
    const published = await listMdxRel(dst);

    const missing = [];
    const orphaned = [];
    const drift = [];

    const generatedSet = new Set(generated);
    const publishedSet = new Set(published);

    for (const rel of generated) {
      if (!publishedSet.has(rel)) {
        missing.push(rel);
        continue;
      }
      const a = await readFile(join(tmp, rel), 'utf-8');
      const b = await readFile(join(dst, rel), 'utf-8');
      if (a !== b) drift.push(rel);
    }

    for (const rel of published) {
      if (generatedSet.has(rel)) continue;
      const name = basename(rel);
      if (PUBLISHED_ONLY_ALLOWLIST.has(name)) continue;
      orphaned.push(rel);
    }

    // Also catch published `meta.json` files etc that exist with no source
    // equivalent — they're allowed by `PUBLISHED_ONLY_ALLOWLIST` but we still
    // log them so reviewers know what's going on. Not an error.
    const allPublished = await listAllRel(dst);
    const synthesized = allPublished.filter((p) => PUBLISHED_ONLY_ALLOWLIST.has(basename(p)));

    let ok = true;
    if (missing.length) {
      ok = false;
      console.error('[docs-check] FAIL — source files with no published counterpart:');
      for (const f of missing) console.error(`  - ${f}`);
      console.error('  fix: run `pnpm docs:sync`');
    }
    if (orphaned.length) {
      ok = false;
      console.error('[docs-check] FAIL — published files with no source counterpart:');
      for (const f of orphaned) console.error(`  - ${f}`);
      console.error(
        '  fix: write the source `.md` in `ai-sdlc/docs/` (or remove the orphan from the published tree if intentional)',
      );
    }
    if (drift.length) {
      ok = false;
      console.error('[docs-check] FAIL — drift between source and published:');
      for (const f of drift) console.error(`  - ${f}`);
      console.error('  fix: run `pnpm docs:sync` and commit the regenerated `.mdx` files');
    }
    if (ok) {
      console.log(
        `[docs-check] ok — ${generated.length} synced page(s), ${synthesized.length} synthesized page(s) tolerated`,
      );
    }
    return ok ? 0 : 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let src = DEFAULT_SRC;
  let dst = DEFAULT_DST;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--src') src = resolve(args[++i]);
    else if (args[i] === '--dst') dst = resolve(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/check-docs-sync.mjs [--src <path>] [--dst <path>]');
      process.exit(0);
    }
  }
  process.exit(await runCheck({ src, dst }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
