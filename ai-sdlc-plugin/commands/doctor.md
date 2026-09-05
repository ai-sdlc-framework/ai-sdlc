---
name: doctor
description: Audit this project's ai-sdlc configuration health — plugin/pin versions, manifest agreement, attestation governance, and more. Read-only by default; --fix applies the safe/mechanical subset.
allowed-tools: Bash
model: inherit
---

Run `ai-sdlc doctor` — the config-health audit described in
[`docs/operations/doctor.md`](../../docs/operations/doctor.md) — and surface
its output verbatim. This is a thin wrapper: all logic lives in the
`orchestrator` package's `doctor` command (`orchestrator/src/cli/commands/doctor.ts`
+ `doctor-checks.ts`).

## Usage

```
/ai-sdlc doctor
/ai-sdlc doctor --fix
/ai-sdlc doctor --strict
```

Pass any trailing arguments straight through to the `ai-sdlc doctor` CLI
(`--fix`, `--strict`, `-f json` / `-f minimal`).

## Implementation contract

Resolve the `ai-sdlc` CLI binary in this order and run the first one found,
forwarding `$ARGUMENTS`:

```bash
set -e

# 1. Plugin's own vendored install (marketplace/npm install topology).
if [ -x "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" ]; then
  "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" doctor $ARGUMENTS
  exit $?
fi
if [ -f "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" doctor $ARGUMENTS
  exit $?
fi

# 2. Dogfood monorepo (this repo checked out directly).
if [ -f "$(pwd)/orchestrator/dist/cli/index.js" ]; then
  node "$(pwd)/orchestrator/dist/cli/index.js" doctor $ARGUMENTS
  exit $?
fi

# 3. Last resort — npx without triggering an install prompt.
if command -v npx >/dev/null 2>&1; then
  npx --no-install ai-sdlc doctor $ARGUMENTS && exit 0
fi

echo "ai-sdlc doctor: could not locate the orchestrator CLI. Run \`ai-sdlc-plugin/scripts/install-runtime-deps.sh\` (or, in the dogfood monorepo, \`pnpm --filter @ai-sdlc/orchestrator build\`) and retry." >&2
exit 1
```

## When to run this

- After `ai-sdlc init`, to confirm the scaffold landed cleanly.
- Periodically, to catch config drift (plugin/pin staleness, manifest
  disagreement, attestation misconfiguration) before it causes a silent
  failure — see the AISDLC-578 motivation in `docs/operations/doctor.md`.
- Before filing a bug report against ai-sdlc itself — most "it's not
  working" reports trace back to a `doctor`-detectable misconfiguration.

## Output

See `docs/operations/doctor.md` for the full check catalog, the `--fix`
contract, and the exit-code rules. In short: pass/warn/fail per check with
a one-line remediation; exits non-zero on any `fail` (0 on warn-only,
unless `--strict`).
