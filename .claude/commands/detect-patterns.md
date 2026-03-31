---
name: detect-patterns
description: Analyze tool call history to detect repetitive workflow patterns and propose automations
argument-hint: [--since YYYY-MM-DD] [--min-confidence 0.6]
---

Detect repetitive workflow patterns from Claude Code session history and propose automations.

## Steps

1. **Read telemetry data** from `~/.claude/usage-data/tool-sequences.jsonl`
2. **Also read** session metadata from `~/.claude/usage-data/session-meta/*.json` for historical data
3. **Run pattern detection** using the orchestrator's n-gram mining engine:
   ```typescript
   import { readToolSequenceJSONL, mineFrequentPatterns, classifyPattern } from '@ai-sdlc/orchestrator';
   ```
4. **Classify each pattern** as command-sequence, copy-paste-cycle, or periodic-task
5. **Generate proposals** for each detected pattern with draft artifact content
6. **Present results** as a table:
   | # | Pattern | Type | Confidence | Frequency | Sessions | Proposed Artifact |
7. **For each proposal**, show the draft artifact content and ask if the user wants to approve it
8. **If approved**, write the artifact file using the artifact writer

## Arguments

- `--since YYYY-MM-DD` — only analyze events after this date
- `--min-confidence 0.6` — minimum confidence threshold (0-1)

## Important

- Only create artifacts the user explicitly approves
- Never overwrite existing files
- Show the full draft content before writing
