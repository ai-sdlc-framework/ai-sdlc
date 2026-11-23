#!/usr/bin/env node
// AISDLC-987: the spec/rfcs/README.md Registry is a view over RFC frontmatter.
// Default: fail on a missing row or a Status or Lifecycle cell that differs from the file.
// --write: add missing rows and rewrite stale Status/Lifecycle cells in place.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// First `**Status:**` body line, without the marker; null when the RFC has none.
export function bodyStatusOf(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---/, '');
  const m = body.match(/^\*\*Status:\*\*[ \t]*(.*)$/m);
  return m ? m[1].trim() : null;
}

// RFCs whose body Status line disagrees and is left for the operator (AISDLC-1317).
// An entry that no longer fails is an error, so the list only shrinks.
export const BODY_STATUS_KNOWN = new Set(['0017', '0036', '0051']);

export function checkBodyStatus(rfcs, known = BODY_STATUS_KNOWN) {
  const problems = [];
  const failing = new Set();
  for (const r of rfcs) {
    if (r.bodyStatus == null) continue;
    if (r.bodyStatus.startsWith(r.lifecycle) || r.bodyStatus.startsWith(r.status)) continue;
    failing.add(r.num);
    if (!known.has(r.num)) problems.push({ kind: 'body', rfc: r });
  }
  for (const n of known) if (!failing.has(n)) problems.push({ kind: 'known-stale', num: n });
  return problems;
}

export function loadRfcs(dir) {
  return readdirSync(dir)
    .filter((f) => /^RFC-\d{4}-.*\.md$/.test(f) && !f.startsWith('RFC-0001-')) // template is exempt
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      const fm = frontmatter(text);
      return {
        num: file.slice(4, 8),
        file,
        title: fm.title ?? file,
        status: fm.status ?? '',
        lifecycle: fm.lifecycle ?? fm.status ?? '',
        author: fm.author ?? '—',
        bodyStatus: bodyStatusOf(text),
      };
    });
}

const rowNum = (line) => line.match(/^\| (\d{4}) /)?.[1];
const cells = (line) => line.split('|');

export function checkRegistry(readme, rfcs) {
  const lines = readme.split('\n');
  const problems = [];
  for (const r of rfcs) {
    const idx = lines.findIndex((l) => rowNum(l) === r.num && l.includes(`](${r.file})`));
    if (idx < 0) {
      problems.push({ kind: 'missing', rfc: r });
      continue;
    }
    const statusCell = cells(lines[idx])[3]?.trim();
    if (statusCell !== r.status) {
      problems.push({ kind: 'status', rfc: r, idx, current: statusCell });
    }
    const current = cells(lines[idx])[4]?.trim();
    if (current !== r.lifecycle) {
      problems.push({ kind: 'stale', rfc: r, idx, current });
    }
  }
  return { lines, problems };
}

export function applyFixes(lines, problems) {
  const out = [...lines];
  for (const p of problems.filter((x) => x.kind === 'stale')) {
    const c = cells(out[p.idx]);
    c[4] = ` ${p.rfc.lifecycle} `;
    out[p.idx] = c.join('|');
  }
  for (const p of problems.filter((x) => x.kind === 'status')) {
    const c = cells(out[p.idx]);
    c[3] = ` ${p.rfc.status} `;
    out[p.idx] = c.join('|');
  }
  for (const p of problems.filter((x) => x.kind === 'missing')) {
    const r = p.rfc;
    const row = `| ${r.num} | ${r.title} | ${r.status} | ${r.lifecycle} | — | ${r.author} | [${r.file}](${r.file}) | Row backfilled by scripts/check-rfc-registry.mjs. |`;
    let at = -1;
    out.forEach((l, i) => {
      const n = rowNum(l);
      if (n && n < r.num) at = i;
    });
    out.splice(at + 1, 0, row);
  }
  return out;
}

function main() {
  const dir = join(ROOT, 'spec/rfcs');
  const path = join(dir, 'README.md');
  const readme = readFileSync(path, 'utf8');
  const rfcs = loadRfcs(dir);
  const { lines, problems } = checkRegistry(readme, rfcs);
  const bodyProblems = checkBodyStatus(rfcs);
  if (process.argv.includes('--write')) {
    writeFileSync(path, applyFixes(lines, problems).join('\n'));
    console.log(`check-rfc-registry: fixed ${problems.length} row(s)`);
    return;
  }
  for (const p of problems) {
    console.error(
      p.kind === 'missing'
        ? `RFC-${p.rfc.num}: no Registry row linking ${p.rfc.file}`
        : p.kind === 'status'
          ? `RFC-${p.rfc.num}: Registry status "${p.current}" != frontmatter "${p.rfc.status}"`
          : `RFC-${p.rfc.num}: Registry lifecycle "${p.current}" != frontmatter "${p.rfc.lifecycle}"`,
    );
  }
  for (const p of bodyProblems) {
    console.error(
      p.kind === 'body'
        ? `RFC-${p.rfc.num}: body Status line "${p.rfc.bodyStatus.slice(0, 60)}" starts with neither lifecycle "${p.rfc.lifecycle}" nor status "${p.rfc.status}"`
        : `RFC-${p.num}: listed in BODY_STATUS_KNOWN but its body Status line no longer fails; remove the entry`,
    );
  }
  if (problems.length) console.error('Run: node scripts/check-rfc-registry.mjs --write');
  if (problems.length || bodyProblems.length) process.exit(1);
  console.log('check-rfc-registry: Registry matches RFC frontmatter');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
