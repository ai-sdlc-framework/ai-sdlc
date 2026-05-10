/**
 * AISDLC-254 lint-style guard: no hardcoded fixed-width dividers in TUI panes.
 *
 * Failure mode this catches: a TUI pane component renders
 * `<Text color="gray">─────────────────────────────</Text>` as a content
 * line. Fixed-character-count dividers don't match the parent Box's actual
 * rendered width, so:
 *   - Narrow pane → divider overflows the right border (visible at end of line)
 *   - Wide pane → divider looks truncated (a short stub instead of a line)
 *   - Either way → looks like the pane border is "broken"
 *
 * The 2026-05-10 incident: operator screenshot showed every pane in the TUI
 * with apparently-broken top borders because each pane rendered a 61-char `─`
 * line as the title underline regardless of the pane's actual width.
 *
 * Correct alternatives (use these instead of a hardcoded divider):
 *   - `<Box marginBottom={1}>` after the title — visual separation via whitespace
 *   - `<Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>...</Box>`
 *     — Ink-native horizontal divider that respects the parent's width
 *   - `<Text underline>{title}</Text>` — underlines the title text only
 *
 * What this test does NOT catch:
 *   - `=` or `*` dividers (extend the regex if those become a problem)
 *   - Dividers built up via dynamic `'─'.repeat(n)` (those CAN be width-aware
 *     when n is computed from the pane width — the issue is hardcoded counts)
 *   - Border style mistakes inside Ink's `borderStyle` prop (those use a
 *     different rendering path)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const TUI_DIR = resolve(__dirname, '..');

/** Files under tui/ that are allowed to contain a fixed-width `─` line. */
const ALLOWLIST = new Set<string>([
  // This test file itself describes the pattern in its comments and may
  // include literal `─` in the docstring — it isn't rendered by Ink.
  'no-fixed-dividers.test.ts',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('TUI lint — no fixed-width `─` dividers (AISDLC-254)', () => {
  it('rejects every <Text>─────...</Text> with a hardcoded character count', () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    // Match a Text element whose content is purely 5+ box-drawing horizontal
    // characters. This catches the AISDLC-254 incident pattern without
    // false-positiving on TS comment headers (// ── Section ──) or on
    // dynamic dividers built from `'─'.repeat(width)`.
    const PATTERN = /<Text[^>]*>─{5,}<\/Text>/;
    for (const file of walk(TUI_DIR)) {
      const base = file.split('/').pop()!;
      if (ALLOWLIST.has(base)) continue;
      const content = readFileSync(file, 'utf8');
      content.split('\n').forEach((line, i) => {
        if (PATTERN.test(line)) {
          offenders.push({ file, line: i + 1, snippet: line.trim().slice(0, 100) });
        }
      });
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
        .join('\n');
      throw new Error(
        `AISDLC-254: ${offenders.length} hardcoded fixed-width <Text>─...</Text> divider(s) ` +
          `found. Replace with marginBottom whitespace or Ink-native borderTop. ` +
          `See no-fixed-dividers.test.ts docstring for guidance.\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
