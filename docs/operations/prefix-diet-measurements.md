# Fixed-prefix diet measurements (AISDLC-651.2)

Every turn of every session re-reads the fixed prefix, so its size is paid on every turn. This page records the before/after size of each injected block.

## Method

`cli-usage context` (RFC-0050) reads real transcripts and needs a built `pipeline-cli/dist`, which a fresh worktree does not have, so the numbers below are measured directly on the injected text: characters of `CLAUDE.md`, of the `additionalContext` each hook emits for this repository's real `.ai-sdlc/agent-role.yaml` (the hook is run against the old and new script), and of the developer agent definition. Tokens are estimated at 4 characters per token. "Before" is `origin/main` at bde08122; "after" is this PR. Re-run `cli-usage context` on a fresh session and a fresh developer subagent after merge to confirm against transcripts.

## Per-block sizes

| Block | Before (chars) | After (chars) | Change |
|---|---:|---:|---:|
| `CLAUDE.md` | 64,944 | 14,847 | -77% |
| SessionStart governance block | 2,596 | 2,359 | -9% |
| SubagentStart governance block | 1,986 | 1,748 | -12% |
| `ai-sdlc-plugin/agents/developer.md` | 25,645 | 10,469 | -59% |

## First-call prefix

| Session | Before (chars / est. tokens) | After (chars / est. tokens) | Change |
|---|---:|---:|---:|
| Main session (`CLAUDE.md` + SessionStart block) | 67,540 / ~16.9k | 17,206 / ~4.3k | -75% |
| Developer subagent (`CLAUDE.md` + SubagentStart block + agent definition) | 92,575 / ~23.1k | 27,064 / ~6.8k | -71% |

The developer prefix drops by well over the required half. Over the median 62-turn developer run described in the task, the fixed prefix falls from about 1.4M to about 0.4M cache-read tokens.

## Where the content went

- `CLAUDE.md` reference material: [pre-push-and-ci-reference.md](./pre-push-and-ci-reference.md), [attestation-reference.md](./attestation-reference.md), [agent-governance-reference.md](./agent-governance-reference.md), [backlog-and-execution-reference.md](./backlog-and-execution-reference.md), [release-and-plugin-reference.md](./release-and-plugin-reference.md), [remote-agents-readonly.md](./remote-agents-readonly.md).
- Developer agent examples and history: [developer-agent-reference.md](./developer-agent-reference.md).
- "Never do X" rules: one source, see [prompt-rules.md](./prompt-rules.md).
