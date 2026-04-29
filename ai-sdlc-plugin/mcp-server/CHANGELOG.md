# @ai-sdlc/plugin-mcp-server

## Unreleased

### Bug Fixes

- **AISDLC-75: bundle MCP server with esbuild and commit `dist/bin.js`.** The
  plugin manifest loads `mcp-server/dist/bin.js` at runtime, but the marketplace
  clones the plugin source without running `pnpm install` — so the previous
  setup left both `dist/` and `node_modules/` missing in cached installs. Every
  governance hook (SessionStart, PreToolUse, PostToolUse) and every
  `/ai-sdlc:*` MCP tool silently fell back to skill text only. Fixed by:
  - Adding an esbuild bundler step (`scripts/bundle.mjs`) that inlines
    `@modelcontextprotocol/sdk`, `zod`, and all other runtime deps into a
    single self-contained ESM file.
  - Un-ignoring `ai-sdlc-plugin/mcp-server/dist/bin.js` in `.gitignore` so the
    bundled artifact ships in source clones (sourcemaps, type declarations,
    and other dist files stay ignored).
  - Adding `scripts/verify-bundle.mjs` plus a `Verify MCP Bundle` GitHub
    workflow that gates four invariants on every PR: bundle exists, parses as
    ESM, runs and responds to MCP `initialize` with no `node_modules/`, and
    matches a clean rebuild byte-for-byte (catches stale bundles).
  - Bumping the declared `zod` range from `^3.23.0` to `^3.25.76` to match the
    `@modelcontextprotocol/sdk@^1.26.0` peer requirement (`zod ^3.25 || ^4.0`).
