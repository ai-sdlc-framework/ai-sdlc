/**
 * Ratchet (RFC-0058 phase 4, AISDLC-1037): `tmux send-keys` is confined to the two
 * remaining call sites. The list only shrinks; a new site fails this test.
 *   - tmux.ts `sendExit` (down/restart ask a session to exit)
 *   - brief-notify.ts (`brief --notify` types a line into the dispatch pane)
 * clear.ts, the pane-text idle detection and the detached keystroke script are gone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(['tmux.ts', 'brief-notify.ts']);

describe('send-keys ratchet', () => {
  it('only the allowlisted hierarchy sources invoke send-keys', () => {
    const offenders = readdirSync(here)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(join(here, f), 'utf8').includes("'send-keys'"))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });

  it('clear.ts holds no key sending and no pane-text reads', () => {
    const src = readFileSync(join(here, 'clear.ts'), 'utf8');
    expect(src).not.toMatch(/send-keys|capture-pane|paneTail/);
  });
});
