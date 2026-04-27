# Tutorial 7: Workflow Pattern Detection

The AI-SDLC orchestrator can observe how developers interact with AI agents
across sessions, detect repetitive multi-step workflows, and propose
deterministic automations to eliminate the toil.

**Key principle:** The LLM observes and proposes, but the output is
deterministic code -- no AI in the runtime loop.

---

## Prerequisites

- A running AI-SDLC environment with `@ai-sdlc/orchestrator` installed
- Claude Code with the PostToolUse telemetry hook configured
- At least 3 coding sessions worth of telemetry data

---

## How It Works

```
Sessions → Telemetry → N-Gram Mining → Classification → Proposals → Artifacts
```

1. **Telemetry Collection** -- A PostToolUse hook captures every tool call to
   `~/.claude/usage-data/tool-sequences.jsonl` in real-time.

2. **N-Gram Mining** -- The detector generates contiguous n-grams (n=3 to 8)
   from session sequences, counts frequency across sessions, and removes
   subsumed patterns.

3. **Classification** -- Each pattern is classified into one of three types
   based on its signature.

4. **Proposal Generation** -- Templates generate draft automations matching
   your project's existing conventions.

5. **Artifact Writing** -- Approved proposals are written to disk, never
   overwriting existing files.

---

## Step 1: Install the Telemetry Hook

The PostToolUse hook captures tool calls as they happen. Add this to your
`.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash .claude/hooks/collect-tool-sequence.sh"
          }
        ]
      }
    ]
  }
}
```

The hook writes JSONL entries like:

```json
{"ts":"2026-03-27T10:00:00Z","sid":"abc123","tool":"Bash","action":"pnpm test","project":"/path/to/repo"}
{"ts":"2026-03-27T10:00:05Z","sid":"abc123","tool":"Edit","action":".ts","project":"/path/to/repo"}
{"ts":"2026-03-27T10:00:10Z","sid":"abc123","tool":"Bash","action":"pnpm lint","project":"/path/to/repo"}
```

### Action Canonicalization

Raw tool calls are canonicalized for pattern matching:

| Tool | Canonicalization | Example |
|---|---|---|
| Bash | First meaningful command tokens | `pnpm test`, `git commit`, `gh pr create` |
| Read/Edit/Write | File extension | `.ts`, `.yaml`, `.md` |
| Grep/Glob | Pattern type | `pattern`, `glob` |

---

## Step 2: Collect Telemetry

Run a few coding sessions normally. The hook silently records every tool call.
After 3+ sessions, you'll have enough data for pattern detection.

Check your telemetry file:

```bash
wc -l ~/.claude/usage-data/tool-sequences.jsonl
# 847 lines — plenty of data

# Preview the last few entries
tail -5 ~/.claude/usage-data/tool-sequences.jsonl | jq .
```

---

## Step 3: Run Pattern Detection

Use the CLI or slash command to detect patterns:

```bash
# CLI
ai-sdlc detect-patterns --min-confidence 0.6

# Or from Claude Code
/detect-patterns
```

The detector will:
1. Group events by session into ordered sequences
2. Generate contiguous n-grams (n=3 to 8)
3. Count frequency across sessions (minimum 3 sessions, 3 occurrences)
4. Compute confidence: `sessionCount / totalSessions * frequency / maxFrequency`
5. Remove subsumed patterns (a 3-gram inside a 5-gram with similar frequency)

---

## Step 4: Review Detected Patterns

```bash
ai-sdlc list-patterns --status pending
```

Example output:

```
ID       Type              Steps  Sessions  Confidence  Name
───────  ────────────────  ─────  ────────  ──────────  ─────────────────────
pat-01   command-sequence  5      7/10      0.84        auto-test-and-commit
pat-02   copy-paste-cycle  4      4/10      0.62        auto-scaffold-component
pat-03   periodic-task     3      5/10      0.71        auto-weekly-deps-update
```

### Pattern Types

| Type | Signature | Output Artifact |
|---|---|---|
| **Command Sequence** | 3+ step tool chain repeated across 3+ sessions | `.claude/commands/<name>.md` |
| **Copy-Paste Cycle** | Read then Write/Edit on different files with similar extensions | `.claude/skills/<name>/SKILL.md` |
| **Periodic Task** | Same sequence at regular time intervals (7+ day span) | `.github/workflows/<name>.yml` |

---

## Step 5: Approve and Generate Artifacts

Review a pattern, then approve it to generate the automation:

```bash
# Preview what would be generated
ai-sdlc approve-pattern pat-01 --dry-run

# Generate the artifact
ai-sdlc approve-pattern pat-01
```

### Example: Command Sequence → Claude Code Command

If the detector finds you repeatedly run `pnpm test → read failures → edit code
→ pnpm test → git commit`, it generates:

```markdown
<!-- .claude/commands/auto-test-and-commit.md -->
Run the test suite, fix any failures, and commit when green.

1. Run `pnpm test` and capture the output
2. If tests fail, read the failure output and fix the failing code
3. Re-run `pnpm test` until all tests pass
4. Run `pnpm lint` and fix any lint errors
5. Commit with a descriptive message
```

### Example: Copy-Paste Cycle → Claude Code Skill

If you frequently read a component file, then create a test file with similar
structure:

```markdown
<!-- .claude/skills/auto-scaffold-component/SKILL.md -->
---
name: auto-scaffold-component
description: Scaffold a new component with co-located test file
---

When asked to create a new component:
1. Read an existing component for the naming and structure pattern
2. Create the new component file following the same conventions
3. Create a co-located `.test.ts` file with standard test boilerplate
4. Export the component from the nearest barrel file
```

### Example: Periodic Task → GitHub Actions Workflow

If you run dependency updates every Monday:

```yaml
# .github/workflows/auto-weekly-deps-update.yml
name: Weekly Dependency Update
on:
  schedule:
    - cron: '0 9 * * 1'  # Monday 9am UTC
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm update --latest
      - run: pnpm test
      - uses: peter-evans/create-pull-request@v6
        with:
          title: 'chore: weekly dependency update'
```

---

## Step 6: Programmatic API

You can also use the detection engine programmatically:

```typescript
import {
  readToolSequenceJSONL,
  mineFrequentPatterns,
  classifyPattern,
  generateProposal,
  writeArtifact,
} from '@ai-sdlc/orchestrator';

// 1. Ingest telemetry
const events = await readToolSequenceJSONL(
  '~/.claude/usage-data/tool-sequences.jsonl'
);

// 2. Mine patterns
const patterns = mineFrequentPatterns(events, {
  minN: 3,
  maxN: 8,
  minFrequency: 3,
  minSessions: 3,
  minConfidence: 0.6,
});

// 3. Classify and generate proposals
for (const pattern of patterns) {
  const classified = classifyPattern(pattern);
  const proposal = generateProposal(classified, {
    projectRoot: process.cwd(),
  });

  console.log(`${proposal.name}: ${proposal.artifactType}`);
  console.log(proposal.draftContent);
}
```

---

## Configuration

Detection parameters can be tuned in your pipeline configuration:

```yaml
# .ai-sdlc/pipeline.yaml
spec:
  workflowPatterns:
    minN: 3              # Minimum n-gram length
    maxN: 8              # Maximum n-gram length
    minFrequency: 3      # Minimum occurrences
    minSessions: 3       # Minimum distinct sessions
    minConfidence: 0.6   # Confidence threshold (0-1)
```

---

## State Store

Detected patterns and proposals are persisted in the orchestrator's state store
(SQLite). Three tables track the lifecycle:

- **`tool_sequence_events`** -- Raw tool calls indexed by session
- **`workflow_patterns`** -- Detected patterns with frequency, confidence, and status
- **`pattern_proposals`** -- Generated automation proposals with draft content

---

## Summary

In this tutorial you:

1. Installed the **PostToolUse telemetry hook** to capture tool calls in real-time.
2. Ran **pattern detection** using n-gram mining across multiple sessions.
3. Reviewed **detected patterns** classified as command sequences, copy-paste cycles, or periodic tasks.
4. **Approved patterns** to generate deterministic automation artifacts.
5. Explored the **programmatic API** for custom detection pipelines.

The workflow pattern detection system closes the loop: humans work with AI agents,
the orchestrator observes what's repetitive, and proposes deterministic automations
that eliminate the toil -- without putting AI in the runtime path.

---

## Next Steps

- **[Action Governance](/docs/api-reference/governance)** -- How `blockedActions` and enforcement hooks keep agents safe.
- **[Multi-Agent Orchestration](/docs/tutorials/05-multi-agent-orchestration)** -- Wire multiple agents into a pipeline.
- **[Telemetry Reference](/docs/api-reference/telemetry)** -- OpenTelemetry instrumentation for distributed tracing.
