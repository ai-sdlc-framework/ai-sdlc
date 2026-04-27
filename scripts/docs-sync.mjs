#!/usr/bin/env node
/**
 * docs-sync.mjs — convert ai-sdlc/docs/**\/*.md into ai-sdlc-io/content/docs/**\/*.mdx
 *
 * Decision context: backlog/decisions/AISDLC-68-documentation-consolidation.md
 *
 * What it does:
 *   - Walks the source tree (default: ./docs).
 *   - For each .md file, writes a corresponding .mdx file under the destination
 *     tree (default: ../ai-sdlc-io/content/docs), preserving the directory
 *     structure.
 *   - Adds frontmatter `title: "<H1>"` derived from the file's first H1 heading,
 *     or the filename if no H1 is present. If frontmatter already exists in the
 *     source (rare), it's normalized through the same shape.
 *   - Renames `README.md` → `README.mdx` (kept as-is to mirror what the published
 *     tree does today; the synthesized `index.mdx` companions remain untouched).
 *   - Rewrites intra-doc Markdown links of the form `[text](path.md)` and
 *     `[text](path.md#anchor)` to use `.mdx` extensions, but only for actual
 *     Markdown link syntax — references inside fenced code blocks are preserved
 *     verbatim so CLI examples and directory listings stay literal.
 *   - Skips non-markdown source files (`.ts`, `.yaml`, `.json`) by design;
 *     those are runnable examples and don't get published as MDX pages.
 *   - Leaves `meta.json` and any pre-existing `index.mdx` in the destination
 *     untouched (these are Fumadocs scaffolding with no source equivalent).
 *
 * What it does NOT do:
 *   - Does not delete files in the destination that have no source equivalent.
 *     That's the divergence checker's job (`check-docs-sync.mjs`), and we want
 *     deletions to be a deliberate human action.
 *   - Does not commit. The orchestrator handles sibling-repo commits as a
 *     separate PR.
 *   - Does not touch the spec tree. Spec consolidation is a separate decision.
 *
 * Usage:
 *   node scripts/docs-sync.mjs                          # default paths
 *   node scripts/docs-sync.mjs --src docs --dst /tmp/x  # explicit paths
 *   node scripts/docs-sync.mjs --check                  # dry-run, exit 1 on diff
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_SRC = resolve(REPO_ROOT, 'docs');
const DEFAULT_DST = resolve(REPO_ROOT, '..', 'ai-sdlc-io', 'content', 'docs');

/**
 * Convert a source `.md` file body into an `.mdx` file body.
 * Pure function — exported for unit testing.
 */
export function convertMarkdownToMdx(source, { fallbackTitle = 'Untitled' } = {}) {
  const { frontmatter, body } = parseFrontmatter(source);
  const title = frontmatter.title ?? extractFirstH1(body) ?? fallbackTitle;
  const rewrittenBody = rewriteMdLinks(body);
  const fm = `---\ntitle: "${escapeFrontmatterString(title)}"\n---\n`;
  return fm + rewrittenBody;
}

/**
 * Parse a leading `--- ... ---` YAML frontmatter block, if present.
 * Returns { frontmatter: object, body: string }. Only `title` is parsed
 * because that's all this script cares about; other keys round-trip through
 * the body as-is (which means we'd lose them — by design, our source tree
 * is plain markdown and frontmatter is added by this script).
 */
export function parseFrontmatter(source) {
  if (!source.startsWith('---\n')) return { frontmatter: {}, body: source };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: source };
  const block = source.slice(4, end);
  const body = source.slice(end + 5);
  const fm = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fm[m[1]] = value;
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Extract the first `# Heading` from a markdown body. Returns `null` if none.
 * Skips text inside fenced code blocks so a `# comment` in a bash example
 * doesn't get picked up as the page title.
 */
export function extractFirstH1(body) {
  const lines = body.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Rewrite `[text](path.md)` and `[text](path.md#anchor)` to `.mdx`.
 * Skips fenced code blocks so CLI examples and directory listings keep
 * their literal `.md` references.
 *
 * The pattern is intentionally conservative: it only rewrites links whose
 * URL component is a relative path ending in `.md` (optionally followed by
 * `#anchor`). Absolute URLs (https://...) and links with query strings are
 * left alone.
 */
export function rewriteMdLinks(body) {
  const lines = body.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (line.startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(
        /(\[[^\]]*\]\()([^)]+?)\.md(#[^)]*)?(\))/g,
        (_match, open, path, anchor, close) => {
          if (/^https?:\/\//.test(path)) return _match;
          return `${open}${path}.mdx${anchor ?? ''}${close}`;
        },
      );
    })
    .join('\n');
}

function escapeFrontmatterString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Run the conversion. Returns the list of destination files that were
 * (re)written. Does not delete anything.
 */
export async function syncDocs({ src, dst }) {
  const written = [];
  for await (const file of walk(src)) {
    if (!file.endsWith('.md')) continue;
    const rel = relative(src, file);
    const dstPath = join(dst, rel.replace(/\.md$/, '.mdx'));
    const source = await readFile(file, 'utf-8');
    const fallbackTitle = basename(rel, '.md');
    const out = convertMarkdownToMdx(source, { fallbackTitle });
    await mkdir(dirname(dstPath), { recursive: true });
    await writeFile(dstPath, out, 'utf-8');
    written.push(dstPath);
  }
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  let src = DEFAULT_SRC;
  let dst = DEFAULT_DST;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--src') src = resolve(args[++i]);
    else if (args[i] === '--dst') dst = resolve(args[++i]);
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node scripts/docs-sync.mjs [--src <path>] [--dst <path>] [--check]');
      process.exit(0);
    }
  }

  if (!existsSync(src)) {
    console.error(`[docs-sync] source dir not found: ${src}`);
    process.exit(1);
  }

  if (check) {
    // Delegate to check-docs-sync — keeps the divergence logic in one place.
    const checker = await import('./check-docs-sync.mjs');
    const code = await checker.runCheck({ src, dst });
    process.exit(code);
  }

  if (!existsSync(dst)) {
    console.error(`[docs-sync] destination dir not found: ${dst}`);
    console.error(`[docs-sync] expected the sibling repo at ${dst}`);
    process.exit(1);
  }

  const written = await syncDocs({ src, dst });
  console.log(`[docs-sync] wrote ${written.length} file(s) to ${dst}`);
  for (const f of written) console.log(`  ${relative(REPO_ROOT, f)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
