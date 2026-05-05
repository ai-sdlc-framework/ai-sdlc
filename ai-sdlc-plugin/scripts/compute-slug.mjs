#!/usr/bin/env node
/**
 * Compute the kebab-case slug from a backlog task file's YAML frontmatter
 * title. Self-contained — no js-yaml dependency, so the /ai-sdlc execute
 * slash command body can call this from any cwd without needing pnpm
 * install in the worktree.
 *
 * Handles every title form the backlog.md serializer produces:
 *   title: foo bar              (plain)
 *   title: 'foo bar'            (single-quoted)
 *   title: "foo bar"            (double-quoted)
 *   title: >-                   (folded block scalar — newlines → spaces)
 *     foo bar
 *     baz
 *   title: |-                   (literal block scalar — preserves newlines,
 *     foo bar                    treated same as folded for slug purposes)
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/compute-slug.mjs <task-file-path>
 *
 * Output: kebab-case slug to stdout (single line, no trailing JSON).
 *
 * Exit non-zero with message on stderr if:
 *   - file unreadable / no frontmatter
 *   - title key not found
 *   - title normalises to empty slug (per AISDLC-180 AC #2: fail loud,
 *     never silently emit empty)
 */

import { readFileSync } from 'node:fs';

const taskPath = process.argv[2];
if (!taskPath) {
  console.error('usage: compute-slug.mjs <task-file-path>');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(taskPath, 'utf8');
} catch (err) {
  console.error(`ERROR: cannot read ${taskPath}: ${err.message}`);
  process.exit(1);
}

const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  console.error(`ERROR: no YAML frontmatter (no leading --- delimiter) in ${taskPath}`);
  process.exit(1);
}
const frontmatter = fmMatch[1];

function readTitle(fm) {
  // Block scalar form: title: >- (or > | |- |+ etc.) followed by indented lines.
  // Indentation level isn't anchored — backlog.md uses 2-space indents but be
  // permissive on whitespace. Stop at the next top-level (non-indented) key.
  const block = fm.match(/^title:[ \t]+[>|][-+]?[ \t]*\n((?:[ \t]+[^\n]*\n?)+)/m);
  if (block) {
    return block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  // Inline form: title: foo | 'foo' | "foo".
  const inline = fm.match(/^title:[ \t]+(.+)$/m);
  if (inline) {
    let t = inline[1].trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }
    return t;
  }
  return null;
}

const title = readTitle(frontmatter);
if (!title) {
  console.error(`ERROR: no 'title:' key in frontmatter of ${taskPath}`);
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 50)
  .replace(/-+$/, ''); // re-strip if cut-50 left a dangling dash

if (!slug) {
  console.error(
    `ERROR: title '${title}' produces empty slug after normalization (no alphanumeric characters)`,
  );
  process.exit(1);
}

process.stdout.write(slug + '\n');
