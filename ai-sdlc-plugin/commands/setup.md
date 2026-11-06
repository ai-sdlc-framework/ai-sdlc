---
name: setup
description: First-run setup after installing the plugin. One idempotent command runs init, registers the MCP advisor and runs doctor, then reports what it did, skipped and could not do.
allowed-tools: Bash
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; fixed output; no free prose; no retries beyond the caller cap"
---

Run `ai-sdlc setup` and surface its report verbatim. All logic lives in
`orchestrator/src/cli/commands/setup.ts`. Re-running changes nothing that is
already present. No signing key is generated: RFC-0061 removed the keyring.

## Usage

```
/ai-sdlc setup
```

## Implementation contract

```bash
set -e

if [ -x "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" ]; then
  "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" setup
  exit $?
fi
if [ -f "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" setup
  exit $?
fi
if [ -f "$(pwd)/orchestrator/dist/cli/index.js" ]; then
  node "$(pwd)/orchestrator/dist/cli/index.js" setup
  exit $?
fi
if command -v npx >/dev/null 2>&1; then
  npx --no-install ai-sdlc setup && exit 0
fi

echo "ai-sdlc setup: could not locate the orchestrator CLI. Run \`ai-sdlc-plugin/scripts/install-runtime-deps.sh\` and retry." >&2
exit 1
```

The global `npm install -g @ai-sdlc/orchestrator` is not required: the plugin's
vendored orchestrator is used first.
