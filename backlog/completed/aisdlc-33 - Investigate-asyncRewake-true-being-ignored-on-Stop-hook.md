---
id: AISDLC-33
title: 'Investigate asyncRewake: true being ignored on Stop hook'
status: Done
assignee: []
created_date: '2026-04-22 03:19'
updated_date: '2026-04-23 21:24'
labels:
  - plugin
  - hooks
  - investigation
dependencies: []
references:
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/hooks/deferred-coverage-check.sh
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
plugin.json marks the deferred-coverage-check with asyncRewake: true, meaning it should run asynchronously after the agent stops and only wake the model if it fails. However, it blocked Stop synchronously three times in one user session.

Investigate whether:
1. The Claude Code harness is honoring the asyncRewake flag
2. The script's exit code 2 is overriding the async behavior
3. There's a race condition between the Stop hook completing and the asyncRewake firing

This may require testing against the Claude Code hook runtime to confirm behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root cause identified for synchronous blocking despite asyncRewake: true
- [x] #2 Fix applied or documented workaround
- [x] #3 Coverage check does not block Stop synchronously
<!-- AC:END -->
