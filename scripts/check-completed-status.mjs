#!/usr/bin/env node
// AISDLC-987: a file under backlog/completed/ is done by location, so its
// frontmatter status must be Done, Withdrawn or Superseded.
// --write rewrites the status line of offenders to Done.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ALLOWED = ['Done', 'Withdrawn', 'Superseded'];
const STATUS_RE = /^status:[ \t]*(.*)$/m;

export function statusOf(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  return (
    fm[1]
      .match(STATUS_RE)?.[1]
      .replace(/^["']|["']$/g, '')
      .trim() ?? null
  );
}

export function fixStatus(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return text;
  return text.replace(fm[1], fm[1].replace(STATUS_RE, 'status: Done'));
}

function main() {
  const dir = join(ROOT, 'backlog/completed');
  const write = process.argv.includes('--write');
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const s = statusOf(text);
    if (s !== null && ALLOWED.includes(s)) continue;
    bad.push(`${f}: status "${s}"`);
    if (write && s !== null) writeFileSync(join(dir, f), fixStatus(text));
  }
  if (write) return console.log(`check-completed-status: fixed ${bad.length} file(s)`);
  if (bad.length) {
    console.error(bad.join('\n'));
    console.error(`${bad.length} completed task(s) not in ${ALLOWED.join('/')}. Run --write.`);
    process.exit(1);
  }
  console.log('check-completed-status: all completed tasks have a terminal status');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
