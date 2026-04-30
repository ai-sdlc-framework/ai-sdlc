---
name: version
description: Show installed vs latest ai-sdlc plugin version. Bypasses the 24h SessionStart cache.
allowed-tools: Bash
model: inherit
---

Show the installed ai-sdlc plugin version, the latest published version on
the marketplace, and whether the install is up to date. Bypasses the 24h
cache used by the SessionStart staleness nag (AISDLC-89) — every run
re-fetches `marketplace.json` from `main`.

## When to run this

- After you've ignored the SessionStart nag for a few sessions and want to
  re-check whether you're still behind.
- After running `/plugin update ai-sdlc && /reload-plugins`, to confirm the
  install actually advanced.
- When debugging "why doesn't `/<some-feature>` work?" — the answer is often
  that the plugin is older than the documented version.

## Output

```
ai-sdlc plugin
- Installed: v0.8.1
- Latest: v0.8.1
- Last checked: just now
- Status: ✓ up to date
```

When stale:

```
ai-sdlc plugin
- Installed: v0.7.0
- Latest: v0.8.1
- Last checked: just now
- Status: ⚠ stale — run /plugin update ai-sdlc && /reload-plugins
```

When the marketplace can't be reached:

```
ai-sdlc plugin
- Installed: v0.8.1
- Latest: unknown (fetch failed)
- Status: ? could not reach marketplace.json
```

## Implementation contract

Run the version-check hook in print mode and surface its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/check-plugin-version.js" --print
```

The hook respects `AI_SDLC_DISABLE_VERSION_CHECK=1` — if the operator has
opted out of the SessionStart nag, this command will print
`ai-sdlc plugin version check disabled (AI_SDLC_DISABLE_VERSION_CHECK=1)`
and exit. That's intentional — opt-out is opt-out across both surfaces.

## Notes

- This command never mutates the install. To actually update, run
  `/plugin update ai-sdlc && /reload-plugins`.
- `Last checked` reflects the cache freshness AFTER this command refreshes
  it — so it always says "just now" on a successful fetch.
- Network failures don't fail the command. They just report
  `Status: ? could not reach marketplace.json`.
