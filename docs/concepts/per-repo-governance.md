---
title: "Per-Repo Configurable Governance"
description: "How a repository declares its own hard rules for agents instead of relying on constants in the plugin."
---

The hard rules an agent is told at the start of every session ("never merge a PR", "never edit workflow files") used to be string constants inside the framework. A repository with a good reason to relax one of them could not, short of patching the framework. RFC-0048 moves those rules into the repository's own policy file and renders the injected text from it.

> **RFC:** [RFC-0048 — Per-Repo Configurable Governance](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0048-per-repo-configurable-governance.md) · **Status:** Implemented · **Config surface:** the governance section of `.ai-sdlc/agent-role.yaml`

## The case that forced it

An adopter decided that an agent may merge a pull request once every CI check is green and the merge state is clean. Every real hazard for that repository was already a CI check: attestation verification, a migration-mutation gate, a workflow-secret-scope gate, the test suite. Green plus clean already covered the risk. Yet the framework kept injecting "NEVER merge PRs. Only humans merge." into every session, and the execute command refused outright.

Worse, the two sources of truth could already disagree. The policy file might block a local `git merge` while the injected prose forbade the remote PR merge command, and nothing reconciled them.

## What changed

- The canonical hard rules now live in a governance section of `agent-role.yaml`, each with its per-repo setting.
- The repository's policy is resolved against strict defaults into a single policy object. Session-start hooks, subagent-start hooks and the execute commands all render their rule text from that object. There is one source.
- The enforcement hook that blocks commands was reconciled with the narration. Under the strict default it now actually blocks a PR merge instead of only saying it does.
- Defaults are unchanged. An adopter who does nothing gets exactly the behavior they had. Relaxing a rule is one declaration, and the resolved policy is what the audit log records.

## Why defaults stay strict

The framework is prescriptive by design. The point of this RFC is not to make agents merge code. It is to stop the framework from asserting something a repository's operator has deliberately decided against, and to make sure what the agent is told and what the agent is prevented from doing are the same thing.

## What this unlocks

- Platform teams can encode their own merge policy per repository and have the agents follow it without forking the framework.
- Compliance reviewers can read one policy object per repository instead of comparing prose to hook code.
- The strict profile remains the shipped default for anyone who wants the framework's opinion rather than their own.

## Where to go next

- [Definition-of-Ready gate](./dor-gate.md) is the other place where a repository shapes the framework's behavior declaratively.
- The [operator runbook](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/operator-runbook.md) covers the governance section's fields.
