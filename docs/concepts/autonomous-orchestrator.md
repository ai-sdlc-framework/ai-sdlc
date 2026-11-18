---
title: "Autonomous orchestrator (retired)"
description: "The RFC-0015 tick loop is retired; autonomous dispatch now runs through the session hierarchy."
---

The RFC-0015 autonomous orchestrator, a tick loop started with `cli-orchestrator`, is retired as the way to run autonomously (AISDLC-763). The `/ai-sdlc orchestrator-tick` loop and the `cli-orchestrator` cron and daemon path are replaced by `cli-hierarchy up`.

- Run autonomous dispatch with the [session hierarchy](./session-hierarchy.md) and the [`cli-hierarchy` runbook](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/cli-hierarchy.md).
- For a single task, run `/ai-sdlc execute <task-id>`.
- The binary `pipeline-cli/bin/cli-orchestrator.mjs` still ships, but not as an autonomous loop.
- Original design: [RFC-0015](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md).
