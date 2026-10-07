import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';

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
