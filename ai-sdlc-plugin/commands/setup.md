---
name: setup
description: First-run setup after installing the plugin. Asks once whether agents may merge, then one idempotent command runs init, registers the MCP advisor and runs doctor, and reports what it did, skipped and could not do.
argument-hint: '[--agent-merge yes|no]'
allowed-tools: Bash, AskUserQuestion
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; one fixed yes/no question; fixed output; no free prose; no retries beyond the caller cap"
---

Run `ai-sdlc setup --agent-merge <yes|no>` and surface its report verbatim. All
logic lives in `orchestrator/src/cli/commands/setup.ts`. Re-running changes
nothing that is already present. No signing key is generated: RFC-0061 removed
the keyring.

## Usage

```
/ai-sdlc setup
/ai-sdlc setup --agent-merge yes
```

## The one question (AISDLC-1384, DEC-0424, DEC-0425)

If `$ARGUMENTS` already holds `--agent-merge yes` or `--agent-merge no`, use it
and do not ask. If `.ai-sdlc/agent-role.yaml` already exists, do not ask either:
setup never changes an existing merge block, and the report prints its current
values. Otherwise ask exactly once, with AskUserQuestion, before running setup,
with the header `Agent merge` and exactly this question text, on one line:

> Let agents merge pull requests that pass every gate (green checks, clean merge state, review verdict)?

The question evidence gate (AISDLC-1452) passes this one fixed question without
an evidence ledger only on that exact header and text; any other wording is
refused.

Options: `yes` and `no`. Pass the answer as `AGENT_MERGE=yes` or `AGENT_MERGE=no`.
When there is no answer (a non-interactive run, or the question is dismissed),
leave `AGENT_MERGE` empty: init then writes `allowMerge: never`.

- **yes**: init writes `allowMerge: onGreenClean`, your `gh` login as the only
  `mergeAuthors` entry and `land-eligible-prs` in `operational`; branch
  protection requires 0 approving reviews, because the verdict gate
  `ai-sdlc/pr-ready` is the review control. If the `gh` login cannot be read,
  init writes `never` and prints why.
- **no**: init writes `allowMerge: never` with empty lists; branch protection
  requires 1 approving review (you cannot approve your own pull requests).

The report's "Merge settings" section prints both values with the reason. A
team may raise the review count.

## Implementation contract

```bash
set -e

AGENT_MERGE="${AGENT_MERGE:-}"
ARGS=(setup)
if [ -n "$AGENT_MERGE" ]; then ARGS+=(--agent-merge "$AGENT_MERGE"); fi

if [ -x "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" ]; then
  "${CLAUDE_PLUGIN_ROOT}/node_modules/.bin/ai-sdlc" "${ARGS[@]}"
  exit $?
fi
if [ -f "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/orchestrator/dist/cli/index.js" "${ARGS[@]}"
  exit $?
fi
if [ -f "$(pwd)/orchestrator/dist/cli/index.js" ]; then
  node "$(pwd)/orchestrator/dist/cli/index.js" "${ARGS[@]}"
  exit $?
fi
if command -v npx >/dev/null 2>&1; then
  npx --no-install ai-sdlc "${ARGS[@]}" && exit 0
fi

echo "ai-sdlc setup: could not locate the orchestrator CLI. Run \`ai-sdlc-plugin/scripts/install-runtime-deps.sh\` and retry." >&2
exit 1
```

The global `npm install -g @ai-sdlc/orchestrator` is not required: the plugin's
vendored orchestrator is used first.
