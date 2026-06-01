# Reviewer dispatch defaults (AISDLC-483)

> **TL;DR:** Code and test review default to Codex (zero Claude tokens). Security review stays on Claude-native opus. Developer dispatch stays on Claude-native sonnet. Override all reviewer roles with `AI_SDLC_REVIEWER_HARNESS=claude`.

## Default routing by role

| Role | Default agent | Harness | Model | Cost |
|---|---|---|---|---|
| code-review | `code-reviewer-codex` | Codex | inherit (Codex plan) | Zero Claude tokens |
| test-review | `test-reviewer-codex` | Codex | inherit (Codex plan) | Zero Claude tokens |
| security | `security-reviewer` | Claude-native | opus | ~3x sonnet rate |
| developer | `developer` | Claude-native | sonnet | ~1x rate |

## Rationale

A 2026-05-30 cost incident traced 26% of weekly Claude usage to a single session where all subagents inherited the operator's Opus 4.8 model. AISDLC-482 (companion task) pinned agent frontmatter defaults; AISDLC-483 hardens the dispatch paths so even ad-hoc `Agent(...)` calls or manual `/ai-sdlc execute` invocations route to the cheap path by default.

**Why Codex for code/test review?** Codex CLI (`/opt/homebrew/bin/codex`) runs under Codex plan billing — zero Claude API tokens consumed. For the bulk of mechanical review work (checking conventions, test coverage, diff correctness), Codex quality is sufficient and the cost is the same regardless of PR size.

**Why claude-native opus for security?** Security review is reasoning-heavy, adversarial-pattern recognition work that Codex does not handle as reliably as Claude (opus in particular). The higher cost is justified for the one role where model quality directly affects trust decisions.

**Why sonnet for developer?** Developer dispatch is the highest-volume role (one per task). Sonnet is 5x cheaper than opus and handles mechanical implementation tasks well. The `developer` agent frontmatter already pins `model: sonnet`; the dispatch path does not override this.

## How to override

### Force Claude-native for all reviewers

Set the env var before invoking `/ai-sdlc execute` or `/ai-sdlc orchestrator-tick`:

```bash
export AI_SDLC_REVIEWER_HARNESS=claude
/ai-sdlc execute AISDLC-NNN
```

When `AI_SDLC_REVIEWER_HARNESS=claude`:
- code-review → `code-reviewer` (claude-native, sonnet)
- test-review → `test-reviewer` (claude-native, sonnet)
- security → `security-reviewer` (unchanged — always claude-native opus)
- developer → `developer` (unchanged — always claude-native sonnet)

Use this when:
- Codex CLI is not installed (`which codex` returns nothing).
- The team has disabled Codex for compliance or budget reasons.
- You want a fully Claude-native review for an audit or comparison.

### Override per invocation (shell one-liner)

```bash
AI_SDLC_REVIEWER_HARNESS=claude /ai-sdlc execute AISDLC-NNN
```

### Override developer model per invocation

The developer agent frontmatter pins `model: sonnet`. To use a different model for a single dispatch (e.g. opus for a particularly complex task), set `AI_SDLC_DEV_MODEL=opus` — the `orchestrator-tick` command body forwards this as a per-invocation hint in the developer prompt. (Not enforced by the dispatch layer; the agent honors it if present.)

## Programmatic access

The selection logic lives in `pipeline-cli/src/dispatch/reviewer-harness.ts` and is exported from `@ai-sdlc/pipeline-cli`:

```typescript
import { resolveReviewer, resolveReviewerByClassifierName } from '@ai-sdlc/pipeline-cli';

// By role:
const { agentName, harness, model } = resolveReviewer('code');
// → { agentName: 'code-reviewer-codex', harness: 'codex', model: 'inherit' }

// By classifier name (used in /ai-sdlc execute Step 7):
const result = resolveReviewerByClassifierName('critic');
// → { agentName: 'code-reviewer-codex', harness: 'codex', model: 'inherit' }

// With override:
const claudeResult = resolveReviewer('code', 'claude');
// → { agentName: 'code-reviewer', harness: 'claude-code', model: 'sonnet' }
```

## Cost examples

| Scenario | Code/test agents | Security | Per-PR savings |
|---|---|---|---|
| Default (Codex) | `*-codex` (zero tokens) | claude opus | ~40-60% vs. all-sonnet |
| `AI_SDLC_REVIEWER_HARNESS=claude` | `code-reviewer`, `test-reviewer` (sonnet) | claude opus | — |
| Pre-AISDLC-483 (inherited opus) | `code-reviewer` (opus) | `security-reviewer` (opus) | — |

The savings vary by PR size and model pricing. On a typical 200-line diff, routing code+test to Codex eliminates ~4M tokens/month at the current autonomous drain rate.

## Codex CLI requirement

The Codex-variant agents require `codex` on PATH. Confirm with:

```bash
which codex       # should print /opt/homebrew/bin/codex
codex --version   # should print v0.128.0 or later
```

If `codex` is absent, the pipeline will attempt to dispatch `code-reviewer-codex` / `test-reviewer-codex` — these agents detect the absence and return an error verdict. To avoid that, either install Codex or set `AI_SDLC_REVIEWER_HARNESS=claude` globally.

See also: `docs/operations/codex-execution-path.md` for Codex CLI installation + configuration.
