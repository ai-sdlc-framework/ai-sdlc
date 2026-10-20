import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import { DOCS_ACTIONS, DOCS_DOR_ACTION, TASK_ACTIONS } from './reconcile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(here, '../../../docs/operations/cli-hierarchy.md');

/** Capture what `cli-hierarchy --help` prints. */
async function helpText(): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    expect(await runHierarchyCli(['--help'])).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

/** Subcommands: the lines under `Commands:` in the help text. */
export function parseCommands(help: string): string[] {
  const out: string[] = [];
  let inCommands = false;
  for (const line of help.split('\n')) {
    if (line.startsWith('Commands:')) {
      inCommands = true;
      continue;
    }
    if (inCommands) {
      const m = /^ {2}([a-z][a-z-]*)\s{2,}\S/.exec(line);
      if (m) out.push(m[1] as string);
      else if (line.trim() === '') break;
    }
  }
  return out;
}

/** Every `--option` token the help text mentions. */
export function parseOptions(help: string): string[] {
  return [...new Set([...help.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
}

describe('cli-hierarchy reference page parity (AISDLC-664.1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the commands and options from the real --help output', async () => {
    const help = await helpText();
    expect(parseCommands(help).length).toBeGreaterThanOrEqual(11);
    expect(parseOptions(help)).toContain('--executors');
  });

  it('documents every subcommand the CLI lists', async () => {
    const page = readFileSync(PAGE, 'utf-8');
    const missing = parseCommands(await helpText()).filter(
      (c) => !page.includes(`### \`${c}\``) || !page.includes(`cli-hierarchy ${c}`),
    );
    expect(missing, `docs/operations/cli-hierarchy.md lacks a section for: ${missing}`).toEqual([]);
  });

  it('mentions every option the CLI help lists', async () => {
    const page = readFileSync(PAGE, 'utf-8');
    const missing = parseOptions(await helpText()).filter((o) => !page.includes(o));
    expect(missing, `docs/operations/cli-hierarchy.md never mentions: ${missing}`).toEqual([]);
  });
});

/** The action names (second column) of the table under a bold heading line. */
export function tableActions(page: string, heading: string): string[] {
  const start = page.indexOf(heading);
  if (start < 0) return [];
  const out: string[] = [];
  let inTable = false;
  for (const line of page.slice(start).split('\n').slice(1)) {
    if (line.startsWith('|')) {
      inTable = true;
      const cell = line.split('|')[2] ?? '';
      const m = /^\s*`([a-z][a-z-]*)`\s*$/.exec(cell);
      if (m) out.push(m[1] as string);
    } else if (inTable) break;
  }
  return out;
}

describe('cli-hierarchy action tables match reconcile.ts (AISDLC-983)', () => {
  const page = readFileSync(PAGE, 'utf-8');

  it('names only task actions that TASK_ACTIONS defines, and all of them', () => {
    const doc = tableActions(page, '**Task action set**');
    const code = new Set(Object.values(TASK_ACTIONS));
    expect(doc.filter((a) => !code.has(a))).toEqual([]);
    expect([...code].filter((a) => !doc.includes(a))).toEqual([]);
  });

  it('names only docs actions that DOCS_ACTIONS or the DoR action define', () => {
    const doc = tableActions(page, '**Docs action set**');
    const code = new Set([...Object.values(DOCS_ACTIONS), DOCS_DOR_ACTION]);
    expect(doc.length).toBeGreaterThan(0);
    expect(doc.filter((a) => !code.has(a))).toEqual([]);
    expect([...code].filter((a) => a !== 'none' && !doc.includes(a))).toEqual([]);
  });
});
