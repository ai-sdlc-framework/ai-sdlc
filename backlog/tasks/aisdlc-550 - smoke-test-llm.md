---
id: aisdlc-550
title: "verify: LLM model resolution and response format"
status: To Do
assignee: []
labels: [smoke-test, infrastructure]
priority: high
dependencies: []
references: []
---

## Description

This is a technical smoke-test task used to verify that the AI-SDLC orchestrator is correctly resolving the configured LLM model (e.g., `gemma` via Ollama) and that the response bridge is functioning without interference.

The agent must demonstrate it can follow a rigid, low-entropy constraint which serves as a signal for successful model resolution.

## Acceptance Criteria

- [ ] #1 The agent responds to this task ONLY with the following JSON object:
  ```json
  {"status": "resolved", "model_verified": true}
  ```
- [ ] #2 No other text, explanation, or markdown formatting is included in the response.