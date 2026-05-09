# Cross-Harness Review Runbook

**Status:** Operational (AISDLC-247)

**Audience:** AI-SDLC pipeline operators configuring the bidirectional Claude ↔ Codex review convention.

---

## The Bidirectional Convention

The operator's design (2026-05-09):

> "Claude Code develops, Codex reviews — and Codex develops, Claude Code reviews. If we can do both workflows simultaneously, we get lots of throughput."

Two reviewer variants exist for `code-reviewer` and `test-reviewer`:

| Agent | Harness | Best used when developer is... |
|-------|---------|-------------------------------|
| `code-reviewer` | `claude-code` | Codex (cross-harness independence) |
| `test-reviewer` | `claude-code` | Codex (cross-harness independence) |
| `code-reviewer-codex` | `codex` | Claude Code (cross-harness independence) |
| `test-reviewer-codex` | `codex` | Claude Code (cross-harness independence) |

**Why cross-harness?** Reviewer independence from the developer harness means the reviewer cannot be biased by the same model's idiosyncratic blind spots. A Claude-developed PR reviewed by Codex gets a genuinely different perspective at no additional orchestration cost.

**Security stays on Claude.** `security-reviewer` uses Claude Opus per `feedback_subagent_model_selection.md`. Codex's `o4-mini` is fast but its security-reasoning depth is not yet validated for OWASP-class findings. Do not create a `security-reviewer-codex` until this validation is done.

---

## When to Use Which Variant

### Default: Claude Code pipeline (`/ai-sdlc execute`)

The `/ai-sdlc execute` Step 7b spawns `code-reviewer`, `test-reviewer`, `security-reviewer` (all Claude variants). No operator action required — this is the default.

### Codex-developed PRs (Codex → Claude review)

When a task runs on Codex (via `--spawner codex` in `ai-sdlc-pipeline execute`), the developer is Codex. The reviewers should be Claude variants (the defaults). No change needed — `code-reviewer` and `test-reviewer` are always Claude unless explicitly overridden.

### Claude-developed PRs requiring Codex review (Claude → Codex review)

Spawn the Codex variants explicitly in the slash command body:

```
Agent(subagent_type='ai-sdlc:code-reviewer-codex')
Agent(subagent_type='ai-sdlc:test-reviewer-codex')
```

Or modify the `/ai-sdlc execute` Step 7b selection logic to prefer the `-codex` suffix when Codex is available. The execute command's harness-detection block already checks `which codex`:

```bash
if which codex >/dev/null 2>&1; then
  # Codex is available — optionally prefer Codex reviewers for cross-harness independence
  REVIEWER_SUFFIX="-codex"
else
  REVIEWER_SUFFIX=""
fi
```

### Both directions simultaneously

Fan out with `/loop /ai-sdlc execute <task-id>` — each invocation gets its own worktree + pipeline. One loop can run with Claude reviewers, another with Codex reviewers. Step 8's verdict aggregation is harness-agnostic: it reads `approved` and `findings` from both envelopes without caring which harness produced them.

---

## Cost and Latency Comparison

| Variant | Model | Latency (typical) | Cost (per review) |
|---------|-------|-------------------|-------------------|
| `code-reviewer` (Claude) | Sonnet 4 (inherit) | 30–90 s | ~$0.01–0.05 |
| `test-reviewer` (Claude) | Sonnet 4 (inherit) | 30–90 s | ~$0.01–0.05 |
| `code-reviewer-codex` | o4-mini | 10–40 s | ~$0.005–0.02 |
| `test-reviewer-codex` | o4-mini | 10–40 s | ~$0.005–0.02 |
| `security-reviewer` (Claude) | Opus 4 (inherit) | 60–180 s | ~$0.05–0.20 |

> **Note:** These are operator estimates based on typical PR sizes (200–800 LOC diff). Actual costs depend on diff size, context length, and API pricing at time of use. Codex `o4-mini` is generally faster and cheaper than Sonnet for review-only workloads because it does not need to read the full codebase — the diff + task spec is the full context.

---

## Prerequisites — Codex CLI

### Check availability

```bash
which codex
codex --version
```

Expected output:
```
/opt/homebrew/bin/codex
codex-cli 0.128.0
```

If `which codex` returns nothing, install Codex CLI:
```bash
# macOS (Homebrew)
brew install codex-cli

# or via npm
npm install -g @openai/codex
```

### Check authentication status

```bash
codex login --check
```

If not authenticated:
```bash
codex login
```

Follow the browser OAuth flow. Credentials are stored in `~/.codex/auth.json`.

### Verify non-interactive invocation works

The Codex reviewer agents use `codex exec --dangerously-bypass-approvals-and-sandbox`. Test this:

```bash
echo "Return exactly: {\"approved\": true, \"findings\": [], \"summary\": \"test\"}" \
  | codex exec --model o4-mini --dangerously-bypass-approvals-and-sandbox -o /tmp/test-out.json -
cat /tmp/test-out.json
```

Expected: a JSON object with `approved`, `findings`, `summary` fields.

If the output is wrapped in markdown fences (`` ```json ... ``` ``), the Codex agent body's parse logic handles this automatically — it strips the fence before returning.

---

## Invocation Pattern (Reference)

The Codex reviewer agents shell out to `codex exec` with this pattern:

```bash
codex exec \
  --model o4-mini \
  -o "$OUTPUT_FILE" \
  --dangerously-bypass-approvals-and-sandbox \
  "$(cat "$PROMPT_FILE")"
```

Where `$PROMPT_FILE` contains the review guidelines + the diff/task context passed to the agent.

**Why `--dangerously-bypass-approvals-and-sandbox`?**
The reviewer agents are read-only — they do not execute any shell commands, they only read context (the diff) and return a JSON verdict. The sandbox bypass is required for non-interactive `codex exec` use; the risk surface is zero because the agent has no write tools (`Edit`, `Write` are in `disallowedTools`).

**Why `-o "$OUTPUT_FILE"` instead of parsing JSONL?**
`codex exec --json` emits a stream of JSONL events. Parsing the last `assistant` message from a JSONL stream is fragile (requires handling partial writes, event ordering, etc.). The `-o` flag captures only the final assistant turn as a plain file, which is simpler to parse and less error-prone.

---

## Troubleshooting

### Codex reviewer returns `{ "approved": false, "findings": [{ "severity": "critical", ... }] }` about CLI being unavailable

Codex is not on PATH. Run `which codex` and ensure the binary is in your shell's PATH. If you installed via Homebrew, add `/opt/homebrew/bin` to `PATH`.

### Codex reviewer exits non-zero

Run `codex login --check` to verify authentication. If expired, run `codex login` to re-authenticate.

### Codex output is not parseable JSON

Some prompts cause Codex to wrap its response in prose. The agent body's parse logic handles markdown fences (`\`\`\`json ... \`\`\``). If neither the raw output nor the fenced extraction produces valid JSON, the agent returns a `major` finding describing the raw output (first 500 chars) so the operator can diagnose the prompt format.

If this happens repeatedly, check the `$PROMPT_FILE` content — the system prompt in the agent body explicitly instructs Codex to return raw JSON (no fences), but `o4-mini` occasionally wraps anyway.

### Verdict aggregation attributes the wrong harness

Step 8's `coerceReviewerVerdict` and `normalizeReviewerVerdict` stamp `harness: 'codex'` on the verdict when the agent does not include it. If you see `harness: undefined` in aggregated verdicts, ensure the Codex agent is calling `codex exec` (not a fallback path that returns a Claude-generated verdict without the harness tag).

---

## Related Documentation

- `ai-sdlc-plugin/README.md` — plugin agent listing
- `ai-sdlc-plugin/agents/code-reviewer-codex.md` — Codex code reviewer body
- `ai-sdlc-plugin/agents/test-reviewer-codex.md` — Codex test reviewer body
- `pipeline-cli/src/runtime/spawners/codex-harness.ts` — `CodexHarnessAdapter` for programmatic dispatch
- `pipeline-cli/README.md` — `--spawner codex` flag documentation
- `docs/operations/adapter-authoring.md` — how to add a new harness adapter
