# Context meter mod (planner session)

A Claude Code mod that draws a live band above the prompt with the session's context size,
a colour-stepped bar, token totals, and one-confirmation actions to compact, clear, or hand
off then clear. It lives at `ai-sdlc-plugin/mods/context-meter/` (task AISDLC-743). It is
read-only until you press an action; it never clears on its own. For the planner role that
runs the [session hierarchy](cli-hierarchy.md).

## Enable it for the planner session

Run the planner with the mod folder loaded (terminal or the desktop Code tab's local session):

```bash
claude --plugin-dir ai-sdlc-plugin/mods/context-meter
# or: CLAUDE_CODE_PLUGIN_DIRS=ai-sdlc-plugin/mods/context-meter claude
```

A folder given this way hot-reloads while you edit it; run `/reload-plugins` after changes
if the band does not update. Validate with `claude plugin validate ai-sdlc-plugin/mods/context-meter`.
The pure logic is tested by `pnpm test:context-meter` (part of `pnpm test`).

## What each element means

- **`ctx 142k / 1.00M (14.2%) [bar]`**: the last response's input side (uncached + cache
  write + cache read) against the model's window, as `$.session.usage().context` reports it.
  The bar fills toward the red level. Green below 10%, amber from 10%, amber with
  "hand off soon" from 13%, red with "clear now" from 15% (15% of a 1M window is the 150k
  ceiling).
- **`session in / cache-write / cache-read / out`**: totals summed from each completed turn's
  usage (`turn.complete`). They count from when the mod loaded (a hot reload or `/clear`
  restarts them) and cover main-thread turns the mod saw.
- **`weight ~N input-eq`**: an approximate cost weight in input-token equivalents using list
  price ratios (cache write 1.25x, cache read 0.1x, output 5x). A relative gauge, not
  dollars. When the host keeps a cost ledger the band also shows its figure (`$x.xx`).
- **Actions**: `Compact` runs `/compact`, `Clear` runs `/clear`, `Hand off + clear` asks the
  session to write its dated handoff memory file, then runs `/clear` only when that
  handoff prompt's own turn ends with an answer (an earlier in-flight turn finishing, or a
  handoff turn that is aborted or errors, never clears). A failed action shows a one-line
  note in the band; a pending confirmation is dropped at the next turn end or `/clear`. Each asks once inline in the band (`Run /clear? Yes / Cancel`), never a
  modal prompt.

## Thresholds

Set in the mod's config (`/config`, or settings `pluginConfigs`): `amberAtPercent` (10),
`hotAtPercent` (13), `redAtPercent` (15). Defaults live in one place,
`DEFAULT_THRESHOLDS` in `hooks/meter.ts`. An invalid field falls back to its own default; if the resulting trio is not ordered
`amber <= hot <= red`, all overrides are discarded (all-or-nothing).

## Degradation

If the host exposes no context figures (no response yet in a fresh or just-compacted
session, or `$.session.usage()` fails), the band draws nothing and raises no error; it
returns once a response arrives. The cache-write/cache-read split comes from per-turn usage,
so the totals show zero until the first turn completes after the mod loads.
