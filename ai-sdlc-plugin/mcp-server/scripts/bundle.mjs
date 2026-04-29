#!/usr/bin/env node
/**
 * Bundle the MCP server into a single self-contained ESM file.
 *
 * Why this exists:
 *   The plugin manifest (`ai-sdlc-plugin/plugin.json`) loads the MCP server via
 *   `node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/bin.js`. When the marketplace
 *   clones the plugin source it does NOT run `pnpm install`, so `node_modules/`
 *   is absent. A plain `tsc` build emits ESM imports that resolve at runtime
 *   against `node_modules` — which fails silently in the marketplace clone and
 *   leaves SessionStart, PreToolUse, PostToolUse hooks plus every
 *   `/ai-sdlc:*` MCP tool returning skill text only (AISDLC-75).
 *
 *   Esbuild rolls every runtime dep (`@modelcontextprotocol/sdk`, `zod`, etc.)
 *   into one file so `node dist/bin.js` works with zero installed packages.
 *   We commit the bundled artifact (see .gitignore exception) and CI gates
 *   that the committed bundle is fresh + still self-contained.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, '..');

// `createRequire` shim lets bundled CJS dependencies (which use `require()`)
// keep working under our ESM output format. Esbuild auto-emits the
// `#!/usr/bin/env node` shebang from `src/bin.ts` itself, so the banner only
// needs the ESM/CJS interop line.
const banner = [
  "import { createRequire as __ai_sdlc_createRequire } from 'node:module';",
  'const require = __ai_sdlc_createRequire(import.meta.url);',
].join('\n');

const result = await build({
  entryPoints: [resolve(pkgRoot, 'src/bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: resolve(pkgRoot, 'dist/bin.js'),
  // Bundle every dep — nothing left to resolve at runtime.
  packages: 'bundle',
  // Node built-ins MUST stay external.
  external: ['node:*'],
  banner: { js: banner },
  legalComments: 'none',
  logLevel: 'info',
  metafile: false,
});

if (result.errors.length > 0) {
  for (const err of result.errors) console.error(err);
  process.exit(1);
}
