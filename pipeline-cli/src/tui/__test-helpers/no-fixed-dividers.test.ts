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

describe('TUI lint — no fixed-width char-art dividers (AISDLC-254)', () => {
  // Reviewer feedback: extend coverage beyond `<Text>───</Text>` literal form.
  //
  // Patterns rejected (whitespace-tolerant, multi-line via dotAll):
  //   - <Text ...>─────...</Text>                    [original literal form]
  //   - <Text ...>{'─────...'}</Text>                [JSX expr with string literal]
  //   - <Text ...>{"─────..."}</Text>                [double-quoted variant]
  //   - <Text ...>{`─────...`}</Text>                [template literal]
  //   - <Text ...>{'─'.repeat(60)}</Text>            [hardcoded count via repeat]
  //   - same for `=`, `*`, `_`, `━`, `═` char-art (other overflow-prone divider chars)
  //
  // Patterns allowed (intentional dynamic / width-aware):
  //   - <Text>{'─'.repeat(width)}</Text>             [width is computed]
  //   - <Text>{'─'.repeat(termCols - 4)}</Text>      [responsive]
  //   - // ── Section ──                              [TS comment header, NOT inside <Text>]
  //
  // The walk is full-file with the `s` (dotAll) flag, so newlines between
  // <Text ...> and the divider content don't defeat detection.

  const DIVIDER_CHARS = '─━═*=_';
  const FIXED_LIT = `[${DIVIDER_CHARS}]{5,}`;
  const REPEAT_FIXED = `['"\`][${DIVIDER_CHARS}]['"\`]\\.repeat\\(\\s*\\d+\\s*\\)`;
  const PATTERNS: Array<{ name: string; re: RegExp }> = [
    {
      name: 'literal-text-content',
      re: new RegExp(`<Text[^>]*>\\s*${FIXED_LIT}\\s*</Text>`, 's'),
    },
    {
      name: 'jsx-string-expression',
      re: new RegExp(`<Text[^>]*>\\s*\\{\\s*['"\`]${FIXED_LIT}['"\`]\\s*\\}\\s*</Text>`, 's'),
    },
    {
      name: 'jsx-repeat-fixed-count',
      re: new RegExp(`<Text[^>]*>\\s*\\{\\s*${REPEAT_FIXED}\\s*\\}\\s*</Text>`, 's'),
    },
  ];

  it('rejects every fixed-width char-art divider variant', () => {
    const offenders: Array<{ file: string; pattern: string; snippet: string }> = [];
    for (const file of walk(TUI_DIR)) {
      const base = file.split('/').pop()!;
      if (ALLOWLIST.has(base)) continue;
      const content = readFileSync(file, 'utf8');
      for (const { name, re } of PATTERNS) {
        // Use a global form of the regex to find every occurrence + capture
        // a snippet for the failure message.
        const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `g${re.flags}`);
        let match: RegExpExecArray | null;
        while ((match = globalRe.exec(content)) !== null) {
          offenders.push({
            file,
            pattern: name,
            snippet: match[0].replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  [${o.pattern}] ${o.file}\n    ${o.snippet}`)
        .join('\n');
      throw new Error(
        `AISDLC-254: ${offenders.length} hardcoded fixed-width char-art divider(s) ` +
          `found. Replace with marginBottom whitespace or Ink-native borderTop. ` +
          `Width-aware forms (e.g. \`'─'.repeat(width)\` where width is computed) are fine. ` +
          `See no-fixed-dividers.test.ts docstring for guidance.\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
